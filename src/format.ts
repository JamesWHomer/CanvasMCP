// Helpers that shrink Canvas JSON into compact, model-friendly output.
import TurndownService from "turndown";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove(["script", "style"]);

/** Converts Canvas rich-content HTML to Markdown, keeping links. */
export function htmlToMarkdown(html: string | null | undefined): string | undefined {
  if (!html) return undefined;
  const md = turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
  return md || undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/**
 * Rubric text is stored as plain text, but often holds pasted HTML that Canvas escaped again on every save
 * (&amp;amp;amp;). Undoes the repeated escaping, then converts any HTML to Markdown.
 */
export function richTextToMarkdown(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  let s = text;
  while (s.includes("&amp;")) s = s.replaceAll("&amp;", "&");
  s = decodeEntities(s);
  if (/<\/?[a-z][a-z0-9]*(\s[^>]*)?\/?>/i.test(s)) s = htmlToMarkdown(s)?.replace(/[ \t]+\n/g, "\n") ?? "";
  const out = s.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out || undefined;
}

/** Plain text to Canvas rich-content HTML: blank lines separate paragraphs, single newlines become <br>. */
export function textToHtml(text: string): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export function truncate(text: string | undefined, max: number): string | undefined {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated, ${text.length - max} more characters]`;
}

/** Drops null, undefined, empty-string and empty-array fields so output stays small. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out as Partial<T>;
}
