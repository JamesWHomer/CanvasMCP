// Turns downloaded Canvas files into text (or an image) the model can read.
import { strFromU8, unzipSync } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";
import { htmlToMarkdown } from "./format.js";

export interface Section {
  label?: string;
  text: string;
}

export type Extracted =
  | { kind: "text"; format: string; sections: Section[]; note?: string }
  | { kind: "image"; mimeType: string; base64: string }
  | { kind: "unsupported"; reason: string };

// Images are returned inline for the model to look at; Vercel caps a response at 4.5 MB, and base64 adds a third.
const MAX_IMAGE_BYTES = 3_000_000;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const TEXT_EXTENSIONS = new Set(
  (
    "txt md markdown csv tsv json xml yaml yml toml ini log tex bib rmd qmd r py java c h cpp hpp cc cs go rs kt " +
    "swift js jsx ts tsx mjs cjs css scss sql sh bash ps1 bat m jl hs ml scala rb php pl lua dart vue svelte"
  ).split(" "),
);

export async function extractFile(bytes: Uint8Array, name: string, contentType = ""): Promise<Extracted> {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const type = contentType.toLowerCase().split(";")[0].trim();

  if (ext === "pdf" || type === "application/pdf") return pdf(bytes);
  if (ext === "docx") return office(bytes, "docx", docx);
  if (ext === "pptx") return office(bytes, "pptx", pptx);
  if (ext === "xlsx") return office(bytes, "xlsx", xlsx);
  if (ext === "ipynb") return notebook(bytes);
  if (ext === "html" || ext === "htm" || type === "text/html") {
    return { kind: "text", format: "html", sections: [{ text: htmlToMarkdown(decode(bytes)) ?? "" }] };
  }

  const imageType = IMAGE_TYPES[ext] ?? (type.startsWith("image/") && Object.values(IMAGE_TYPES).includes(type) ? type : "");
  if (imageType) {
    if (bytes.length > MAX_IMAGE_BYTES) return { kind: "unsupported", reason: "Image is too large to return inline" };
    return { kind: "image", mimeType: imageType, base64: Buffer.from(bytes).toString("base64") };
  }

  if (TEXT_EXTENSIONS.has(ext) || type.startsWith("text/") || type === "application/json") {
    if (looksBinary(bytes)) return { kind: "unsupported", reason: "File looks binary despite its text extension" };
    return { kind: "text", format: ext || "text", sections: [{ text: decode(bytes) }] };
  }

  if (ext === "doc" || ext === "ppt" || ext === "xls") {
    return { kind: "unsupported", reason: `Legacy .${ext} files aren't supported; ask for the .${ext}x version or a PDF` };
  }
  return { kind: "unsupported", reason: `Can't extract text from ${ext ? `.${ext}` : type || "this"} files` };
}

async function pdf(bytes: Uint8Array): Promise<Extracted> {
  // PDF.js may detach the buffer it's given, so hand it a copy.
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(doc, { mergePages: false });
  const sections = text.map((t, i) => ({ label: `Page ${i + 1}`, text: t.trim() }));
  const empty = sections.every((s) => !s.text);
  return {
    kind: "text",
    format: "pdf",
    sections,
    note: empty ? "No text layer found; this PDF is probably scanned images, so its content can't be read as text." : undefined,
  };
}

type OfficeReader = (files: Record<string, Uint8Array>) => Section[];

function office(bytes: Uint8Array, format: string, read: OfficeReader): Extracted {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    return { kind: "unsupported", reason: `Not a valid .${format} file` };
  }
  return { kind: "text", format, sections: read(files) };
}

function docx(files: Record<string, Uint8Array>): Section[] {
  const xml = files["word/document.xml"] ? strFromU8(files["word/document.xml"]) : "";
  const lines = [...xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)].map(([, body = ""]) => {
    const text = runText(body, "w");
    const heading = body.match(/<w:pStyle w:val="(?:Heading|heading)\s?(\d)"/)?.[1];
    if (heading && text) return `${"#".repeat(Number(heading))} ${text}`;
    if (/<w:numPr>/.test(body) && text) return `- ${text}`;
    return text;
  });
  return [{ text: tidy(lines.join("\n")) }];
}

