// Lecture recordings and their transcripts (subtitles), from the course's Echo360 tool.
// download_lecture_transcripts (local server only): save transcripts as subtitle or text files.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { echo360, formatTranscript, timestamp, type Recording } from "../echo360.js";
import { compact } from "../format.js";
import { defaultDownloadDir, freePath, mapLimit, safeFileName } from "./files.js";
import { READ_ONLY, courseId, type Obj, type ToolContext } from "./shared.js";

const DEFAULT_CHARS = 40_000;
const PARALLEL_DOWNLOADS = 4;
const EXTENSIONS = { text: "txt", vtt: "vtt", srt: "srt" } as const;
const AUTOMATED_NOTE = "Automatic speech-recognition transcript: names and technical terms may be misheard.";

export function registerLectureTools({ server, canvas, allowLocalFiles, run }: ToolContext): void {
  server.registerTool(
    "list_lecture_recordings",
    {
      title: "List lecture recordings",
      description:
        "List a course's recorded lectures and other videos from its Echo360 tool (usually the \"Recorded Lectures\" tab), with the recording_id get_lecture_transcript needs. group is the folder or module a video sits in; date is when it was recorded or uploaded.",
      inputSchema: { course_id: courseId },
      annotations: READ_ONLY,
    },
    async ({ course_id }) =>
      run(async () => {
        const session = await echo360(canvas(), course_id);
        const recordings = await session.recordings();
        return {
          source: session.toolName,
          count: recordings.length,
          recordings: recordings.map((r) => compact({ recording_id: r.recording_id, title: r.title, group: r.group, date: r.date })),
        };
      }),
  );

  server.registerTool(
    "get_lecture_transcript",
    {
      title: "Get a lecture's transcript",
      description:
        'Get the transcript of a recorded lecture: what was said, as plain text with a [m:ss] timestamp about once a minute (format "text", the default; best for reading, summarising or answering questions about a lecture), or as subtitles ("vtt" or "srt"). Get recording IDs from list_lecture_recordings. Transcripts are Echo360\'s automatic speech recognition, so names and technical terms can be misheard. Long transcripts are paged: call again with next_offset to continue.',
      inputSchema: {
        course_id: courseId,
        recording_id: z.string().describe("Recording ID from list_lecture_recordings"),
        format: z.enum(["text", "vtt", "srt"]).optional().describe('"text" (default), "vtt" or "srt"'),
        offset: z.number().int().min(0).optional().describe("Character offset to start from (default 0)"),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(100_000)
          .optional()
          .describe(`Maximum characters to return (default ${DEFAULT_CHARS})`),
      },
      annotations: READ_ONLY,
    },
    async ({ course_id, recording_id, format = "text", offset = 0, max_chars = DEFAULT_CHARS }) =>
      run(async () => {
        const session = await echo360(canvas(), course_id);
        const recording = await session.recording(recording_id);
        const transcript = await session.transcript(recording);
        const full = formatTranscript(transcript.cues, format);
        const text = full.slice(offset, offset + max_chars);
        const end = offset + text.length;
        return compact({
          recording_id,
          title: recording.title,
          date: recording.date,
          duration: timestamp(Math.max(...transcript.cues.map((c) => c.endMs))),
          note: transcript.automated ? AUTOMATED_NOTE : undefined,
          format,
          total_chars: full.length,
          offset: offset || undefined,
          next_offset: end < full.length ? end : undefined,
          text: text || (offset >= full.length ? "[offset is past the end of the transcript]" : text),
        });
      }),
  );

  // The remote server has no access to the user's disk.
  if (!allowLocalFiles) return;

  server.registerTool(
    "download_lecture_transcripts",
    {
      title: "Download lecture transcripts to this computer",
      description: `Save lecture transcripts to the user's computer as subtitle files (.srt by default, or .vtt) or plain text (.txt), for chosen recordings or every recording in a course. Files are named after the recording and go to a "<course name> transcripts" folder in ${defaultDownloadDir()} unless a directory is given; a relative directory is created inside that folder. Existing files are never overwritten. Recordings without a transcript are reported and skipped. Returns each saved path.`,
      inputSchema: {
        course_id: courseId,
        recording_ids: z
          .array(z.string())
          .min(1)
          .max(200)
          .optional()
          .describe("Recording IDs from list_lecture_recordings (default: every recording in the course)"),
        format: z.enum(["srt", "vtt", "text"]).optional().describe('"srt" (default), "vtt" or "text"'),
        directory: z
          .string()
          .optional()
          .describe(`Folder to save into: an absolute path, or a subfolder of ${defaultDownloadDir()}`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ course_id, recording_ids, format = "srt", directory }) =>
      run(async () => {
        const c = canvas();
        const session = await echo360(c, course_id);
        const all = await session.recordings();
        const wanted: (Recording | string)[] = recording_ids
          ? recording_ids.map((id) => all.find((r) => r.recording_id === id) ?? id)
          : all;
        const course = await c.get<Obj>(`courses/${course_id}`);
        const dir = resolve(defaultDownloadDir(), directory ?? `${safeFileName(course.name ?? `course ${course_id}`)} transcripts`);
        await mkdir(dir, { recursive: true });

        // Names are claimed up front, in order, so parallel downloads never pick the same path.
        const claimed = new Set<string>();
        const plan = wanted.map((r) =>
          typeof r === "string" ? r : { r, path: freePath(dir, `${safeFileName(r.title)}.${EXTENSIONS[format]}`, claimed) },
        );
        const results = await mapLimit(plan, PARALLEL_DOWNLOADS, async (item) => {
          if (typeof item === "string") return { recording_id: item, error: "not found in this course" };
          const { r, path } = item;
          try {
            const transcript = await session.transcript(r);
            await writeFile(path, formatTranscript(transcript.cues, format), { flag: "wx" });
            return { recording_id: r.recording_id, title: r.title, path };
          } catch (err) {
            return { recording_id: r.recording_id, title: r.title, error: err instanceof Error ? err.message : String(err) };
          }
        });
        return {
          directory: dir,
          saved: results.filter((r) => "path" in r).length,
          failed: results.filter((r) => "error" in r).length,
          note: AUTOMATED_NOTE,
          files: results,
        };
      }),
  );
}
