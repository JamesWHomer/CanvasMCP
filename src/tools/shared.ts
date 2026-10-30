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
}

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
export const DAY_MS = 86_400_000;

// IDs are coerced so the tools accept both "123" and 123.
export const courseId = z.coerce.string().describe("Canvas course ID (from list_courses)");

/** Lets a tool return MCP content directly (e.g. an image) instead of JSON text. */
export class RawResult {
  constructor(readonly result: CallToolResult) {}
}

export async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn();
    if (data instanceof RawResult) return data.result;
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
  }
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

export async function activeCourseIds(c: CanvasClient): Promise<string[]> {
  const courses = await c.getAll<Obj>("courses", { enrollment_state: "active" });
  return courses.filter((x) => !x.access_restricted_by_date).map((x) => String(x.id));
}

const timeZones = new WeakMap<CanvasClient, Promise<string | undefined>>();

/** The user's Canvas time zone, fetched once per client. */
export function userTimeZone(c: CanvasClient): Promise<string | undefined> {
  let tz = timeZones.get(c);
  if (!tz) {
    tz = c.get<Obj>("users/self/profile").then(
      (p) => p.time_zone as string | undefined,
      () => undefined,
    );
    timeZones.set(c, tz);
  }
  return tz;
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
