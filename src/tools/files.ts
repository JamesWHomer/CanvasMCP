// read_file: download a Canvas file and return its text (PDF, Office, notebooks, code) or the image itself.
// download_files (local server only): save original files to the user's computer.
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { z } from "zod";
import { CanvasError, tooLarge } from "../canvas.js";
import { extractFile } from "../extract.js";
import { compact } from "../format.js";
import { READ_ONLY, RawResult, run, type Obj, type ToolContext } from "./shared.js";

const MAX_DOWNLOAD_BYTES = 40_000_000;
const DEFAULT_CHARS = 40_000;
const MAX_SAVE_BYTES = 2_000_000_000;
const SAVE_TIMEOUT_MS = 15 * 60_000;
const PARALLEL_DOWNLOADS = 4;

function defaultDownloadDir(): string {
  return process.env.CANVAS_DOWNLOAD_DIR?.trim() || join(homedir(), "Downloads", "Canvas");
}

/** Canvas display names can contain characters that aren't valid (or safe) in a file name. */
function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/, "")
    .trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "download";
}

/** First "name.ext", "name (1).ext", ... that is neither on disk nor already claimed in this batch. */
function freePath(dir: string, name: string, claimed: Set<string>): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; ; n++) {
    const candidate = join(dir, n ? `${stem} (${n})${ext}` : name);
    const key = candidate.toLowerCase();
    if (!claimed.has(key) && !existsSync(candidate) && !existsSync(`${candidate}.part`)) {
      claimed.add(key);
      return candidate;
    }
  }
}

/** Streams a response body to disk via a .part file, so an interrupted download never looks complete. */
async function saveResponse(res: Response, path: string): Promise<number> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_SAVE_BYTES) throw new CanvasError(tooLarge(declared, MAX_SAVE_BYTES));
  if (!res.body) throw new CanvasError("Download returned no content");
  const part = `${path}.part`;
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > MAX_SAVE_BYTES ? new CanvasError(tooLarge(size, MAX_SAVE_BYTES)) : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>), limit, createWriteStream(part));
    await rename(part, path);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
  return size;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function registerFileTools({ server, canvas, allowLocalFiles }: ToolContext): void {
  server.registerTool(
    "read_file",
    {
      title: "Read a file's contents",
      description:
        "Download a Canvas file and return its contents: text from PDFs (page by page), Word .docx, PowerPoint .pptx (slides and speaker notes), Excel .xlsx, Jupyter notebooks, HTML and plain-text/code files; images are returned for viewing. Long files are paged: call again with next_offset to continue. Works for any file ID, e.g. from list_files, a File module item's content_id, an assignment description link (/files/<id>), or a message attachment.",
      inputSchema: {
        file_id: z.coerce.string().describe("File ID"),
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
    async ({ file_id, offset = 0, max_chars = DEFAULT_CHARS }) =>
      run(async () => {
        const c = canvas();
        const f = await c.get<Obj>(`files/${file_id}`);
        const name: string = f.display_name ?? f.filename ?? `file-${file_id}`;
        const meta = compact({ id: f.id, name, type: f["content-type"], size: f.size, updated_at: f.updated_at });
        if (!f.url) {
          throw new Error(`"${name}" can't be downloaded: ${f.lock_explanation ?? "it is locked or hidden from you"}`);
        }
        if (f.size > MAX_DOWNLOAD_BYTES) {
          return { ...meta, note: "File is too large to read here; open the download link instead.", download_url: f.url };
        }

        const { bytes, contentType } = await c.download(f.url, MAX_DOWNLOAD_BYTES);
        const extracted = await extractFile(bytes, name, f["content-type"] ?? contentType);

        if (extracted.kind === "image") {
          return new RawResult({
            content: [
              { type: "text", text: JSON.stringify(meta, null, 2) },
              { type: "image", data: extracted.base64, mimeType: extracted.mimeType },
            ],
          });
        }
        if (extracted.kind === "unsupported") return { ...meta, note: extracted.reason, download_url: f.url };

        const full = extracted.sections
          .map((s) => (s.label ? `--- ${s.label} ---\n${s.text}` : s.text))
          .join("\n\n");
        const text = full.slice(offset, offset + max_chars);
        const end = offset + text.length;
        return compact({
          ...meta,
          format: extracted.format,
          sections: extracted.sections.length > 1 ? extracted.sections.length : undefined,
          note: extracted.note,
          total_chars: full.length,
          offset: offset || undefined,
          next_offset: end < full.length ? end : undefined,
          text: text || (offset >= full.length && full.length ? "[offset is past the end of the file]" : text),
        });
      }),
  );

  // The remote server has no access to the user's disk; there, get_file's download link is the way.
  if (!allowLocalFiles) return;

  server.registerTool(
    "download_files",
    {
      title: "Download files to this computer",
      description: `Save Canvas files to the user's computer as the original files, e.g. a .docx or .pptx template to fill in while keeping its formatting, lecture slides, or datasets. Files go to ${defaultDownloadDir()} unless a directory is given; a relative directory is created inside that folder. Existing files are never overwritten: a clash gets a numbered name like "report (1).docx". Returns each saved path. Accepts file IDs from list_files, File module items (content_id), assignment descriptions (/files/<id>) or message attachments.`,
      inputSchema: {
        file_ids: z.array(z.coerce.string()).min(1).max(50).describe("File IDs to download"),
        directory: z
          .string()
          .optional()
          .describe(`Folder to save into: an absolute path, or a subfolder of ${defaultDownloadDir()}`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ file_ids, directory }) =>
      run(async () => {
        const c = canvas();
        const dir = resolve(defaultDownloadDir(), directory ?? ".");
        await mkdir(dir, { recursive: true });

        const files = await mapLimit(file_ids, PARALLEL_DOWNLOADS, (id) =>
          c.get<Obj>(`files/${id}`).then(
            (f) => ({ id, f }),
            (err: Error) => ({ id, error: err.message }),
          ),
        );
        // Names are claimed up front, in order, so parallel downloads never pick the same path.
        const claimed = new Set<string>();
        const plan = files.map((entry) => {
          if ("error" in entry) return entry;
          const { id, f } = entry;
          if (!f.url) return { id, error: `can't be downloaded: ${f.lock_explanation ?? "it is locked or hidden from you"}` };
          const name = safeFileName(f.display_name ?? f.filename ?? `file-${id}`);
          return { id, url: f.url as string, name, path: freePath(dir, name, claimed) };
        });

        const results = await mapLimit(plan, PARALLEL_DOWNLOADS, async (item) => {
          if ("error" in item) return { file_id: item.id, error: item.error };
          try {
            const size = await saveResponse(await c.openDownload(item.url, SAVE_TIMEOUT_MS), item.path);
            return { file_id: item.id, name: item.name, path: item.path, size };
          } catch (err) {
            return { file_id: item.id, name: item.name, error: err instanceof Error ? err.message : String(err) };
          }
        });
        return {
          directory: dir,
          saved: results.filter((r) => "path" in r).length,
          failed: results.filter((r) => "error" in r).length,
          files: results,
        };
      }),
  );
}
