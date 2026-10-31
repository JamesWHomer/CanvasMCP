import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CanvasClient } from "../canvas.js";
import { compact } from "../format.js";

// Canvas responses are large, loosely-typed objects; the mappers pick out the useful fields.
export type Obj = Record<string, any>;

export interface ToolContext {
  server: McpServer;
  canvas: () => CanvasClient;
  /** Only the local stdio server may read files from the user's disk (e.g. to upload a submission). */
  allowLocalFiles: boolean;
  /** Runs a tool body and turns its result or error into MCP output (see makeRunner). */
  run: (fn: () => Promise<unknown>) => Promise<CallToolResult>;
}

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
export const DAY_MS = 86_400_000;

// IDs are coerced so the tools accept both "123" and 123.
export const courseId = z.coerce.string().describe("Canvas course ID (from list_courses)");

/** Lets a tool return MCP content directly (e.g. an image) instead of JSON text. */
export class RawResult {
  constructor(readonly result: CallToolResult) {}
}

/** Runs tool bodies: errors become tool errors, and UTC timestamps in results are shown in the user's time zone. */
export function makeRunner(canvas: () => CanvasClient): ToolContext["run"] {
  return async (fn) => {
    // Looked up alongside the tool itself; cached after the first call.
    let timeZone: Promise<string | undefined>;
    try {
      timeZone = userTimeZone(canvas());
    } catch {
      timeZone = Promise.resolve(undefined);
    }
    try {
      const data = await fn();
      if (data instanceof RawResult) return data.result;
      return { content: [{ type: "text", text: JSON.stringify(localizeTimes(data, await timeZone), null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  };
}

export function submissionSummary(s: Obj | undefined) {
  if (!s) return undefined;
  return compact({
    state: s.workflow_state,
    submitted_at: s.submitted_at,
    score: s.score,
    grade: s.grade,
    attempt: s.attempt,
    late: s.late || undefined,
    missing: s.missing || undefined,
    excused: s.excused || undefined,
  });
}

/** A submission's files, with the upload status that shows whether Canvas finished receiving them. */
export function attachmentList(s: Obj | undefined) {
  return s?.attachments?.map((f: Obj) =>
    compact({ file_id: f.id, name: f.display_name, size: f.size, type: f["content-type"], upload_status: f.upload_status }),
  );
}

/** The user's group for a group assignment, if it is one and they're in a group for it. */
export async function assignmentGroup(c: CanvasClient, a: Obj): Promise<Obj | undefined> {
  if (!a.group_category_id) return undefined;
  const groups = await c.getAll<Obj>("users/self/groups").catch(() => [] as Obj[]);
  return groups.find((g) => String(g.group_category_id) === String(a.group_category_id));
}

/** What a group assignment means for the user's submission; undefined for individual assignments. */
export function groupInfo(a: Obj, group: Obj | undefined) {
  if (!a.group_category_id) return undefined;
  if (!group) return { note: "Group assignment, but the user isn't in a group for it, so Canvas treats their submission as individual." };
  return compact({
    name: group.name?.trim(),
    id: group.id,
    note: "One submission for the whole group: a teammate's submission shows as the user's own, and submitting again replaces it for everyone.",
    graded_individually: a.grade_group_students_individually || undefined,
  });
}

/** Who uploaded a group submission's files: "you" or the teammate's name. Best effort; undefined if unknown. */
export async function uploadedBy(c: CanvasClient, s: Obj | undefined): Promise<string | undefined> {
  const first = s?.attachments?.[0];
  if (!first) return undefined;
  const f = await c.get<Obj>(`files/${first.id}`, { include: ["user"] }).catch(() => undefined);
  if (!f?.user) return undefined;
  return String(f.user.id) === String(s!.user_id) ? "you" : f.user.display_name;
}

export async function activeCourseIds(c: CanvasClient): Promise<string[]> {
  const courses = await c.getAll<Obj>("courses", { enrollment_state: "active" });
  return courses.filter((x) => !x.access_restricted_by_date).map((x) => String(x.id));
}

const timeZones = new WeakMap<CanvasClient, Promise<string | undefined>>();

/** The user's Canvas time zone, fetched once per client (a failed lookup is retried next time). */
export function userTimeZone(c: CanvasClient): Promise<string | undefined> {
  let tz = timeZones.get(c);
  if (!tz) {
    tz = c.get<Obj>("users/self/profile").then(
      (p) => (isTimeZone(p.time_zone) ? p.time_zone : undefined),
      () => {
        timeZones.delete(c);
        return undefined;
      },
    );
    timeZones.set(c, tz);
  }
  return tz;
}

function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const localFormats = new Map<string, Intl.DateTimeFormat>();

/** The same instant as local wall time with its UTC offset: 2026-11-02T03:59:00Z in Sydney is 2026-11-02T14:59:00+11:00. */
export function localTimestamp(iso: string, timeZone: string): string {
  let format = localFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    });
    localFormats.set(timeZone, format);
  }
  const p = Object.fromEntries(format.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  // longOffset is "GMT+11:00", or plain "GMT" at UTC.
  const offset = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName.slice(3);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

/** Rewrites every UTC timestamp in a tool result into the user's time zone, so nobody converts them by hand. */
export function localizeTimes(value: unknown, timeZone: string | undefined): unknown {
  if (!timeZone) return value;
  if (typeof value === "string") return UTC_TIMESTAMP.test(value) ? localTimestamp(value, timeZone) : value;
  if (Array.isArray(value)) return value.map((v) => localizeTimes(v, timeZone));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localizeTimes(v, timeZone)]));
  }
  return value;
}

/** The instant local midnight began, in the given IANA time zone (server-local when unknown). */
export function startOfDayIn(timeZone: string | undefined, at = new Date()): Date {
  if (!timeZone) {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const sinceMidnight = ((part("hour") * 60 + part("minute")) * 60 + part("second")) * 1000 + at.getMilliseconds();
  return new Date(at.getTime() - sinceMidnight);
}

/**
 * Resolves a date range in the user's time zone. A bare date like "2026-11-03" means that whole local day,
 * so an end_date of Friday includes Friday. Defaults to the start of today plus `defaultDays`.
 */
export async function resolveRange(
  c: CanvasClient,
  startDate: string | undefined,
  endDate: string | undefined,
  defaultDays: number,
): Promise<{ start: Date; end: Date }> {
  const tz = await userTimeZone(c);
  const parse = (value: string, label: string, endOfDay: boolean): Date => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      // Noon UTC falls on the same calendar day in every zone within ±12h.
      const midnight = startOfDayIn(tz, new Date(`${value}T12:00:00Z`));
      return endOfDay ? startOfDayIn(tz, new Date(midnight.getTime() + 36 * 3_600_000)) : midnight;
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid ${label}: ${value}`);
    return d;
  };
  const start = startDate ? parse(startDate, "start_date", false) : startOfDayIn(tz);
  const end = endDate ? parse(endDate, "end_date", true) : new Date(start.getTime() + defaultDays * DAY_MS);
  if (end <= start) throw new Error("end_date must be after start_date");
  return { start, end };
}
