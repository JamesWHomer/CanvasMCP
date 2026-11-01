// Opening a course's LTI tool the way a browser does when the user clicks its tab in Canvas. Canvas issues a
// one-time launch link (sessionless_launch); following it with cookies, redirects and the auto-submitting LTI
// forms signs in to the tool. Used for Echo360 (lecture recordings) and Ed (discussion and lessons). The Canvas API
// token is only sent to Canvas, never to the tool.
import { CanvasError, type CanvasClient } from "./canvas.js";
import { decodeEntities } from "./format.js";

type Obj = Record<string, any>;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 15;
const MAX_FORMS = 5;

export interface Page {
  url: URL;
  res: Response;
  text: string;
}

const domainMatch = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** Just enough of a browser's cookie handling to carry a session across Canvas, the LTI launch and the tool. */
class CookieJar {
  private cookies: { name: string; value: string; domain: string; hostOnly: boolean }[] = [];

  store(url: URL, res: Response): void {
    for (const header of res.headers.getSetCookie()) {
      const [pair, ...attrs] = header.split(";").map((s) => s.trim());
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq);
      const attr = (key: string) => attrs.find((a) => a.toLowerCase().startsWith(`${key}=`))?.slice(key.length + 1);
      // A cookie may only be scoped to the responding host or a parent domain of it.
      const domainAttr = attr("domain")?.replace(/^\./, "").toLowerCase();
      const hostOnly = !domainAttr || !domainMatch(url.hostname, domainAttr);
      const domain = hostOnly ? url.hostname : domainAttr;
      const expires = attr("expires");
      const expired = Number(attr("max-age")) <= 0 || (expires !== undefined && Date.parse(expires) < Date.now());
      this.cookies = this.cookies.filter((c) => !(c.name === name && c.domain === domain));
      if (!expired) this.cookies.push({ name, value: pair.slice(eq + 1), domain, hostOnly });
    }
  }

  header(url: URL): string {
    return this.cookies
      .filter((c) => (c.hostOnly ? c.domain === url.hostname : domainMatch(url.hostname, c.domain)))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }
}

export class Browser {
  private readonly jar = new CookieJar();

  constructor(private readonly allowHttp: boolean) {}

  /** Follows redirects by hand so each hop gets its own host's cookies. */
  async open(url: URL, init: { method?: "GET" | "POST"; body?: URLSearchParams; accept?: string } = {}): Promise<Page> {
    let method = init.method ?? "GET";
    let body = init.body;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== "https:" && !(this.allowHttp && url.protocol === "http:")) {
        throw new CanvasError(`Refusing non-HTTPS request to ${url.origin}`);
      }
      const cookie = this.jar.header(url);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          body,
          redirect: "manual",
          headers: { ...(cookie ? { cookie } : {}), ...(init.accept ? { accept: init.accept } : {}) },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new CanvasError(`Could not reach ${url.origin}: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.jar.store(url, res);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        url = new URL(location, url);
        // 307 and 308 repeat the request as it was; other redirects become a GET.
        if (res.status !== 307 && res.status !== 308) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      return { url, res, text: await res.text() };
    }
    throw new CanvasError(`Too many redirects from ${url.origin}`);
  }
}

/** The first form on a page, i.e. an LTI launch page's auto-submitting form. */
function findForm(html: string, base: URL): { action: URL; method: "GET" | "POST"; fields: URLSearchParams } | undefined {
  const form = html.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);
  if (!form) return undefined;
  const attr = (tag: string, name: string) => {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
    return m ? decodeEntities(m[1] ?? m[2]) : undefined;
  };
  const fields = new URLSearchParams();
  for (const [input] of form[2].matchAll(/<input\b[^>]*>/gi)) {
    const name = attr(input, "name");
    if (name) fields.append(name, attr(input, "value") ?? "");
  }
  const method = attr(form[1], "method")?.toUpperCase() === "GET" ? "GET" : "POST";
  return { action: new URL(attr(form[1], "action") ?? "", base), method, fields };
}

/** A course's LTI tools in its navigation menu, by tab label and tool ID. */
export async function navigationTools(c: CanvasClient, courseId: string): Promise<{ label: string; toolId: string }[]> {
  const tabs = await c.getAll<Obj>(`courses/${courseId}/tabs`);
  return tabs
    .filter((t) => t.type === "external")
    .map((t) => ({ label: String(t.label ?? ""), toolId: String(t.id).match(/^context_external_tool_(\d+)$/)?.[1] ?? "" }))
    .filter((t) => t.toolId);
}

/** A one-time link that opens a course's tool as clicking its tab would, with the tool's name. */
export async function sessionlessLaunch(
  c: CanvasClient,
  courseId: string,
  toolId: string,
): Promise<{ name: string; url: string } | undefined> {
  const launch = await c
    .get<Obj>(`courses/${courseId}/external_tools/sessionless_launch`, { id: toolId, launch_type: "course_navigation" })
    .catch(() => undefined);
  return launch?.url ? { name: String(launch.name ?? ""), url: launch.url } : undefined;
}

/** Opens a launch link and submits the LTI forms that follow until `arrived` says the tool has been reached. */
export async function followLaunch(
  c: CanvasClient,
  launchUrl: string,
  arrived: (url: URL) => boolean,
): Promise<{ browser: Browser; page: Page }> {
  const start = new URL(launchUrl);
  if (start.origin !== c.origin) throw new CanvasError(`Unexpected launch link host ${start.origin}`);
  const browser = new Browser(c.origin.startsWith("http:"));
  let page = await browser.open(start);
  for (let i = 0; i < MAX_FORMS && !arrived(page.url); i++) {
    const form = findForm(page.text, page.url);
    if (!form) break;
    if (form.method === "GET") {
      form.action.search = form.fields.toString();
      page = await browser.open(form.action);
    } else {
      page = await browser.open(form.action, { method: "POST", body: form.fields });
    }
  }
  return { browser, page };
}
