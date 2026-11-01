// Echo360 lecture recordings, reached through the course's Echo360 LTI tool. Canvas issues a one-time launch
// link (sessionless_launch); following it like a browser (cookies, redirects, auto-submitting LTI forms) yields an
// Echo360 session. Echo360's web-player endpoints, which are undocumented, then list the section's recordings and
// return their transcripts. The Canvas API token itself is never sent to Echo360.
import { CanvasError, type CanvasClient } from "./canvas.js";
import { followLaunch, navigationTools, sessionlessLaunch, type Browser } from "./lti.js";

type Obj = Record<string, any>;

// A fresh launch is cheap, so a session is only reused briefly rather than risking an expired one.
const SESSION_TTL_MS = 10 * 60_000;
const SECTION_PATH = /\/section\/([0-9a-f-]{36})(?:\/|$)/i;
// Tabs worth trying first when looking for the Echo360 tool.
const LIKELY_TAB = /echo|lecture|record/i;
const PARAGRAPH_MS = 60_000;

export interface Recording {
  /** Echo360's media ID. */
  recording_id: string;
  lesson_id: string;
  title: string;
  /** The folder or module the recording sits in. */
  group?: string;
  date?: string;
}

export interface Cue {
  startMs: number;
  endMs: number;
  content: string;
}

export interface Transcript {
  cues: Cue[];
  automated: boolean;
}

export type TranscriptFormat = "text" | "vtt" | "srt";

/** Finds the course's Echo360 navigation tab and gets a one-time launch link for it. */
async function findEchoTool(c: CanvasClient, courseId: string): Promise<{ name: string; url: string }> {
  const tools = (await navigationTools(c, courseId)).sort(
    (a, b) => Number(LIKELY_TAB.test(b.label)) - Number(LIKELY_TAB.test(a.label)),
  );
  for (const tool of tools) {
    const launch = await sessionlessLaunch(c, courseId, tool.toolId);
    if (launch && /echo360/i.test(launch.name)) return launch;
  }
  throw new CanvasError("This course has no Echo360 lecture recordings tool in its navigation menu.");
}

async function launch(c: CanvasClient, courseId: string): Promise<Echo360Session> {
  const tool = await findEchoTool(c, courseId);
  const { browser, page } = await followLaunch(c, tool.url, (url) => SECTION_PATH.test(url.pathname));
  const sectionId = page.url.pathname.match(SECTION_PATH)?.[1];
  if (!sectionId) {
    throw new CanvasError(
      `Opening ${tool.name} didn't reach the course's recordings (ended at ${page.url.origin}${page.url.pathname} with status ${page.res.status}). Check that Recorded Lectures opens in Canvas.`,
    );
  }
  return new Echo360Session(browser, page.url.origin, sectionId, tool.name);
}

export class Echo360Session {
  constructor(
    private readonly browser: Browser,
    readonly origin: string,
    readonly sectionId: string,
    readonly toolName: string,
  ) {}

  /** Every available recording, flattening the folders/modules Echo360 groups them into. */
  async recordings(): Promise<Recording[]> {
    const entries: Obj[] = (await this.getJson(`/section/${this.sectionId}/syllabus`)) ?? [];
    const out: Recording[] = [];
    for (const entry of entries) {
      const isGroup = entry.type === "SyllabusGroupType";
      for (const item of isGroup ? (entry.lessons ?? []) : [entry]) {
        const lesson = item.lesson?.lesson;
        if (!lesson?.id) continue;
        for (const media of item.lesson.medias ?? []) {
          if (!media.id || media.isAvailable === false) continue;
          out.push({
            recording_id: media.id,
            lesson_id: lesson.id,
            title: lesson.displayName ?? lesson.name ?? media.title ?? "Untitled",
            group: isGroup ? entry.groupInfo?.name : undefined,
            date: item.lesson.startTimeUTC ?? lesson.createdAt,
          });
        }
      }
    }
    return out;
  }

  async recording(recordingId: string): Promise<Recording> {
    const found = (await this.recordings()).find((r) => r.recording_id === recordingId);
    if (!found) throw new CanvasError(`No recording ${recordingId} in this course; list_lecture_recordings gives the IDs.`);
    return found;
  }

