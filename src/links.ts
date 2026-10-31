// Public download links for submission files: share links rewritten to direct downloads, and a quick look at
// what a link serves before Canvas is asked to download it.

const PROBE_TIMEOUT_MS = 20_000;

export interface LinkInfo {
  url: string;
  name?: string;
  size?: number;
  contentType?: string;
}

/** Google Drive and Dropbox share links open a web page; these are the forms that download the file itself. */
export function directDownloadUrl(link: string): URL {
  const url = new URL(link);
  if (url.hostname === "drive.google.com") {
    const id = url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] ?? url.searchParams.get("id");
    // confirm=t skips the "can't scan this file for viruses" page Drive serves instead of files over ~100 MB.
    if (id) return new URL(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`);
  }
  if (url.hostname === "dropbox.com" || url.hostname.endsWith(".dropbox.com")) url.searchParams.set("dl", "1");
  return url;
}

/**
 * Checks what a link serves without downloading it: a one-byte range request gives the size, type and file name.
 * No credentials are sent, since Canvas will fetch it anonymously too.
 */
export async function probeLink(link: string, allowHttp: boolean): Promise<LinkInfo> {
  let url: URL;
  try {
    url = directDownloadUrl(link);
  } catch {
    throw new Error(`Not a valid URL: ${link}`);
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new Error(`File links must use https: ${link}`);
  }
  let res: Response;
  try {
    res = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Couldn't reach ${url.host}: ${err instanceof Error ? err.message : String(err)}`);
  }
  await res.body?.cancel();
  if (!res.ok) {
    throw new Error(`${url.host} answered ${res.status} for ${link}; the link must download the file without signing in`);
  }
  const total = Number(res.status === 206 ? res.headers.get("content-range")?.split("/")[1] : res.headers.get("content-length"));
  return {
    url: url.toString(),
    name: dispositionName(res.headers.get("content-disposition")) ?? pathName(new URL(res.url || url)),
    size: total > 0 ? total : undefined,
    contentType: res.headers.get("content-type")?.split(";")[0].trim().toLowerCase() || undefined,
  };
}

function dispositionName(header: string | null): string | undefined {
  if (!header) return undefined;
  const extended = header.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i)?.[1];
  if (extended) {
    try {
      return decodeURIComponent(extended.trim());
    } catch {
      // Malformed encoding; fall back to the plain filename.
    }
  }
  return header.match(/filename\s*=\s*"([^"]+)"/i)?.[1] ?? header.match(/filename\s*=\s*([^;\s]+)/i)?.[1];
}

/** The last path segment, if it looks like a file name. */
function pathName(url: URL): string | undefined {
  try {
    const last = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    return /\.\w+$/.test(last) ? last : undefined;
  } catch {
    return undefined;
  }
}
