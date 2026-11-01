// Ed (edstem.org): course discussion forums and lessons. Ed is reached the way Canvas opens it: following a
// course's "Ed Discussion" LTI tool lands on Ed with a one-time login token, which is traded for an API token
// exactly as Ed's own web app does (POST /api/login_token). That token covers every Ed course on the account and
// lasts about two weeks. The API is the one Ed's web app uses, with the token in an X-Token header; it isn't
// documented, so an Ed update could break these tools. The Canvas API token itself is never sent to Ed.
import { CanvasError, type CanvasClient } from "./canvas.js";
import { followLaunch, navigationTools, sessionlessLaunch } from "./lti.js";

type Obj = Record<string, any>;

const REQUEST_TIMEOUT_MS = 30_000;
// Ed's regions and their API hosts, from Ed's web app. Canada shares the US region.
const REGION_APIS: Record<string, string> = {
  au: "https://edstem.org/api",
  us: "https://us.edstem.org/api",
  ca: "https://us.edstem.org/api",
  eu: "https://eu.edstem.org/api",
};
// Navigation tabs that may be Ed ("Ed Discussion" by default).
const ED_TAB = /\bed\b|edstem/i;
const ED_TOOL = /\bed\b|edstem/i;
// Renew a little before the token expires, and assume an hour when its expiry can't be read.
const EXPIRY_MARGIN_MS = 10 * 60_000;
const UNKNOWN_LIFETIME_MS = 60 * 60_000;

export class EdError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EdError";
  }
}

interface Login {
  token: string;
  expires: number;
  /** API base, e.g. https://edstem.org/api */
  api: string;
  /** Web app base for links, e.g. https://edstem.org/au */
  app: string;
}

/** The first active course whose navigation menu opens Ed, with a one-time launch link. */
async function findEdTool(c: CanvasClient): Promise<{ name: string; url: string }> {
  const courses = await c.getAll<Obj>("courses", { enrollment_state: "active" });
  const ids = courses.filter((x) => !x.access_restricted_by_date).map((x) => String(x.id));
  const tabs = await Promise.all(ids.map((id) => navigationTools(c, id).catch(() => [])));
  for (const [i, tools] of tabs.entries()) {
    for (const tool of tools.filter((t) => ED_TAB.test(t.label))) {
      const launch = await sessionlessLaunch(c, ids[i], tool.toolId);
      if (launch && ED_TOOL.test(launch.name)) return launch;
    }
  }
  throw new CanvasError(
    "None of your active Canvas courses has an Ed Discussion tab, so Ed can't be reached through Canvas.",
  );
}

function tokenPayload(token: string): Obj | undefined {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

async function login(c: CanvasClient): Promise<Login> {
  const tool = await findEdTool(c);
  const { page } = await followLaunch(c, tool.url, (url) => url.searchParams.has("_logintoken"));
  const loginToken = page.url.searchParams.get("_logintoken");
  if (!loginToken) {
    throw new CanvasError(
      `Opening ${tool.name} didn't sign in to Ed (ended at ${page.url.origin}${page.url.pathname} with status ${page.res.status}). Check that Ed opens from Canvas.`,
    );
  }
  // Ed lands on /<region>/courses/<id>. Its regions live on their own API hosts; anywhere else serves its own API.
  const region = page.url.pathname.split("/")[1] ?? "";
  const onEd = /(^|\.)edstem\.org$/i.test(page.url.hostname);
  const api = onEd && REGION_APIS[region] ? REGION_APIS[region] : `${page.url.origin}/api`;
  const { token } = await edFetch<Obj>(`${api}/login_token`, { method: "POST", body: { login_token: loginToken } });
  if (typeof token !== "string") throw new EdError("Ed didn't return a token for the Canvas sign-in.");
  const payload = tokenPayload(token);
  if (payload?.type === "2fa") {
    throw new EdError("Ed is asking for two-factor authentication on this account, which this server can't complete.");
  }
  const expires = typeof payload?.exp === "number" ? payload.exp * 1000 - EXPIRY_MARGIN_MS : Date.now() + UNKNOWN_LIFETIME_MS;
  return { token, expires, api, app: `${page.url.origin}/${region}` };
}

async function edFetch<T>(
  url: string,
  { method = "GET", body, token }: { method?: "GET" | "POST"; body?: unknown; token?: string } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(token ? { "x-token": token } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new EdError(`Could not reach Ed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new EdError(`Ed returned a non-JSON response (status ${res.status})`, res.status);
  }
  if (!res.ok) {
    const message = data?.message ?? data?.code;
    throw new EdError(`Ed ${res.status}${message ? `: ${message}` : ""}`, res.status);
  }
  return data as T;
}

export class EdClient {
  private login?: Promise<Login>;
  private expires = 0;

  constructor(private readonly canvas: CanvasClient) {}

  /** Signs in through Canvas on first use, and again once the token is about to expire or has been rejected. */
  private session(rejected?: Promise<Login>): Promise<Login> {
    // Parallel requests rejected with the same token sign in again only once.
    if (!this.login || this.login === rejected || Date.now() >= this.expires) {
      const attempt = login(this.canvas);
      this.login = attempt;
      this.expires = Infinity;
      attempt.then(
        (l) => {
          if (this.login === attempt) this.expires = l.expires;
        },
        () => {
          if (this.login === attempt) this.login = undefined;
        },
      );
    }
    return this.login!;
  }

  private async request<T>(method: "GET" | "POST", path: string, params?: Record<string, unknown>, body?: unknown): Promise<T> {
    let rejected: Promise<Login> | undefined;
    for (let attempt = 0; ; attempt++) {
      const current = this.session(rejected);
      const { api, token } = await current;
      const url = new URL(`${api}/${path}`);
      for (const [k, v] of Object.entries(params ?? {})) {
        if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
      }
      try {
        return await edFetch<T>(url.toString(), { method, body, token });
      } catch (err) {
        // A rejected token means the session ended early; sign in again once. Nothing was posted on a 401.
        if (attempt === 0 && err instanceof EdError && err.status === 401) {
          rejected = current;
          continue;
        }
        throw err;
      }
    }
  }

  get<T = any>(path: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  post<T = any>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, undefined, body);
  }

  /** The web address of a page in Ed, e.g. courses/1/discussion/2. */
  async link(path: string): Promise<string> {
    return `${(await this.session()).app}/${path}`;
  }
}

const clients = new WeakMap<CanvasClient, EdClient>();

/** The Ed client for a Canvas account, signed in on first use and kept while the server runs. */
export function ed(c: CanvasClient): EdClient {
  let client = clients.get(c);
  if (!client) clients.set(c, (client = new EdClient(c)));
  return client;
}

/** Ed timestamps carry microseconds and the server's offset; as UTC they get shown in the user's time zone like Canvas's. */
export function edTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
