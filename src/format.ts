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
