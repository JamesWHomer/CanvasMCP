# Canvas MCP

A read-only [MCP](https://modelcontextprotocol.io) server for the Canvas LMS REST API. It lets Claude check what's due, read assignments, rubrics, pages, the syllabus, announcements, discussions and grades in your Canvas account. It signs in with a personal access token.

It runs two ways:

- **Remote (Vercel):** deployed at `https://canvas-mcp-eight.vercel.app`. Use it from claude.ai, the Claude apps, or any machine. See [Remote server](#remote-server-vercel).
- **Local (stdio):** runs on this machine for Claude Code or Claude Desktop. See the steps below.

## 1. Get a Canvas access token

1. In Canvas, open **Account → Settings**.
2. Under **Approved Integrations**, click **+ New Access Token**.
3. Give it a purpose (e.g. "Claude MCP"). The expiry date is optional, but setting one is a good idea.
4. Copy the token. Canvas shows it only once.

If there's no **New Access Token** button, your school has turned off personal tokens. You'd need to ask your Canvas admin for a developer key (OAuth) instead.

The token has the same access as your Canvas account, so keep it private. To revoke it, delete it on the same Settings page.

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```
CANVAS_BASE_URL=https://yourschool.instructure.com
CANVAS_API_TOKEN=<your token>
```

`CANVAS_BASE_URL` is the address you see in your browser when you're on Canvas. Environment variables set in the MCP client config take priority over `.env`.

## 3. Build

```bash
npm install
npm run build
```

`npm test` builds and runs an end-to-end check against a mock Canvas API. It doesn't need a token.

## 4. Register with Claude

**Claude Code** (available in every project):

```bash
claude mcp add canvas --scope user -- node "C:/Users/ubers/Desktop/Projects/CanvasMCP/dist/index.js"
```

**Claude Desktop (chat):** add this to `%APPDATA%\Claude\claude_desktop_config.json`, then restart the app:

```json
{
  "mcpServers": {
    "canvas": {
      "command": "node",
      "args": ["C:/Users/ubers/Desktop/Projects/CanvasMCP/dist/index.js"]
    }
  }
}
```

To try it, ask "what's due this week on Canvas?". Or call `get_profile` to check the connection.

## Remote server (Vercel)

The Vercel project `canvas-mcp` serves the same tools over Streamable HTTP from `api/mcp.ts`. It runs in Sydney (`syd1`). It holds three production environment variables:

| Variable | Purpose |
| --- | --- |
| `CANVAS_BASE_URL` | `https://canvas.sydney.edu.au` |
| `CANVAS_API_TOKEN` | Canvas token (secret) |
| `MCP_ACCESS_KEY` | Random key every request must present (secret; a copy is in the local `.env`) |

Every request must carry the access key, otherwise it gets a `401`. If `MCP_ACCESS_KEY` isn't set, the server rejects every request. The key can go in the URL path or in a header:

- **In the path:** `https://canvas-mcp-eight.vercel.app/mcp/<MCP_ACCESS_KEY>`. Use this for claude.ai custom connectors, which can't send headers.
- **As a header:** `https://canvas-mcp-eight.vercel.app/mcp` with `Authorization: Bearer <MCP_ACCESS_KEY>`.

Anyone with the key URL can read your Canvas, so treat it like a password.

**claude.ai / Claude apps:** go to Settings → Connectors → Add custom connector. Paste the path URL and leave the OAuth fields empty. It then works on every device signed in to that Claude account. Add it once per Claude account.

**Claude Code:**

```bash
claude mcp add --transport http canvas-remote --scope user https://canvas-mcp-eight.vercel.app/mcp --header "Authorization: Bearer <MCP_ACCESS_KEY>"
```

**Redeploy** after code changes:

```bash
vercel deploy --prod
```

**Rotate the access key:** run `vercel env add MCP_ACCESS_KEY --environment production --sensitive --force`, then redeploy and update your connectors. **Replace the Canvas token** the same way with `CANVAS_API_TOKEN`.

## Tools

| Tool | What it does |
| --- | --- |
| `get_profile` | Your name, ID and time zone (useful as a connection check) |
| `list_courses` | Active courses with IDs, term and current grade (`include_completed` for past ones) |
| `get_planner` | Everything due across all courses in a date range, with submission status |
| `list_assignments` | A course's assignments, filterable by `bucket` (upcoming, overdue, unsubmitted…) |
| `get_assignment` | Full instructions as Markdown, rubric, your score, rubric marks and instructor comments |
| `get_grades` | Overall grade plus every score, grouped by weighted assignment group |
| `list_announcements` | Recent announcements across courses |
| `list_modules` | Modules and their items (pages, files, assignments…) with completion |
| `list_pages` / `get_page` | Course wiki pages as Markdown (`front_page` for the course home) |
| `get_syllabus` | The Syllabus page as Markdown |
| `list_files` / `get_file` | Course files and download links |
| `list_discussions` / `get_discussion` | Discussion topics and their full reply threads |
| `canvas_api_get` | Raw read-only GET for any other [Canvas API](https://canvas.instructure.com/doc/api/) endpoint |

All tools are read-only: nothing gets submitted, posted or changed. The token is only ever sent to `CANVAS_BASE_URL`, and the raw tool is limited to `/api/v1/` paths on that host.

Timestamps are returned in UTC as Canvas sends them. The model can convert them using the time zone from `get_profile`.
