// Minimal Canvas REST API client: token auth, query encoding, Link-header pagination, file download and upload.

export type ParamValue = string | number | boolean | undefined | (string | number)[];
export type Params = Record<string, ParamValue>;

// Upper bound on items collected by getAll so one call can't page through an entire institution.
const DEFAULT_MAX_ITEMS = 500;
const REQUEST_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;

export class CanvasError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CanvasError";
  }
}

export interface UploadFile {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
}

export class CanvasClient {
  readonly origin: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    this.origin = normalizeBaseUrl(baseUrl);
  }

  /** Turns a relative Canvas link (e.g. a planner item's html_url) into a full URL. */
  absoluteUrl(path: string): string {
    return new URL(path, this.origin).toString();
  }

  async get<T = unknown>(path: string, params?: Params): Promise<T> {
    const { data } = await this.fetchJson(this.apiUrl(path, params));
    return data as T;
  }

  async getAll<T = unknown>(path: string, params?: Params, maxItems = DEFAULT_MAX_ITEMS): Promise<T[]> {
    const items: T[] = [];
    let url: URL | undefined = this.apiUrl(path, { per_page: 100, ...params });
    while (url && items.length < maxItems) {
      const page = await this.fetchJson(url);
      if (!Array.isArray(page.data)) {
        throw new CanvasError(`Expected a list from ${url.pathname} but got ${typeof page.data}`);
      }
      items.push(...(page.data as T[]));
      url = page.next ? this.apiUrl(page.next) : undefined;
    }
    return items.slice(0, maxItems);
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const { data } = await this.fetchJson(this.apiUrl(path), { method: "POST", body });
    return data as T;
  }

  async put<T = unknown>(path: string, body: unknown): Promise<T> {
    const { data } = await this.fetchJson(this.apiUrl(path), { method: "PUT", body });
    return data as T;
  }

  /** Downloads a Canvas file URL into memory. */
  async download(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType?: string }> {
    const res = await this.openDownload(url, TRANSFER_TIMEOUT_MS);
    const declared = Number(res.headers.get("content-length"));
    if (declared > maxBytes) throw new CanvasError(tooLarge(declared, maxBytes));
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new CanvasError(tooLarge(bytes.length, maxBytes));
    return { bytes, contentType: res.headers.get("content-type") ?? undefined };
  }

  /**
   * Opens a Canvas file URL and returns the final response, for the caller to read or stream. Canvas redirects
   * downloads to separate file storage; redirects are followed by hand so the token is only ever sent to the
   * Canvas host, never to the storage host.
   */
  async openDownload(url: string, timeoutMs: number): Promise<Response> {
    let current = new URL(url, this.origin);
    if (current.origin !== this.origin) {
      throw new CanvasError(`Refusing to download from ${current.origin}; expected a ${this.origin} file URL`);
    }
    // One signal for the whole transfer, so it also bounds reading the body.
    const signal = AbortSignal.timeout(timeoutMs);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      this.assertTransferUrl(current);
      const res = await this.send(current, {
        redirect: "manual",
        headers: current.origin === this.origin ? { Authorization: `Bearer ${this.token}` } : {},
        signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new CanvasError(`Download redirect (${res.status}) had no Location header`);
        current = new URL(location, current);
        continue;
      }
      if (!res.ok) throw new CanvasError(`File download failed with status ${res.status}`, res.status);
      return res;
    }
    throw new CanvasError("File download redirected too many times");
  }

  /**
   * Uploads a file into the user's submission attachments for an assignment (Canvas's 3-step upload flow)
   * and returns the new file's ID for use in a submission.
   */
  async uploadSubmissionFile(courseId: string, assignmentId: string, file: UploadFile): Promise<string> {
    // Step 1: tell Canvas about the file; it answers with where and how to upload it.
    const ticket = await this.post<{ upload_url: string; upload_params: Record<string, string>; file_param?: string }>(
      `courses/${courseId}/assignments/${assignmentId}/submissions/self/files`,
      { name: file.name, size: file.bytes.length, content_type: file.contentType, on_duplicate: "rename" },
    );

    // Step 2: multipart POST to the storage host. Upload params go first; the token is not sent off-host.
    const uploadUrl = new URL(ticket.upload_url);
    this.assertTransferUrl(uploadUrl);
    const form = new FormData();
    for (const [key, value] of Object.entries(ticket.upload_params ?? {})) form.append(key, value);
    form.append(ticket.file_param ?? "file", new Blob([file.bytes], { type: file.contentType }), file.name);
    const res = await this.send(uploadUrl, {
      method: "POST",
      body: form,
      redirect: "manual",
      headers: uploadUrl.origin === this.origin ? { Authorization: `Bearer ${this.token}` } : {},
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });

    // Step 3: the storage host either returns the file JSON or points back at Canvas to confirm it.
    const text = await res.text();
    if (res.status >= 400) throw new CanvasError(`File upload failed with status ${res.status}: ${text.slice(0, 300)}`);
    try {
      const body = JSON.parse(text);
      if (body?.id) return String(body.id);
    } catch {
      // Not JSON; fall through to the Location header.
    }
    const location = res.headers.get("location");
    if (!location) throw new CanvasError(`File upload returned status ${res.status} without a file ID`);
    const confirmed = await this.get<{ id: string | number }>(new URL(location, uploadUrl).toString());
    return String(confirmed.id);
  }

  /**
   * Accepts "courses/1", "/api/v1/courses/1" or a full URL on the Canvas host (pagination links, items_url).
   * Anything that would leave the configured host or the /api/v1 tree is rejected so the token never leaks.
   */
  private apiUrl(path: string, params?: Params): URL {
    const url = /^https?:\/\//i.test(path)
      ? new URL(path)
      : new URL(`/api/v1/${path.replace(/^\/+/, "").replace(/^api\/v1\//, "")}`, this.origin);
    if (url.origin !== this.origin) {
      throw new CanvasError(`Refusing to send the Canvas token to ${url.origin} (configured host is ${this.origin})`);
    }
    if (!url.pathname.startsWith("/api/v1/")) {
      throw new CanvasError(`Path must be inside /api/v1/, got ${url.pathname}`);
    }
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        const arrayKey = key.endsWith("[]") ? key : `${key}[]`;
        for (const v of value) url.searchParams.append(arrayKey, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  // File storage hosts must be HTTPS; plain HTTP is only tolerated when Canvas itself is (local testing).
  private assertTransferUrl(url: URL): void {
    if (url.protocol !== "https:" && !(url.protocol === "http:" && this.origin.startsWith("http:"))) {
      throw new CanvasError(`Refusing non-HTTPS file transfer to ${url.origin}`);
    }
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new CanvasError(`Could not reach ${url.origin}: ${reason}`);
    }
  }

  private async fetchJson(
    url: URL,
    init: { method?: "POST" | "PUT"; body?: unknown } = {},
  ): Promise<{ data: unknown; next?: string }> {
    const res = await this.send(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        // Return IDs as strings; some Canvas instances use IDs larger than JS can represent exactly.
        Accept: "application/json+canvas-string-ids",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = (await res.text()).replace(/^while\(1\);/, "");
    if (!res.ok) throw new CanvasError(describeError(res.status, url, text), res.status);

    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new CanvasError(`Canvas returned a non-JSON response for ${url.pathname} (status ${res.status})`);
      }
    }
    return { data, next: nextLink(res.headers.get("link")) };
  }
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(withScheme).origin;
}

export function tooLarge(size: number, max: number): string {
  return `File is ${(size / 1e6).toFixed(1)} MB, over the ${(max / 1e6).toFixed(0)} MB limit`;
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (match) return match[1];
  }
  return undefined;
}

function describeError(status: number, url: URL, body: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed.errors)) detail = parsed.errors.map((e: { message?: string }) => e.message).join("; ");
    else if (typeof parsed.errors === "object" && parsed.errors) detail = JSON.stringify(parsed.errors);
    else detail = parsed.message ?? parsed.error ?? "";
  } catch {
    detail = body.slice(0, 300);
  }

  const hint =
    status === 401
      ? "The access token is invalid or expired, or your account isn't allowed to see this."
      : status === 403 && /rate limit/i.test(body)
        ? "Canvas rate limit hit; wait a moment and try again."
        : status === 404
          ? "Not found. Check the IDs; the item may not exist or may be hidden from you."
          : "";

  return [`Canvas API ${status} for ${url.pathname}`, detail, hint].filter(Boolean).join(" — ");
}
