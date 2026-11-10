# Canvas MCP

An [MCP](https://modelcontextprotocol.io) server for the Canvas LMS REST API. It lets Claude:

- check what's due, and read assignments, rubrics, course files (PDFs, slides, docs), pages, announcements, discussions, the inbox and grades
- read and download transcripts (subtitles) of recorded lectures in Echo360
- read, search and catch up on Ed Discussion (edstem.org) and read Ed Lessons
- work out what you need to hit a target grade
- optionally submit assignments, post replies (in Canvas or on Ed) and send messages, each after you approve a preview

It signs in with a Canvas personal access token. Echo360 and Ed are reached through their tabs in Canvas, so they need no separate login.

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
| `CANVAS_ALLOW_WRITES` | `true` turns on the [write tools](#write-tools) |

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
| `list_assignments` | A course's assignments, filterable by `bucket` (upcoming, overdue, unsubmitted…), with group assignments flagged |
| `get_assignment` | Full instructions as Markdown, rubric, your group (for group assignments), your submitted files, score, rubric marks and instructor comments |
| `get_submission` | Just your submission: status, score, files with upload status, attempts used and their history, grader comments, and for group assignments your group and who uploaded the files |
| `get_grades` | Overall grade plus every score, grouped by weighted assignment group |
| `list_announcements` | Recent announcements across courses |
| `list_modules` | Modules and their items (pages, files, assignments…) with completion |
| `list_pages` / `get_page` | Course wiki pages as Markdown (`front_page` for the course home) |
| `get_syllabus` | The Syllabus page as Markdown |
| `list_files` / `get_file` | Course files and download links |
| `read_file` | A file's contents: text from PDFs (by page), .docx, .pptx (with speaker notes), .xlsx, notebooks, HTML and code. Images come back as images. Long files are paged |
| `download_files` | **Local server only.** Saves original files to your computer, e.g. a .docx template to fill in with its formatting intact. Saves to `~/Downloads/Canvas` (or `CANVAS_DOWNLOAD_DIR`) and never overwrites anything. Pair it with `submit_assignment`'s `path` to send the finished file back |
| `list_lecture_recordings` | A course's recorded lectures and videos from its Echo360 tool ("Recorded Lectures"), including ones in folders |
| `get_lecture_transcript` | What was said in a recording: plain text with a timestamp about once a minute, or `vtt` / `srt` subtitles. Long transcripts are paged |
| `download_lecture_transcripts` | **Local server only.** Saves transcripts for some or all of a course's recordings as `.srt` (default), `.vtt` or `.txt` files, in a "<course> transcripts" folder under `~/Downloads/Canvas` |
| `ed_list_courses` | Your Ed courses with the `ed_course_id` the other Ed tools need (Ed's IDs differ from Canvas's), and each course's discussion categories |
| `ed_list_threads` | Ed Discussion threads in one course, or across all your active Ed courses: filter by unread, new replies, unanswered, unresolved, yours, watched or starred; search; or pick a category |
| `ed_get_thread` | A thread in full as Markdown: the post, answers (accepted first), comments and nested replies, with authors, staff roles and endorsements. By ID or by its #number. Long threads are paged |
| `ed_list_lessons` / `ed_get_lesson` | Ed Lessons by module with your progress and due dates, and a lesson's slides as Markdown: readings, quiz questions with their options, and coding-challenge tasks. Long lessons are paged |
| `list_discussions` / `get_discussion` | Discussion topics and their full reply threads |
| `list_calendar_events` | Calendar events across courses and your personal calendar |
| `list_conversations` / `get_conversation` | Canvas Inbox, with attachments (reading doesn't mark messages read) |
| `get_recent_activity` | What's new: announcements, messages, newly graded work |
| `calculate_grade` | Current grade, the possible final range, what-if scores, and the average needed on remaining work for a target. Accepts the weight of assessments not in Canvas, such as an exam |
| `list_quizzes` / `get_quiz` | Classic and New Quizzes with time limits, attempts and scores |
| `list_course_people` | Teaching staff (or classmates by name) with user IDs and emails |
| `list_my_groups` | Your groups in current courses (or one course, with `course_id`), with members |
| `canvas_api_get` | Raw read-only GET for any other [Canvas API](https://canvas.instructure.com/doc/api/) endpoint |

Dates given as a bare day (e.g. `2026-11-03`) mean that whole day in your Canvas time zone. Timestamps come back in that time zone too, with its UTC offset (e.g. `2026-11-07T23:59:00+11:00`).

The token is only ever sent to `CANVAS_BASE_URL`. File downloads and uploads go through Canvas's separate storage host without the token, and the raw tool is limited to `/api/v1/` paths.

### Lecture transcripts

Recorded lectures live in Echo360, not Canvas. The lecture tools ask Canvas for a one-time launch link to the course's Echo360 tool and follow it the way your browser does when you click **Recorded Lectures**. That gives an Echo360 session (reused for 10 minutes), without sending your Canvas token to Echo360. They then call the endpoints Echo360's own video player uses. Those endpoints aren't a documented API, so an Echo360 update could break these tools.

The transcripts are Echo360's automatic speech recognition. They're usually good, but names and technical terms can be misheard. Speaker labels are left out because Echo360's are unreliable. A recording that hasn't been transcribed is reported and skipped.

### Ed Discussion and Ed Lessons

Ed (edstem.org) has its own accounts, but courses open it from an **Ed Discussion** tab in Canvas. The Ed tools follow that tab's launch link from the first active course that has one, the way your browser does. Ed then hands over a one-time login token, which the tools trade for an Ed API token, just as Ed's own web app does. That token covers every Ed course on your account and lasts about two weeks, so one sign-in serves all the Ed tools. The server signs in again when it expires or Ed rejects it. Your Canvas token is never sent to Ed.

The tools call the endpoints Ed's web app uses. Those aren't a documented API, so an Ed update could break them. Reading threads and lessons doesn't mark anything as read or viewed. Posts and lesson slides come back as Markdown, with images and attachments as links. Ed's Australian, US and European regions are all supported.

### Write tools

These are off unless `CANVAS_ALLOW_WRITES=true`. They're on in the local `.env` and on Vercel.

| Tool | What it does |
| --- | --- |
| `submit_assignment` | Submit text, a URL, or files. Each file comes from a public download link, a file already in your Canvas files (`file_id`), text or base64 contents, or, on the local server only, a path on disk |
| `post_discussion_reply` | Reply to a discussion topic or a specific entry |
| `send_message` | Send a Canvas Inbox message to people (IDs from `list_course_people`), or reply in a conversation |
| `set_planner_item_done` | Tick off (or un-tick) an item in your Canvas to-do list |
| `create_planner_note` | Add a personal to-do to your Canvas planner |
| `ed_post_thread` | Start an Ed Discussion thread (a question or a post) in a category, optionally private (staff only) or anonymous where the course allows it. The text is written in Markdown |
| `ed_reply` | Comment on an Ed thread, answer a question, or reply under an existing answer or comment |

`submit_assignment`, `post_discussion_reply`, `send_message`, `ed_post_thread` and `ed_reply` are two-step. A call without `confirm: true` only returns a preview, which also flags late submissions, attempts left and disallowed file types. For a group assignment it also names your group and any teammate's submission it would replace. The action happens only on a second call with `confirm: true`, after you've approved the preview. Quizzes can't be taken through this server.

**Large files.** The Vercel server accepts about 3 MB per request, so inline contents only suit small files. For anything bigger, give `submit_assignment` a public download link (`files: [{ url }]`). Canvas downloads the file itself, so it never passes through this server. Google Drive and Dropbox share links are converted to direct downloads automatically, as long as the file is shared with "Anyone with the link". The preview checks the link first and refuses one that opens a web page (such as a sign-in page) instead of the file. If Canvas is still downloading after about 2½ minutes, nothing is submitted and the result says how to finish. The local server can also upload files of any size from disk (`path`).