function pptx(files: Record<string, Uint8Array>): Section[] {
  const slideNumbers = Object.keys(files)
    .map((path) => path.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1])
    .filter((n): n is string => Boolean(n))
    .map(Number)
    .sort((a, b) => a - b);
  return slideNumbers.map((n) => {
    const slide = paragraphs(strFromU8(files[`ppt/slides/slide${n}.xml`]));
    // Speaker notes are linked from the slide's relationships file.
    const rels = files[`ppt/slides/_rels/slide${n}.xml.rels`];
    const notesPath = rels && strFromU8(rels).match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/)?.[1];
    const notesXml = notesPath ? files[`ppt/notesSlides/${notesPath}`] : undefined;
    // Notes slides repeat the slide number as a placeholder; drop bare numbers.
    const notes = notesXml
      ? paragraphs(strFromU8(notesXml))
          .split("\n")
          .filter((line) => !/^\d+$/.test(line.trim()))
          .join("\n")
          .trim()
      : "";
    return { label: `Slide ${n}`, text: tidy(notes ? `${slide}\n\nSpeaker notes:\n${notes}` : slide) };
  });
}

function xlsx(files: Record<string, Uint8Array>): Section[] {
  const read = (path: string) => (files[path] ? strFromU8(files[path]) : "");
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) =>
    [...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(([, t]) => decodeXml(t)).join(""),
  );
  const rels = Object.fromEntries(
    [...read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/g)].map(
      ([, id, target]) => [id, target.replace(/^\/?xl\//, "")],
    ),
  );
  const sheets = [...read("xl/workbook.xml").matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]+)"/g)];
  return sheets.map(([, name, rid]) => {
    const rows = [...read(`xl/${rels[rid] ?? ""}`).matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)].map(
      ([, row = ""]) => {
        const cells: string[] = [];
        for (const [, attrs, body = ""] of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const col = columnIndex(attrs.match(/r="([A-Z]+)\d+"/)?.[1] ?? "");
          const kind = attrs.match(/t="([^"]+)"/)?.[1];
          const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
          const value =
            kind === "s"
              ? (shared[Number(raw)] ?? "")
              : kind === "inlineStr"
                ? decodeXml(body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "")
                : decodeXml(raw ?? "");
          cells[col >= 0 ? col : cells.length] = value;
        }
        return Array.from(cells, (v) => v ?? "").join("\t");
      },
    );
    return { label: `Sheet "${decodeXml(name)}"`, text: rows.join("\n").trim() };
  });
}

function notebook(bytes: Uint8Array): Extracted {
  try {
    const nb = JSON.parse(decode(bytes));
    const language = nb.metadata?.kernelspec?.language ?? nb.metadata?.language_info?.name ?? "";
    const source = (s: string | string[]) => (Array.isArray(s) ? s.join("") : (s ?? ""));
    const cells = (nb.cells ?? []).map((cell: { cell_type: string; source: string | string[] }) =>
      cell.cell_type === "code" ? `\`\`\`${language}\n${source(cell.source)}\n\`\`\`` : source(cell.source),
    );
    return { kind: "text", format: "ipynb", sections: [{ text: cells.join("\n\n") }] };
  } catch {
    return { kind: "unsupported", reason: "Not a valid Jupyter notebook" };
  }
}

/** Text of each <a:p> paragraph (DrawingML, used by slides and notes), one per line. */
function paragraphs(xml: string): string {
  return [...xml.matchAll(/<a:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:p>)/g)]
    .map(([, body = ""]) => runText(body, "a"))
    .filter(Boolean)
    .join("\n");
}

/** Concatenates text runs, tabs and line breaks inside one paragraph. */
function runText(xml: string, ns: "w" | "a"): string {
  const pattern = new RegExp(`<${ns}:(t|tab|br|cr)\\b[^>]*?(?:/>|>([\\s\\S]*?)</${ns}:t>)`, "g");
  let out = "";
  for (const [, tag, text] of xml.matchAll(pattern)) {
    out += tag === "t" ? decodeXml(text ?? "") : tag === "tab" ? "\t" : "\n";
  }
  return out.trim();
}

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[lower] ?? "";
  });
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096);
  return sample.includes(0);
}

function tidy(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
