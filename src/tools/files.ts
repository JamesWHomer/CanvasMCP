// read_file: download a Canvas file and return its text (PDF, Office, notebooks, code) or the image itself.
import { z } from "zod";
import { extractFile } from "../extract.js";
import { compact } from "../format.js";
import { READ_ONLY, RawResult, run, type Obj, type ToolContext } from "./shared.js";

const MAX_DOWNLOAD_BYTES = 40_000_000;
const DEFAULT_CHARS = 40_000;

export function registerFileTools({ server, canvas }: ToolContext): void {
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
}