  async transcript(r: Recording): Promise<Transcript> {
    const data = await this.getJson(`/api/ui/echoplayer/lessons/${r.lesson_id}/medias/${r.recording_id}/transcript`);
    const cues: Cue[] = (data?.contentJSON?.cues ?? [])
      .map((c: Obj) => ({
        startMs: Number(c.startMs),
        endMs: Number(c.endMs),
        content: String(c.content ?? "").replace(/\s+/g, " ").trim(),
      }))
      .filter((c: Cue) => c.content && Number.isFinite(c.startMs) && Number.isFinite(c.endMs));
    if (!cues.length) throw new CanvasError(`"${r.title}" has no transcript in Echo360 (it may still be processing).`);
    return { cues, automated: data?.isAutomated !== false };
  }

  /** Echo360 wraps responses as { status, message, data }; a missing resource comes back as undefined. */
  private async getJson(path: string): Promise<any> {
    const { res, text } = await this.browser.open(new URL(path, this.origin), { accept: "application/json" });
    if (res.status === 404) return undefined;
    let body: Obj;
    try {
      body = JSON.parse(text);
    } catch {
      throw new CanvasError(`Echo360 returned a non-JSON response (status ${res.status}); the session may have expired.`);
    }
    if (!res.ok) throw new CanvasError(`Echo360 ${res.status}${body.message ? `: ${body.message}` : ""}`, res.status);
    return body.data;
  }
}

const sessions = new WeakMap<CanvasClient, Map<string, { expires: number; session: Promise<Echo360Session> }>>();

/** An Echo360 session for the course, launched on first use and reused for a few minutes. */
export function echo360(c: CanvasClient, courseId: string): Promise<Echo360Session> {
  let byCourse = sessions.get(c);
  if (!byCourse) sessions.set(c, (byCourse = new Map()));
  const cached = byCourse.get(courseId);
  if (cached && cached.expires > Date.now()) return cached.session;

  const session = launch(c, courseId);
  byCourse.set(courseId, { expires: Date.now() + SESSION_TTL_MS, session });
  session.catch(() => {
    if (byCourse.get(courseId)?.session === session) byCourse.delete(courseId);
  });
  return session;
}

/** "m:ss" / "h:mm:ss" for reading, or a subtitle timestamp (SRT puts a comma before the milliseconds). */
export function timestamp(ms: number, style: "short" | "vtt" | "srt" = "short"): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  if (style === "short") return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return `${pad(h)}:${pad(m)}:${pad(s)}${style === "srt" ? "," : "."}${pad(Math.floor(ms) % 1000, 3)}`;
}

export function formatTranscript(cues: Cue[], format: TranscriptFormat): string {
  if (format === "vtt") {
    const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const blocks = cues.map((c) => `${timestamp(c.startMs, "vtt")} --> ${timestamp(c.endMs, "vtt")}\n${escape(c.content)}`);
    return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
  }
  if (format === "srt") {
    const blocks = cues.map((c, i) => `${i + 1}\n${timestamp(c.startMs, "srt")} --> ${timestamp(c.endMs, "srt")}\n${c.content}`);
    return `${blocks.join("\n\n")}\n`;
  }
  // Plain text: a new timestamped paragraph about once a minute, at the end of a sentence where possible.
  const paragraphs: { start: number; lines: string[] }[] = [];
  for (const cue of cues) {
    const p = paragraphs.at(-1);
    const elapsed = p ? cue.startMs - p.start : Infinity;
    const sentenceEnded = /[.?!]["')\]]?$/.test(p?.lines.at(-1) ?? "");
    if (!p || elapsed >= 2 * PARAGRAPH_MS || (elapsed >= PARAGRAPH_MS && sentenceEnded)) {
      paragraphs.push({ start: cue.startMs, lines: [cue.content] });
    } else {
      p.lines.push(cue.content);
    }
  }
  return paragraphs.map((p) => `[${timestamp(p.start)}] ${p.lines.join(" ")}`).join("\n\n");
}
