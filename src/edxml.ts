// Ed stores posts and lesson slides in its own XML: <document version="2.0"><paragraph>…</paragraph></document>.
// edToMarkdown renders it for reading (by way of HTML, reusing the Canvas HTML converter); markdownToEd turns the
// Markdown a post is written in into it.
import { decodeEntities, htmlToMarkdown } from "./format.js";

const TAG = /<(\/?)([a-z][a-z0-9-]*)((?:\s+[a-z][a-z0-9-]*\s*=\s*"[^"]*")*)\s*(\/?)>/gi;

// Ed elements with a direct HTML equivalent. Anything not listed keeps its text but loses the tag.
const HTML_NAMES: Record<string, string> = {
  document: "div",
  paragraph: "p",
  bold: "strong",
  italic: "em",
  underline: "u",
  strike: "del",
  code: "code",
  math: "code",
  superscript: "sup",
  subscript: "sub",
  highlight: "mark",
  break: "br",
  figure: "div",
  "list-item": "li",
  blockquote: "blockquote",
  quote: "blockquote",
  callout: "blockquote",
  spoiler: "blockquote",
  pre: "pre",
  table: "table",
  "table-row": "tr",
  "table-cell": "td",
  "web-snippet": "div",
};
const VOID = new Set(["br", "img"]);

const attrsOf = (raw: string) =>
  Object.fromEntries([...raw.matchAll(/([a-z][a-z0-9-]*)\s*=\s*"([^"]*)"/gi)].map((m) => [m[1].toLowerCase(), m[2]]));

/** Ed XML to Markdown. Attribute values and text stay entity-encoded until the HTML parser decodes them. */
export function edToMarkdown(xml: string | null | undefined): string | undefined {
  if (!xml) return undefined;
  // A web snippet's HTML file is escaped page markup (often a table); its CSS and JS files are dropped. The HTML is
  // set aside while Ed's tags are renamed, so its own tags (tr, td…) aren't mistaken for Ed's.
  const snippets: string[] = [];
  const source = xml
    .replace(/<web-snippet-file\b([^>]*)>([\s\S]*?)<\/web-snippet-file>/gi, (_, attrs: string, body: string) =>
      attrsOf(attrs).language === "html" ? `\u0000${snippets.push(decodeEntities(body)) - 1}\u0000` : "",
    )
    // Ed wraps each list item's text in a paragraph, which would leave a blank line between every item.
    .replace(
      /(<list-item\b[^>]*>)\s*<paragraph>((?:(?!<\/?paragraph\b)[\s\S])*?)<\/paragraph>\s*(?=<\/list-item>|<list\b)/gi,
      "$1$2",
    );
  const html = source.replace(TAG, (_, close: string, rawName: string, rawAttrs: string, selfClosing: string) => {
    const name = rawName.toLowerCase();
    const a = attrsOf(rawAttrs);
    let open: string;
    let end: string;
    switch (name) {
      case "heading": {
        const level = Math.min(Math.max(Number(a.level) || 2, 1), 6);
        [open, end] = [`<h${level}>`, `</h${level}>`];
        break;
      }
      case "list": {
        const tag = /^(number|ordered)$/i.test(a.style ?? "") ? "ol" : "ul";
        [open, end] = [`<${tag}${a.start && tag === "ol" ? ` start="${a.start}"` : ""}>`, `</${tag}>`];
        break;
      }
      case "link":
        [open, end] = [`<a href="${a.href ?? ""}">`, "</a>"];
        break;
      case "image":
        return close ? "" : `<img src="${a.src ?? ""}" alt="${a.alt ?? "image"}">`;
      case "file":
        return close ? "" : `<p>Attachment: <a href="${a.url ?? ""}">${a.filename || "file"}</a></p>`;
      case "video":
      case "embed":
        return close ? "" : `<p><a href="${a.src ?? a.url ?? ""}">${name}</a></p>`;
      case "poll":
        return close ? "" : "<p>[poll: open the post in Ed to see it]</p>";
      case "snippet":
        [open, end] = [`<pre><code class="language-${a.language || "text"}">`, "</code></pre>"];
        break;
      default: {
        const tag = HTML_NAMES[name] ?? "span";
        [open, end] = VOID.has(tag) ? [`<${tag}>`, ""] : [`<${tag}>`, `</${tag}>`];
      }
    }
    if (close) return end;
    // <heading/> and the like are empty elements, but HTML would read them as still open.
    return selfClosing ? open + end : open;
  });
  return htmlToMarkdown(html.replace(/\u0000(\d+)\u0000/g, (_, i: string) => snippets[Number(i)]));
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline Markdown (code, links, bold, italic, strikethrough) to Ed XML. */
function inline(text: string): string {
  const codes: string[] = [];
  // Code spans are set aside first so nothing inside them is treated as formatting.
  let s = escapeXml(text).replace(/`([^`]+)`/g, (_, code: string) => `\u0000${codes.push(code) - 1}\u0000`);
  s = s
    .replace(/\[([^\]]+)\]\((\S+?)\)/g, '<link href="$2">$1</link>')
    .replace(/\*\*(?=\S)(.+?)\*\*/g, "<bold>$1</bold>")
    .replace(/__(?=\S)(.+?)__/g, "<bold>$1</bold>")
    .replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*(?![*\w])/g, "$1<italic>$2</italic>")
    .replace(/(^|[^_\w])_(?=\S)([^_]+?)_(?![_\w])/g, "$1<italic>$2</italic>")
    .replace(/~~(?=\S)(.+?)~~/g, "<strike>$1</strike>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`);
}

const BULLET = /^\s*[-*+]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Markdown to Ed XML: paragraphs (single newlines become line breaks), # headings, - and 1. lists,
 * > quotes, fenced code blocks, and inline **bold**, *italic*, `code`, ~~strike~~ and [links](url).
 */
export function markdownToEd(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  const paragraph = (ls: string[]) => `<paragraph>${ls.map((l) => inline(l.trim())).join("<break/>")}</paragraph>`;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      i++;
      blocks.push(`<pre>${escapeXml(code.join("\n"))}</pre>`);
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      blocks.push(`<heading level="${Math.min(heading[1].length, 3)}">${inline(heading[2])}</heading>`);
      i++;
      continue;
    }
    const marker = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : undefined;
    if (marker) {
      const items: string[][] = [];
      // An item runs until the next marker or a blank line; indented lines continue it.
      for (; i < lines.length && lines[i].trim(); i++) {
        if (marker.test(lines[i])) items.push([lines[i].replace(marker, "")]);
        else if (/^\s/.test(lines[i]) || !(BULLET.test(lines[i]) || NUMBERED.test(lines[i]))) items.at(-1)!.push(lines[i]);
        else break;
      }
      const style = marker === BULLET ? "bullet" : "number";
      blocks.push(`<list style="${style}">${items.map((it) => `<list-item>${paragraph(it)}</list-item>`).join("")}</list>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quoted.push(lines[i].replace(/^\s*>\s?/, ""));
      blocks.push(`<blockquote>${paragraph(quoted)}</blockquote>`);
      continue;
    }
    const text: string[] = [];
    for (; i < lines.length && lines[i].trim(); i++) {
      if (text.length && (FENCE.test(lines[i]) || BULLET.test(lines[i]) || NUMBERED.test(lines[i]) || /^\s*(#{1,6}\s|>)/.test(lines[i]))) break;
      text.push(lines[i]);
    }
    blocks.push(paragraph(text));
  }
  return `<document version="2.0">${blocks.join("")}</document>`;
}
