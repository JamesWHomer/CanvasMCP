// Agent-filed bug reports and feature requests, kept as issues in a private GitHub repository
// (REPORTS_GITHUB_REPO) so the developer can triage them in GitHub or with `gh issue list`.

export interface ReportsConfig {
  /** owner/name of the repository the issues go to. */
  repo: string;
  /** A token that can read and write issues there (a fine-grained token scoped to that one repository). */
  token: string;
  apiUrl: string;
  /** New reports allowed per rolling 24 hours, across every agent using this server. */
  dailyLimit: number;
  /** Reports may hold details of the user's courses, so a public repository is refused unless this is set. */
  allowPublic: boolean;
}

/** Reporting is on only when both REPORTS_GITHUB_REPO and REPORTS_GITHUB_TOKEN are set. */
export function reportsFromEnv(env: NodeJS.ProcessEnv = process.env): ReportsConfig | undefined {
  const repo = env.REPORTS_GITHUB_REPO?.trim();
  const token = env.REPORTS_GITHUB_TOKEN?.trim();
  if (!repo || !token) return undefined;
  const limit = Number(env.REPORTS_DAILY_LIMIT);
  return {
    repo,
    token,
    apiUrl: (env.REPORTS_GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, ""),
    dailyLimit: Number.isInteger(limit) && limit > 0 ? limit : 10,
    allowPublic: /^(1|true|yes|on)$/i.test(env.REPORTS_ALLOW_PUBLIC?.trim() ?? ""),
  };
}

export type ReportKind = "bug" | "feature";

export interface Report {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  /** For closed issues: completed, not_planned or duplicate. */
  stateReason?: string;
  kind?: ReportKind;
  tool?: string;
  createdAt: number;
  comments: number;
}

// Hidden in each issue body, so reports can be told apart from issues people opened by hand.
const MARKER = /<!-- canvas-mcp-report kind=(bug|feature)(?: tool=([\w-]+))? -->/;

export function reportMarker(kind: ReportKind, tool: string | undefined): string {
  return `<!-- canvas-mcp-report kind=${kind}${tool ? ` tool=${tool}` : ""} -->`;
}

// Checked once per repository while the process lives; a failed check is retried next time.
const visibility = new Map<string, Promise<boolean>>();

export class ReportStore {
  constructor(private readonly config: ReportsConfig) {}

  get dailyLimit(): number {
    return this.config.dailyLimit;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.config.apiUrl}/repos/${this.config.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "canvas-mcp",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.json().then((j: { message?: string }) => j.message, () => undefined);
      const hint =
        res.status === 401 || res.status === 403 || res.status === 404
          ? " Check REPORTS_GITHUB_REPO and that REPORTS_GITHUB_TOKEN can read and write its issues."
          : "";
      throw new Error(`The report tracker (GitHub) answered ${res.status}${detail ? `: ${detail}` : ""}.${hint}`);
    }
    return (await res.json()) as T;
  }

  /** Throws unless the repository is private (or public repositories were explicitly allowed). */
  async checkPrivate(): Promise<void> {
    if (this.config.allowPublic) return;
    let check = visibility.get(this.config.repo);
    if (!check) {
      check = this.request<{ private: boolean }>("GET", "").then((r) => r.private === true);
      visibility.set(this.config.repo, check);
      check.catch(() => visibility.delete(this.config.repo));
    }
    if (!(await check)) {
      throw new Error(
        `Reports go to ${this.config.repo}, which is public, and they can describe the user's courses. ` +
          "Nothing was filed. The user should point REPORTS_GITHUB_REPO at a private repository (or set REPORTS_ALLOW_PUBLIC=true).",
      );
    }
  }

  /** The 100 most recent reports, open or closed. */
  async recent(): Promise<Report[]> {
    const issues = await this.request<Record<string, any>[]>(
      "GET",
      "/issues?state=all&sort=created&direction=desc&per_page=100",
    );
    return issues.flatMap((i) => {
      const marker = typeof i.body === "string" ? i.body.match(MARKER) : null;
      if (i.pull_request || !marker) return [];
      return [
        {
          number: i.number,
          title: i.title,
          url: i.html_url,
          state: i.state,
          stateReason: i.state_reason ?? undefined,
          kind: marker[1] as ReportKind,
          tool: marker[2],
          createdAt: Date.parse(i.created_at),
          comments: i.comments ?? 0,
        },
      ];
    });
  }

  async create(title: string, body: string, labels: string[]): Promise<{ number: number; url: string }> {
    const issue = await this.request<Record<string, any>>("POST", "/issues", { title, body, labels });
    return { number: issue.number, url: issue.html_url };
  }

  async comment(number: number, body: string): Promise<void> {
    await this.request("POST", `/issues/${number}/comments`, { body });
  }
}

// ---------- matching reports that describe the same problem ----------

const STOPWORDS = new Set(
  "the and for with when not does doesn don isn can cant won from that this are but into its has have was were should would than then they them their there tool tools returns return".split(
    " ",
  ),
);

/** The distinctive words of a title, roughly singularised, so similar titles share most of them. */
export function keywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  return new Set(words);
}

/** Share of words two sets have in common (Jaccard index), from 0 to 1. */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

// ---------- keeping secrets and personal details out of reports ----------

/** Removes tokens, keys and email addresses, and defuses @mentions so a report can't ping anyone. */
export function scrub(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out
    .replace(/\b\d{1,6}~[A-Za-z0-9]{20,}\b/g, "[redacted token]") // Canvas access tokens
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted token]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, "$1[redacted]")
    .replace(/([?&](?:access_token|token|key)=)[^&\s)"']+/gi, "$1[redacted]")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/@(?=[A-Za-z0-9])/g, "@​");
}
