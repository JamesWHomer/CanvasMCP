// Minimal Canvas REST API client: token auth, query encoding, Link-header pagination.

export type ParamValue = string | number | boolean | undefined | (string | number)[];
export type Params = Record<string, ParamValue>;

// Upper bound on items collected by getAll so one call can't page through an entire institution.
const DEFAULT_MAX_ITEMS = 500;
const REQUEST_TIMEOUT_MS = 30_000;

export class CanvasError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CanvasError";
  }
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

  private async fetchJson(url: URL): Promise<{ data: unknown; next?: string }> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          // Return IDs as strings; some Canvas instances use IDs larger than JS can represent exactly.
          Accept: "application/json+canvas-string-ids",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new CanvasError(`Could not reach Canvas at ${this.origin}: ${reason}`);
    }

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
