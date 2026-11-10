// End-to-end check: runs the built server (stdio and HTTP) against a mock Canvas API, a mock file-storage host,
// a mock Echo360 (lecture recordings), a mock Ed (discussion and lessons) and a mock GitHub (where reports go).
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpRequest } from "../dist/http.js";
import { markdownToEd } from "../dist/edxml.js";
import { directDownloadUrl } from "../dist/links.js";

const TOKEN = "test-token";
const READ_TOOLS = 34;
const LOCAL_TOOLS = 2; // download_files and download_lecture_transcripts, stdio server only
const WRITE_TOOLS = 7;
const downloadDir = await mkdtemp(join(tmpdir(), "canvas-mcp-downloads-"));

// ---------- fixtures ----------

/** A minimal valid PDF with one line of text per page. */
function makePdf(pages) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>"];
  const font = 3 + pages.length * 2;
  objects.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  pages.forEach((text, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
    );
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const docx = zipSync({
  "word/document.xml": strToU8(
    `<w:document><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Lab Spec</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">Measure the </w:t></w:r><w:r><w:t>enzyme &amp; record</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Step one</w:t></w:r></w:p>
    </w:body></w:document>`,
  ),
});

const slide = (text) => strToU8(`<p:sld><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sld>`);
const pptx = zipSync({
  "ppt/slides/slide1.xml": slide("Intro to Regression"),
  "ppt/slides/slide2.xml": slide("Residuals"),
  "ppt/slides/slide10.xml": slide("Summary"),
  "ppt/slides/_rels/slide1.xml.rels": strToU8(
    `<Relationships><Relationship Id="rId2" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
  ),
  "ppt/notesSlides/notesSlide1.xml": strToU8(
    `<p:notes><a:p><a:r><a:t>Remember the assumptions</a:t></a:r></a:p><a:p><a:r><a:t>1</a:t></a:r></a:p></p:notes>`,
  ),
});

const longText = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");

// ---------- mock storage host (where Canvas redirects downloads and sends uploads) ----------

const storageLog = [];
const storageFiles = {
  "/blob/slides.pdf": makePdf(["Week 3 Linear Models", "Assumptions and residuals"]),
  "/blob/spec.docx": Buffer.from(docx),
  "/blob/lecture.pptx": Buffer.from(pptx),
  "/blob/notes.txt": Buffer.from(longText),
  "/blob/diagram.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
};
const storage = createServer(async (req, res) => {
  const body = await readBody(req);
  storageLog.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
  if (req.method === "POST" && req.url === "/upload") {
    res.writeHead(201, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id: "900" }));
  }
  if (req.method === "POST" && req.url === "/upload-link") {
    res.writeHead(201, { "content-type": "application/json" });
    return res.end("{}");
  }
  if (req.url === "/page") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end("<html>Sign in to continue</html>");
  }
  if (req.url === "/download?id=abc") {
    res.writeHead(206, {
      "content-type": "application/pdf",
      "content-range": "bytes 0-0/173000000",
      "content-disposition": `attachment; filename="lab report.pdf"; filename*=UTF-8''lab%20report.pdf`,
    });
    return res.end("%");
  }
  const file = storageFiles[req.url.split("?")[0]];
  res.writeHead(file ? 200 : 404, file ? { "content-length": file.length } : {});
  res.end(file);
});

// ---------- mock Echo360 (reached by following the course's LTI launch) ----------

const SECTION = "11111111-2222-3333-4444-555555555555";
const echoLog = [];
const echoLesson = (id, name, medias, extra = {}) => ({
  type: "SyllabusLessonType",
  lesson: { lesson: { id, displayName: name, createdAt: "2026-08-01T00:00:00.000Z" }, medias, ...extra },
});
const echoSyllabus = [
  echoLesson("G_abc_2026-08-20T12:05:00.000", "Week 3 Lecture", [{ id: "m1", mediaType: "Video", isAvailable: true }], {
    startTimeUTC: "2026-08-20T02:05:00.000Z",
  }),
  { type: "SyllabusGroupType", groupInfo: { name: "Module 1" }, lessons: [echoLesson("L2", "V01: Intro", [{ id: "m2", isAvailable: true }])] },
  echoLesson("L3", "Week 13 Lecture", []), // scheduled, not recorded yet
  echoLesson("L4", "Hidden", [{ id: "m4", isAvailable: false }]),
];
const echoCues = [
  { startMs: 1000, endMs: 3500, speaker: "Speaker 0", content: "Welcome to week three." },
  { startMs: 3500, endMs: 62000, speaker: "Speaker 1", content: "Today: residuals & <outliers>." },
  { startMs: 62000, endMs: 65000, speaker: "Speaker 0", content: "Any  questions?" },
];
const echo = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const body = await readBody(req);
  echoLog.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, body });
  const json = (status, data) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (req.method === "POST" && url.pathname === "/lti/launch") {
    res.writeHead(302, { location: `/section/${SECTION}/home`, "set-cookie": "PLAY_SESSION=abc; Path=/; HttpOnly" });
    return res.end();
  }
  // Both mocks share 127.0.0.1, and cookies ignore ports, so Canvas's cookie rides along too.
  if (!req.headers.cookie?.split("; ").includes("PLAY_SESSION=abc")) {
    res.writeHead(401, { "content-type": "text/html" });
    return res.end("<html>Please sign in</html>");
  }
  if (url.pathname === `/section/${SECTION}/home`) {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<html>Recordings</html>");
  }
  if (url.pathname === `/section/${SECTION}/syllabus`) return json(200, { status: "ok", message: "", data: echoSyllabus });
  if (url.pathname === "/api/ui/echoplayer/lessons/G_abc_2026-08-20T12:05:00.000/medias/m1/transcript") {
    return json(200, { status: "ok", data: { status: "Available", isAutomated: true, contentJSON: { cues: echoCues } } });
  }
  json(404, { status: "error", message: "Not found" });
});

// ---------- mock Ed (reached by following the course's Ed Discussion LTI launch) ----------

const edLog = [];
let edLogins = 0;
let edToken;
let edRejectNext = false;
const edJwt = (payload) =>
  [{ alg: "HS256" }, payload].map((p) => Buffer.from(JSON.stringify(p)).toString("base64url")).join(".") + ".sig";
const edDoc = (inner) => `<document version="2.0">${inner}</document>`;
const edCourse = (id, code, status, lastActive, discussion) => ({
  course: { id, code, name: `${code} course`, year: "2026", session: "Semester 2", status, settings: { discussion } },
  role: { role: "student" },
  last_active: lastActive,
});
const edUser = {
  user: { id: 1, name: "Test Student" },
  courses: [
    edCourse(501, "CHEM1001", "active", "2026-10-01T10:00:00+10:00", { readonly: true, categories: [{ name: "General" }] }),
    edCourse(400, "OLD1000", "archived", "2025-06-01T10:00:00+10:00", { categories: [] }),
    edCourse(500, "BIO1001", "active", "2026-10-30T10:00:00.123456+11:00", {
      anonymous: true,
      categories: [
        { name: "General", subcategories: [] },
        { name: "Labs", subcategories: [{ name: "Lab 1" }, { name: "Lab 2" }] },
      ],
    }),
  ],
};
const edUsers = [
  { id: 1, name: "Test Student", course_role: "student" },
  { id: 2, name: "Dr Tutor", course_role: "admin" },
  { id: 3, name: "Sam Mentor", course_role: "mentor" },
];
const edListThread = (id, number, created, extra = {}) => ({
  id,
  number,
  course_id: 500,
  type: "question",
  title: `Thread ${number}`,
  category: "Labs",
  subcategory: "Lab 1",
  document: "word ".repeat(60),
  created_at: created,
  reply_count: 1,
  vote_count: 0,
  is_seen: true,
  user: edUsers[1],
  ...extra,
});
const edThreads500 = [
  edListThread(700, 12, "2026-10-30T09:00:00.123456+11:00", { is_seen: false, is_staff_answered: true, is_answered: true }),
  edListThread(710, 11, "2026-10-20T09:00:00+11:00", { user: null, is_anonymous: true, type: "post", new_reply_count: 2 }),
];
const edThreads501 = [
  { ...edListThread(720, 3, "2026-10-25T09:00:00+11:00", { type: "announcement" }), course_id: 501, user: edUsers[1] },
];
const edReply = (id, userId, type, text, extra = {}) => ({
  id,
  user_id: userId,
  type,
  content: edDoc(`<paragraph>${text}</paragraph>`),
  document: text,
  created_at: "2026-10-30T10:00:00+11:00",
  comments: [],
  ...extra,
});
const edThreadDetail = {
  thread: {
    id: 700,
    number: 12,
    course_id: 500,
    user_id: 1,
    type: "question",
    title: "Is the lab report due Friday?",
    category: "Labs",
    subcategory: "Lab 1",
    accepted_id: 803,
    is_answered: true,
    is_staff_answered: true,
    unique_view_count: 40,
    created_at: "2026-10-30T09:00:00.123456+11:00",
    content: edDoc(
      '<paragraph>Is the <bold>lab report</bold> due <italic>Friday</italic>? See <link href="https://example.com/a?b=1&amp;c=2">the spec</link>.</paragraph>' +
        '<list style="number"><list-item><paragraph>Intro</paragraph></list-item><list-item><paragraph>Method</paragraph></list-item></list>' +
        '<snippet language="py" runnable="true" line-numbers="true"><snippet-file id="code">print(&quot;hi&quot;)\nx = 1 &lt; 2</snippet-file></snippet>' +
        '<figure><image src="https://static.example/img.png" width="10" height="10"/></figure>' +
        '<file url="https://static.example/spec.pdf" filename="spec.pdf"/><heading level="2"/>' +
        "<paragraph>Ratio <math>x_1/2</math></paragraph>" +
        "<table><table-row><table-cell><paragraph>Week</paragraph></table-cell><table-cell><paragraph>Room</paragraph></table-cell></table-row>" +
        "<table-row><table-cell><paragraph>1</paragraph></table-cell><table-cell><paragraph>A|B</paragraph></table-cell></table-row></table>" +
        "<paragraph>End</paragraph>",
    ),
    answers: [
      edReply(801, 2, "answer", "Yes, Friday.", {
        is_endorsed: true,
        vote_count: 2,
        created_at: "2026-10-30T09:30:00.5+11:00",
        comments: [edReply(802, 0, "comment", "Thanks", { is_anonymous: true, anonymous_id: 99 })],
      }),
      edReply(803, 3, "answer", "Friday at 5pm."),
    ],
    comments: [edReply(804, 3, "comment", "Ask your tutor too.", { is_private: true })],
  },
  users: edUsers,
};
const edLessons = {
  modules: [{ id: 1, name: "Week 1" }],
  lessons: [
    { id: 902, module_id: null, title: "Week 10 notes", slide_count: 1, status: "unattempted", state: "active" },
    { id: 900, module_id: 1, title: "Lab prep", slide_count: 4, status: "attempted", state: "active", effective_due_at: "2026-11-05T23:59:00+11:00" },
    { id: 901, module_id: null, title: "Week 2 notes", slide_count: 1, status: "completed", state: "scheduled" },
  ],
};
const edLesson = {
  lesson: {
    id: 900,
    course_id: 500,
    title: "Lab prep",
    status: "attempted",
    slides: [
      {
        id: 9001,
        type: "document",
        title: "Truth table",
        status: "completed",
        content: edDoc(
          '<paragraph>XOR:</paragraph><web-snippet layout="seamless"><web-snippet-file language="html">&lt;table&gt;&lt;tr&gt;&lt;th&gt;Bit A&lt;/th&gt;&lt;th&gt;Bit B&lt;/th&gt;&lt;/tr&gt;&lt;tr&gt;&lt;td&gt;0&lt;/td&gt;&lt;td&gt;1&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</web-snippet-file><web-snippet-file language="css">table { color: red }</web-snippet-file></web-snippet>',
        ),
      },
      { id: 9002, type: "quiz", title: "Check", status: "seen" },
      { id: 9003, type: "code", title: "Decoder", status: "unseen", content: edDoc("<paragraph>Decode the cipher.</paragraph>") },
      { id: 9004, type: "document", title: "Staff only", is_hidden: true, content: edDoc("<paragraph>secret</paragraph>") },
    ],
  },
};
const edQuestions = {
  questions: [
    { index: 1, data: { type: "true-false", content: edDoc("<paragraph>XOR is its own inverse.</paragraph>") } },
    {
      index: 0,
      data: {
        type: "multiple-choice",
        content: edDoc("<paragraph>Which is <bold>not</bold> required?</paragraph>"),
        answers: [edDoc("<paragraph>Yes</paragraph>"), edDoc("<paragraph>No</paragraph>")],
      },
    },
  ],
};

const edServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const raw = await readBody(req);
  const body = raw && req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : raw;
  edLog.push({ method: req.method, path: url.pathname, query: url.searchParams, auth: req.headers.authorization, token: req.headers["x-token"], body });
  const json = (status, data) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (req.method === "POST" && url.pathname === "/api/lti/launch") {
    res.writeHead(302, { location: "/au/courses/500?_logintoken=lt-1" });
    return res.end();
  }
  if (url.pathname === "/au/courses/500") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<html>Ed</html>");
  }
  if (req.method === "POST" && url.pathname === "/api/login_token") {
    if (body?.login_token !== "lt-1") return json(400, { code: "token_invalid" });
    edToken = edJwt({ type: "token", login: ++edLogins, exp: Math.floor(Date.now() / 1000) + 14 * 86_400 });
    return json(200, { token: edToken });
  }
  if (!edToken || req.headers["x-token"] !== edToken || edRejectNext) {
    edRejectNext = false;
    return json(401, { code: "bad_token", message: "Invalid token" });
  }
  const routes = {
    "GET /api/user": () => json(200, edUser),
    "GET /api/courses/500/threads": () => json(200, { sort_key: "", threads: edThreads500, users: [] }),
    "GET /api/courses/501/threads": () => json(200, { sort_key: "", threads: edThreads501, users: [] }),
    "GET /api/courses/500/threads/search": () => json(200, { threads: [edThreads500[1]], total: 7, users: [] }),
    "GET /api/threads/700": () => json(200, edThreadDetail),
    "GET /api/courses/500/threads/12": () => json(200, edThreadDetail),
    "GET /api/courses/500/lessons": () => json(200, edLessons),
    "GET /api/lessons/900": () => json(200, edLesson),
    "GET /api/lessons/slides/9002/questions": () => json(200, edQuestions),
    "POST /api/courses/500/threads": () =>
      json(200, { thread: { ...body.thread, id: 701, number: 13, course_id: 500, approved_status: "approved" } }),
    "POST /api/threads/700/comments": () => json(200, { comment: { id: 850, ...body.comment } }),
    "POST /api/comments/801/comments": () => json(200, { comment: { id: 851, ...body.comment } }),
  };
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) return handler();
  json(404, { code: "not_found", message: "Not found" });
});

// ---------- mock Canvas ----------

const canvasLog = [];
let overrides = [];
let progressPolls = 0;
const canvas = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const raw = await readBody(req);
  const body = raw && req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : undefined;
  canvasLog.push({ method: req.method, path: url.pathname, query: url.searchParams, body });
  const send = (status, data, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(data));
  };
  // The one-time launch link authenticates with its session_token, not the API token, like a browser would.
  if (url.pathname === "/courses/101/external_tools/sessionless_launch") {
    const launchToken = url.searchParams.get("session_token");
    if (!["launch-token", "ed-launch-token"].includes(launchToken) || req.headers.authorization) {
      return send(401, { errors: [{ message: "bad launch" }] });
    }
    if (launchToken === "ed-launch-token") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(
        `<form action="${edOrigin}/api/lti/launch" method="POST">` +
          `<input type="hidden" name="id_token" value="lti.jwt"><input type="hidden" name="state" value="s1">` +
          `</form>`,
      );
    }
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "canvas_session=s1; path=/" });
    return res.end(
      `<form action="${echoOrigin}/lti/launch" method="POST" id="tool_form">` +
        `<input type="hidden" name="oauth_signature" value="sig&#x3D;&#x3D;">` +
        `<input type='hidden' name='context_title' value='Bio &amp; &quot;Life&quot;'>` +
        `</form><script>document.getElementById("tool_form").submit()</script>`,
    );
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(401, { errors: [{ message: "Invalid access token." }] });
  }
  const origin = `http://${req.headers.host}`;
  const file = (id, name, type, blob) => () =>
    send(200, { id, display_name: name, "content-type": type, size: 1000, url: `${origin}/files/${id}/download?verifier=v` });
  const future = new Date(Date.now() + 7 * 86_400_000).toISOString();

  const routes = {
    "GET /api/v1/users/self": () => send(200, { id: "1", name: "Test Student" }),
    "GET /api/v1/users/self/profile": () =>
      send(200, { id: "1", name: "Test Student", primary_email: "s@example.edu", time_zone: "America/New_York" }),
    "GET /api/v1/courses": () =>
      url.searchParams.get("page") === "2"
        ? send(200, [
            { id: "102", name: "History", course_code: "HIST", enrollments: [{ type: "student" }] },
            { id: "103", access_restricted_by_date: true },
          ])
        : send(
            200,
            [
              {
                id: "101",
                name: "Biology",
                course_code: "BIO",
                term: { name: "Fall 2026" },
                enrollments: [{ type: "student", computed_current_score: 91.5, computed_current_grade: "A-" }],
              },
            ],
            { link: `<${origin}/api/v1/courses?page=2&per_page=100>; rel="next", <${origin}/api/v1/courses?page=1>; rel="first"` },
          ),
    "GET /api/v1/courses/101": () =>
      send(200, {
        id: "101",
        name: "Biology",
        apply_assignment_group_weights: true,
        enrollments: [{ type: "student", computed_current_score: 100 }],
      }),
    "GET /api/v1/courses/101/assignment_groups": () =>
      send(200, [
        {
          name: "Assignments",
          group_weight: 40,
          rules: { drop_lowest: 1 },
          assignments: [
            { id: "1", name: "A1", points_possible: 10, submission: { score: 10 } },
            { id: "2", name: "A2", points_possible: 10, submission: { score: 5 } },
            { id: "3", name: "A3", points_possible: 10, submission: { score: null } },
            { id: "4", name: "Practice", points_possible: 10, omit_from_final_grade: true, submission: { score: 0 } },
          ],
        },
        {
          name: "Exam",
          group_weight: 60,
          rules: {},
          assignments: [{ id: "5", name: "Final", points_possible: 100, submission: { score: null } }],
        },
      ]),
    "GET /api/v1/planner/items": () =>
      send(200, [
        {
          plannable_type: "assignment",
          plannable_id: "10",
          plannable: { title: "Lab report", points_possible: 20 },
          context_name: "Biology",
          course_id: "101",
          plannable_date: "2026-11-02T03:59:00Z",
          submissions: { submitted: false, graded: false, missing: false, late: false },
          html_url: "/courses/101/assignments/10",
        },
      ]),
    "GET /api/v1/courses/101/assignments": () =>
      send(200, [
        { id: "10", name: "Lab report", due_at: future },
        { id: "20", name: "Weekly check", is_quiz_lti_assignment: true, due_at: future, points_possible: 5 },
        { id: "21", name: "Quiz 1", quiz_id: "9", submission: { score: 8, workflow_state: "graded" } },
        { id: "11", name: "Group project", group_category_id: "77", due_at: future },
      ]),
    "GET /api/v1/courses/101/assignments/10": () =>
      send(200, {
        id: "10",
        name: "Lab report",
        description: "<p>Write up the <strong>enzyme</strong> lab.</p><script>x()</script><ul><li>2 pages</li></ul>",
        points_possible: 20,
        due_at: future,
        allowed_attempts: -1,
        submission_types: ["online_upload", "online_text_entry"],
        allowed_extensions: ["pdf", "txt"],
        html_url: `${origin}/courses/101/assignments/10`,
        rubric: [
          {
            id: "c1",
            description: "Clarity",
            // Pasted HTML that Canvas escaped again on each save.
            long_description: "Use headings&amp;amp;amp;amp;nbsp;and lists<br/>\r\n<br/>Cite &amp;amp;quot;sources&amp;amp;quot;",
            points: 10,
            ratings: [{ points: 10, description: "Clear", long_description: "No jargon &amp;amp;amp; well structured" }],
          },
        ],
      }),
    "GET /api/v1/courses/101/assignments/10/submissions/self": () =>
      send(200, {
        user_id: "1",
        workflow_state: "graded",
        submission_type: "online_upload",
        score: 18,
        attempt: 2,
        submitted_at: "2026-10-01T00:00:00Z",
        attachments: [
          { id: "800", display_name: "lab.pdf", size: 2048, "content-type": "application/pdf", upload_status: "success" },
        ],
        submission_history: [
          { attempt: 2, submitted_at: "2026-10-01T00:00:00Z", score: 18, attachments: [{ display_name: "lab.pdf" }] },
          { attempt: 1, submitted_at: "2026-09-30T00:00:00Z", attachments: [{ display_name: "draft.pdf" }] },
        ],
        submission_comments: [{ author_name: "Prof", created_at: "2026-10-01T00:00:00Z", comment: "Nice work" }],
        rubric_assessment: { c1: { points: 8, comments: "Mostly clear" } },
      }),
    "POST /api/v1/courses/101/assignments/10/submissions/self/files": () =>
      body.url
        ? send(200, {
            upload_url: `${storageOrigin}/upload-link`,
            upload_params: { key: "link-key", target_url: body.url },
            progress: { id: body.url.includes("broken") ? "2" : "1", workflow_state: "queued" },
          })
        : send(200, { upload_url: `${storageOrigin}/upload`, upload_params: { key: "upload-key" } }),
    "GET /api/v1/progress/1": () =>
      send(200, ++progressPolls % 2 ? { id: "1", workflow_state: "running" } : { id: "1", workflow_state: "completed", results: { id: "901" } }),
    "GET /api/v1/progress/2": () => send(200, { id: "2", workflow_state: "failed", message: "Remote server returned 403" }),
    "GET /api/v1/courses/101/assignments/11": () =>
      send(200, {
        id: "11",
        name: "Group project",
        due_at: future,
        allowed_attempts: -1,
        submission_types: ["online_upload"],
        group_category_id: "77",
        html_url: `${origin}/courses/101/assignments/11`,
      }),
    "GET /api/v1/courses/101/assignments/11/submissions/self": () =>
      send(200, {
        user_id: "1",
        workflow_state: "submitted",
        attempt: 1,
        submitted_at: "2026-10-20T00:00:00Z",
        attachments: [{ id: "950", display_name: "project.zip", size: 5000, upload_status: "success" }],
      }),
    "GET /api/v1/files/950": () => send(200, { id: "950", display_name: "project.zip", user: { id: "4", display_name: "Ash" } }),
    "POST /api/v1/courses/101/assignments/10/submissions": () =>
      send(201, { submitted_at: "2026-10-30T10:00:00Z", attempt: 2, late: false }),
    "GET /api/v1/courses/101/modules": () =>
      send(200, [
        { id: "1", name: "Week 1", items: [{ title: "Intro", type: "Page", page_url: "intro" }] },
        { id: "2", name: "Week 2", items_url: `${origin}/api/v1/courses/101/modules/2/items` },
      ]),
    "GET /api/v1/courses/101/modules/2/items": () =>
      send(200, [{ title: "Slides", type: "File", content_id: "55", completion_requirement: { completed: true } }]),
    "GET /api/v1/courses/101/files": () =>
      send(200, [{ id: "55", display_name: "slides.pdf" }], { link: `<http://evil.example/api/v1/steal>; rel="next"` }),
    "GET /api/v1/files/55": file("55", "slides.pdf", "application/pdf"),
    "GET /api/v1/files/56": file("56", "spec.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    "GET /api/v1/files/57": file("57", "lecture.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    "GET /api/v1/files/58": file("58", "notes.txt", "text/plain"),
    "GET /api/v1/files/59": file("59", "diagram.png", "image/png"),
    "GET /api/v1/files/60": () => send(200, { id: "60", display_name: "locked.pdf", url: "", lock_explanation: "Unlocks Monday" }),
    "GET /api/v1/files/61": file("61", "../../evil:name.txt", "text/plain"),
    "GET /api/v1/calendar_events": () => {
      const codes = url.searchParams.getAll("context_codes[]");
      send(200, codes.slice(0, 1).map((code) => ({ id: code, title: `Event for ${code}`, start_at: "2026-11-03T01:00:00Z" })));
    },
    "GET /api/v1/conversations": () =>
      send(200, [
        {
          id: "300",
          subject: "Extension",
          workflow_state: "unread",
          last_message: "Approved",
          participants: [{ id: "1", name: "Test Student" }, { id: "2", name: "Prof" }],
        },
      ]),
    "GET /api/v1/conversations/300": () =>
      send(200, {
        id: "300",
        subject: "Extension",
        participants: [{ id: "1", name: "Test Student" }, { id: "2", name: "Prof" }],
        messages: [
          { author_id: "2", created_at: "2026-10-02", body: "Approved", attachments: [{ id: "58", display_name: "notes.txt" }] },
          { author_id: "1", created_at: "2026-10-01", body: "Can I have an extension?" },
        ],
      }),
    "POST /api/v1/conversations": () => send(201, [{ id: "301" }]),
    "POST /api/v1/conversations/300/add_message": () => send(201, { id: "300" }),
    "GET /api/v1/users/self/activity_stream": () =>
      send(200, [
        { type: "Announcement", title: "Room change", updated_at: new Date().toISOString(), read_state: false, message: "<p>Now in <b>LT1</b></p>" },
        { type: "Submission", assignment: { name: "Lab report", points_possible: 20 }, score: 18, updated_at: new Date().toISOString(), read_state: true },
        { type: "Message", title: "Old", updated_at: "2020-01-01T00:00:00Z", read_state: false },
      ]),
    "GET /api/v1/courses/101/users": () =>
      send(200, [
        { id: "2", name: "Prof", email: "prof@example.edu", enrollments: [{ type: "TeacherEnrollment" }] },
        { id: "3", name: "Tutor", enrollments: [{ type: "TaEnrollment" }] },
      ]),
    "GET /api/v1/users/self/groups": () =>
      send(200, [
        { id: "7", name: " Team Rocket", course_id: "101", group_category_id: "77", members_count: 2 },
        { id: "8", name: "Old team", course_id: "50", members_count: 3 },
      ]),
    "GET /api/v1/groups/7/users": () => send(200, [{ id: "1", name: "Test Student" }, { id: "4", name: "Ash" }]),
    "GET /api/v1/courses/101/quizzes": () =>
      send(200, [{ id: "9", title: "Quiz 1", assignment_id: "21", time_limit: 30, allowed_attempts: 2, due_at: "2026-10-01T00:00:00Z" }]),
    "GET /api/v1/courses/101/quizzes/9": () => send(200, { id: "9", title: "Quiz 1", description: "<p>Ch. 1-3</p>", hide_results: null }),
    "GET /api/v1/courses/101/quizzes/9/submissions": () =>
      send(200, { quiz_submissions: [{ attempt: 1, score: 8, kept_score: 8, time_spent: 600, workflow_state: "complete" }] }),
    "GET /api/v1/courses/101/discussion_topics/5": () =>
      send(200, { id: "5", title: "Week 3 discussion", html_url: `${origin}/courses/101/discussion_topics/5` }),
    "POST /api/v1/courses/101/discussion_topics/5/entries": () => send(201, { id: "77", created_at: "2026-10-30" }),
    "GET /api/v1/planner/overrides": () => send(200, overrides),
    "POST /api/v1/planner/overrides": () => {
      overrides = [{ id: "500", ...body }];
      send(201, overrides[0]);
    },
    "PUT /api/v1/planner/overrides/500": () => send(200, { id: "500", ...body }),
    "POST /api/v1/planner_notes": () => send(201, { id: "600", ...body }),
    "GET /api/v1/courses/101/tabs": () =>
      send(200, [
        { id: "home", label: "Home", type: "internal" },
        { id: "context_external_tool_7", label: "Zoom", type: "external" },
        { id: "context_external_tool_8", label: "Recorded Lectures", type: "external" },
        { id: "context_external_tool_9", label: "Ed Discussion", type: "external" },
      ]),
    "GET /api/v1/courses/102/tabs": () => send(200, [{ id: "context_external_tool_7", label: "Zoom", type: "external" }]),
    "GET /api/v1/courses/101/external_tools/sessionless_launch": () => {
      const launches = {
        8: { id: "8", name: "Echo360 Cloud", url: `${origin}/courses/101/external_tools/sessionless_launch?session_token=launch-token` },
        9: { id: "9", name: "Ed Discussion", url: `${origin}/courses/101/external_tools/sessionless_launch?session_token=ed-launch-token` },
      };
      send(200, launches[url.searchParams.get("id")] ?? { id: "7", name: "Zoom", url: `${origin}/zoom` });
    },
    "GET /api/v1/courses/102/external_tools/sessionless_launch": () => send(200, { id: "7", name: "Zoom", url: `${origin}/zoom` }),
  };
  if (req.method === "GET" && url.pathname.match(/^\/files\/\d+\/download$/)) {
    const id = url.pathname.split("/")[2];
    const names = { 55: "slides.pdf", 56: "spec.docx", 57: "lecture.pptx", 58: "notes.txt", 59: "diagram.png", 61: "notes.txt" };
    res.writeHead(302, { location: `${storageOrigin}/blob/${names[id]}` });
    return res.end();
  }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) return handler();
  send(404, { errors: [{ message: "The specified resource does not exist." }] });
});

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

// ---------- mock GitHub issues (where report_issue files reports) ----------

const GITHUB_TOKEN = "gh-test-token";
const githubIssue = (fields) => ({
  number: githubIssues.length + 1,
  state: "open",
  state_reason: null,
  comments: 0,
  created_at: new Date().toISOString(),
  ...fields,
  html_url: `https://github.com/test/private/issues/${githubIssues.length + 1}`,
});
const githubIssues = [];
githubIssues.push(
  githubIssue({
    title: "Add a tool to export the whole gradebook as CSV",
    body: "Declined earlier.\n\n<!-- canvas-mcp-report kind=feature -->",
    state: "closed",
    state_reason: "not_planned",
    created_at: "2026-10-01T00:00:00Z",
  }),
);
githubIssues.push(
  githubIssue({ title: "list_modules should show each item's completion requirement", body: "Opened by hand, not a report." }),
);
githubIssues.push(
  githubIssue({ title: "A pull request", body: "<!-- canvas-mcp-report kind=bug tool=get_profile -->", pull_request: {} }),
);
const githubComments = [];

const github = createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${GITHUB_TOKEN}`) return send(401, { message: "Bad credentials" });
  const url = new URL(req.url, "http://github.test");
  const match = url.pathname.match(/^\/repos\/test\/(private|public)(\/.*)?$/);
  if (!match) return send(404, { message: "Not Found" });
  const [, repo, rest = ""] = match;
  if (req.method === "GET" && rest === "") return send(200, { full_name: `test/${repo}`, private: repo === "private" });
  if (req.method === "GET" && rest === "/issues") return send(200, [...githubIssues].reverse());
  if (req.method === "POST" && rest === "/issues") {
    const issue = githubIssue(JSON.parse(await readBody(req)));
    githubIssues.push(issue);
    return send(201, issue);
  }
  const comment = rest.match(/^\/issues\/(\d+)\/comments$/);
  if (req.method === "POST" && comment) {
    const issue = githubIssues.find((i) => i.number === Number(comment[1]));
    issue.comments++;
    githubComments.push({ issue: issue.number, ...JSON.parse(await readBody(req)) });
    return send(201, { id: githubComments.length });
  }
  send(404, { message: "Not Found" });
});

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const baseUrl = await listen(canvas);
const storageOrigin = await listen(storage);
const echoOrigin = await listen(echo);
const edOrigin = await listen(edServer);
const githubOrigin = await listen(github);

// ---------- harness ----------

async function connect(env) {
  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
      env: { ...getDefaultEnvironment(), CANVAS_DOWNLOAD_DIR: downloadDir, ...env },
      stderr: "ignore",
    }),
  );
  return client;
}

const call = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const first = result.content[0].text;
  return { ...result, data: result.isError ? first : JSON.parse(first) };
};

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`ok   ${label}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${label}\n     ${err.message.split("\n").join("\n     ")}`);
  }
}

const lastRequest = (method, path) => canvasLog.filter((r) => r.method === method && r.path === path).at(-1);

// ---------- read-only server ----------

const client = await connect({ CANVAS_BASE_URL: baseUrl, CANVAS_API_TOKEN: TOKEN, CANVAS_ALLOW_WRITES: "" });

await check("lists read tools (plus local download) by default, with string ID schemas", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, READ_TOOLS + LOCAL_TOOLS);
  assert.ok(!tools.some((t) => t.name === "submit_assignment"));
  const getAssignment = tools.find((t) => t.name === "get_assignment");
  assert.equal(getAssignment.inputSchema.properties.course_id.type, "string");
  assert.deepEqual(getAssignment.inputSchema.required.sort(), ["assignment_id", "course_id"]);
  // The download tools write to the user's disk (not to Canvas), so they aren't read-only.
  assert.deepEqual(tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name), [
    "download_files",
    "download_lecture_transcripts",
  ]);
});

await check("get_profile", async () => {
  const { data } = await call(client, "get_profile");
  assert.equal(data.name, "Test Student");
  assert.equal(data.canvas_url, baseUrl);
});

await check("list_courses follows pagination and drops restricted courses", async () => {
  const { data } = await call(client, "list_courses");
  assert.deepEqual(data.map((c) => c.id), ["101", "102"]);
  assert.equal(data[0].current_grade, "A-");
  assert.equal(data[0].term, "Fall 2026");
});

await check("get_planner makes links absolute", async () => {
  const { data } = await call(client, "get_planner", { course_id: 101 });
  assert.equal(data[0].title, "Lab report");
  assert.equal(data[0].url, `${baseUrl}/courses/101/assignments/10`);
  assert.equal(data[0].status.submitted, false);
});

await check("timestamps come back in the user's time zone, with its offset", async () => {
  const { data } = await call(client, "get_planner", { course_id: 101 });
  // 03:59 UTC on 2 Nov is the evening before in New York, which left daylight saving on 1 Nov.
  assert.equal(data[0].due_at, "2026-11-01T22:59:00-05:00");
});

await check("get_planner reads bare dates as whole days in the user's time zone", async () => {
  await call(client, "get_planner", { start_date: "2026-11-03", end_date: "2026-11-05" });
  const req = lastRequest("GET", "/api/v1/planner/items");
  // America/New_York is UTC-5 after DST ends on 2026-11-01; the end date is inclusive.
  assert.equal(req.query.get("start_date"), "2026-11-03T05:00:00.000Z");
  assert.equal(req.query.get("end_date"), "2026-11-06T05:00:00.000Z");
});

await check("get_assignment converts HTML and merges rubric marks", async () => {
  const { data } = await call(client, "get_assignment", { course_id: "101", assignment_id: 10 });
  assert.match(data.description, /Write up the \*\*enzyme\*\* lab\./);
  assert.doesNotMatch(data.description, /x\(\)/);
  assert.equal(data.allowed_attempts, "unlimited");
  assert.equal(data.rubric[0].your_points, 8);
  assert.equal(data.submission.score, 18);
  assert.equal(data.submission.comments[0].comment, "Nice work");
  assert.equal(data.submission.files[0].name, "lab.pdf");
  assert.equal(data.group, undefined);
});

await check("get_assignment undoes repeated escaping in rubric text", async () => {
  const { data } = await call(client, "get_assignment", { course_id: "101", assignment_id: "10" });
  assert.equal(data.rubric[0].details, 'Use headings and lists\n\nCite "sources"');
  assert.deepEqual(data.rubric[0].ratings, ["10 pts: Clear (No jargon & well structured)"]);
});

await check("get_submission: status, files, attempt history and comments without the brief", async () => {
  const { data } = await call(client, "get_submission", { course_id: "101", assignment_id: "10" });
  assert.equal(data.assignment, "Lab report");
  assert.equal(data.description, undefined);
  assert.equal(data.submitted_at, "2026-09-30T20:00:00-04:00");
  assert.deepEqual(data.files, [
    { file_id: "800", name: "lab.pdf", size: 2048, type: "application/pdf", upload_status: "success" },
  ]);
  assert.deepEqual(data.history.map((h) => [h.attempt, h.files[0]]), [[1, "draft.pdf"], [2, "lab.pdf"]]);
  assert.equal(data.attempts_allowed, "unlimited");
  assert.equal(data.comments[0].comment, "Nice work");
  assert.deepEqual(lastRequest("GET", "/api/v1/courses/101/assignments/10/submissions/self").query.getAll("include[]"), [
    "submission_history",
    "submission_comments",
  ]);
});

await check("get_submission: group assignments name the group and who uploaded the files", async () => {
  const { data } = await call(client, "get_submission", { course_id: "101", assignment_id: "11" });
  assert.equal(data.group.name, "Team Rocket");
  assert.match(data.group.note, /whole group/);
  assert.equal(data.uploaded_by, "Ash");
  assert.deepEqual(lastRequest("GET", "/api/v1/files/950").query.getAll("include[]"), ["user"]);
  const assignment = await call(client, "get_assignment", { course_id: "101", assignment_id: "11" });
  assert.equal(assignment.data.group.name, "Team Rocket");
  const list = await call(client, "list_assignments", { course_id: "101" });
  assert.deepEqual(list.data.filter((a) => a.group_assignment).map((a) => a.id), ["11"]);
});

await check("list_modules fetches items_url for large modules", async () => {
  const { data } = await call(client, "list_modules", { course_id: "101" });
  assert.equal(data[1].items[0].title, "Slides");
  assert.equal(data[1].items[0].completed, true);
});

await check("refuses to follow pagination to another host", async () => {
  const result = await call(client, "list_files", { course_id: "101" });
  assert.equal(result.isError, true);
  assert.match(result.data, /Refusing to send the Canvas token to http:\/\/evil\.example/);
});

await check("canvas_api_get rejects paths outside /api/v1", async () => {
  const result = await call(client, "canvas_api_get", { path: "../../login" });
  assert.equal(result.isError, true);
  assert.match(result.data, /inside \/api\/v1/);
});

await check("404s come back as readable tool errors", async () => {
  const result = await call(client, "get_syllabus", { course_id: "999" });
  assert.equal(result.isError, true);
  assert.match(result.data, /Canvas API 404 .*does not exist/);
});

await check("read_file: PDF text by page, token never sent to the storage host", async () => {
  storageLog.length = 0;
  const { data } = await call(client, "read_file", { file_id: "55" });
  assert.equal(data.format, "pdf");
  assert.equal(data.sections, 2);
  assert.match(data.text, /--- Page 1 ---\nWeek 3 Linear Models/);
  assert.match(data.text, /--- Page 2 ---\nAssumptions and residuals/);
  assert.equal(storageLog.length, 1);
  assert.equal(storageLog[0].auth, undefined);
});

await check("read_file: Word headings, lists and entities", async () => {
  const { data } = await call(client, "read_file", { file_id: "56" });
  assert.equal(data.text, "# Lab Spec\nMeasure the enzyme & record\n- Step one");
});

await check("read_file: PowerPoint slides in numeric order with speaker notes", async () => {
  const { data } = await call(client, "read_file", { file_id: "57" });
  assert.deepEqual([...data.text.matchAll(/--- (Slide \d+) ---/g)].map((m) => m[1]), ["Slide 1", "Slide 2", "Slide 10"]);
  assert.match(data.text, /Intro to Regression\n\nSpeaker notes:\nRemember the assumptions\n/);
});

await check("read_file: long text is paged with next_offset", async () => {
  const first = await call(client, "read_file", { file_id: "58", max_chars: 1000 });
  assert.equal(first.data.text.length, 1000);
  assert.equal(first.data.next_offset, 1000);
  const second = await call(client, "read_file", { file_id: "58", offset: 1000, max_chars: 1000 });
  assert.equal(second.data.text, longText.slice(1000, 2000));
});

await check("read_file: images come back as image content", async () => {
  const result = await client.callTool({ name: "read_file", arguments: { file_id: "59" } });
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].mimeType, "image/png");
});

await check("read_file: locked files explain why", async () => {
  const result = await call(client, "read_file", { file_id: "60" });
  assert.equal(result.isError, true);
  assert.match(result.data, /Unlocks Monday/);
});

await check("download_files: saves the original bytes, token never sent to the storage host", async () => {
  storageLog.length = 0;
  const { data } = await call(client, "download_files", { file_ids: ["55", "56"] });
  assert.equal(data.directory, downloadDir);
  assert.equal(data.saved, 2);
  assert.deepEqual(data.files.map((f) => f.path), [join(downloadDir, "slides.pdf"), join(downloadDir, "spec.docx")]);
  assert.deepEqual(await readFile(join(downloadDir, "slides.pdf")), storageFiles["/blob/slides.pdf"]);
  assert.deepEqual(await readFile(join(downloadDir, "spec.docx")), storageFiles["/blob/spec.docx"]);
  assert.equal(data.files[0].size, storageFiles["/blob/slides.pdf"].length);
  assert.ok(storageLog.every((r) => r.auth === undefined));
});

await check("download_files: never overwrites, and numbers duplicates within a batch", async () => {
  const { data } = await call(client, "download_files", { file_ids: ["55", 55] });
  assert.deepEqual(data.files.map((f) => f.name && f.path.slice(downloadDir.length + 1)), ["slides (1).pdf", "slides (2).pdf"]);
  assert.deepEqual(await readFile(join(downloadDir, "slides.pdf")), storageFiles["/blob/slides.pdf"]);
});

await check("download_files: unsafe names stay inside the folder; relative folders nest under the default", async () => {
  const { data } = await call(client, "download_files", { file_ids: ["61"], directory: "week3" });
  assert.equal(data.files[0].path, join(downloadDir, "week3", ".._.._evil_name.txt"));
  assert.deepEqual(await readdir(join(downloadDir, "week3")), [".._.._evil_name.txt"]);
});

await check("download_files: one failure doesn't stop the rest, and leaves no partial files", async () => {
  const { data } = await call(client, "download_files", { file_ids: ["60", "404", "58"] });
  assert.equal(data.saved, 1);
  assert.match(data.files[0].error, /Unlocks Monday/);
  assert.match(data.files[1].error, /404/);
  assert.equal(data.files[2].path, join(downloadDir, "notes.txt"));
  assert.ok(!(await readdir(downloadDir)).some((f) => f.endsWith(".part")));
});

await check("list_calendar_events batches context codes in tens", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => String(200 + i));
  const before = canvasLog.length;
  const { data } = await call(client, "list_calendar_events", { course_ids: ids });
  const requests = canvasLog.slice(before).filter((r) => r.path === "/api/v1/calendar_events");
  assert.deepEqual(requests.map((r) => r.query.getAll("context_codes[]").length), [10, 2]);
  assert.equal(data.length, 2);
});

await check("list_calendar_events includes the user's own calendar by default", async () => {
  await call(client, "list_calendar_events");
  const codes = lastRequest("GET", "/api/v1/calendar_events").query.getAll("context_codes[]");
  assert.deepEqual(codes, ["course_101", "course_102", "user_1"]);
});

await check("conversations: listed and read oldest-first without marking read", async () => {
  const list = await call(client, "list_conversations");
  assert.equal(list.data[0].unread, true);
  const { data } = await call(client, "get_conversation", { conversation_id: "300" });
  assert.equal(lastRequest("GET", "/api/v1/conversations/300").query.get("auto_mark_as_read"), "false");
  assert.deepEqual(data.messages.map((m) => m.author), ["Test Student", "Prof"]);
  assert.equal(data.messages[1].attachments[0].file_id, "58");
});

await check("get_recent_activity filters by age and keeps submission scores", async () => {
  const { data } = await call(client, "get_recent_activity", { days: 7 });
  assert.deepEqual(data.map((d) => d.type), ["Announcement", "Submission"]);
  assert.equal(data[0].summary, "Now in **LT1**");
  assert.equal(data[1].score, 18);
  const unread = await call(client, "get_recent_activity", { unread_only: true });
  assert.deepEqual(unread.data.map((d) => d.type), ["Announcement"]);
});

await check("list_course_people defaults to teaching staff", async () => {
  const { data } = await call(client, "list_course_people", { course_id: "101" });
  assert.deepEqual(lastRequest("GET", "/api/v1/courses/101/users").query.getAll("enrollment_type[]"), ["teacher", "ta"]);
  assert.deepEqual(data.map((p) => p.roles[0]), ["Teacher", "Ta"]);
});

await check("list_my_groups: current courses only, trimmed names, with members", async () => {
  const { data } = await call(client, "list_my_groups");
  assert.deepEqual(data.map((g) => g.name), ["Team Rocket"]);
  assert.deepEqual(data[0].members.map((m) => m.name), ["Test Student", "Ash"]);
  const all = await call(client, "list_my_groups", { include_past: true });
  assert.equal(all.data.length, 2);
  const one = await call(client, "list_my_groups", { course_id: "50" });
  assert.deepEqual(one.data.map((g) => g.name), ["Old team"]);
});

await check("calculate_grade: weights, drop rules, projections and target", async () => {
  const { data } = await call(client, "calculate_grade", { course_id: "101", target_percent: 85 });
  // Current: A2 is dropped as the lowest, so Assignments = 100%; Exam has nothing graded yet.
  assert.equal(data.current_percent, 100);
  // Remaining all zero: A3 (0%) dropped, Assignments = 15/20 = 75% → 0.4 × 75 = 30.
  assert.equal(data.final_if_remaining_scores_zero, 30);
  assert.equal(data.final_if_remaining_scores_full, 100);
  // 0.4 × (50 + 50p) + 60p = 85 → p = 81.25%.
  assert.equal(data.target.status, "achievable");
  assert.equal(data.target.average_needed_on_remaining, 81.25);
  assert.equal(data.remaining_work.length, 2);
  assert.ok(!JSON.stringify(data).includes("Practice"));
});

await check("calculate_grade: what-if scores and assessment outside Canvas", async () => {
  const { data } = await call(client, "calculate_grade", {
    course_id: "101",
    what_if: [{ assignment_id: "5", percent: 50 }],
    outside_weight_percent: 50,
  });
  // Assignments 100%, Exam 50% → 0.4 × 100 + 0.6 × 50 = 70 in Canvas.
  assert.equal(data.current_percent, 70);
  assert.deepEqual(data.what_if_applied, ["Final: 50/100"]);
  // A3 at 0% leaves Assignments at 75%, so Canvas totals 0.4 × 75 + 0.6 × 50 = 60;
  // half the mark is outside Canvas and also scores 0: 0.5 × 60 + 0.5 × 0 = 30.
  assert.equal(data.final_if_remaining_scores_zero, 30);
});

await check("list_quizzes merges Classic and New Quizzes with scores", async () => {
  const { data } = await call(client, "list_quizzes", { course_id: "101" });
  assert.deepEqual(data.map((q) => q.kind), ["classic", "new_quizzes"]);
  assert.equal(data[0].submission.score, 8);
  const quiz = await call(client, "get_quiz", { course_id: "101", quiz_id: "9" });
  assert.equal(quiz.data.attempts[0].minutes_spent, 10);
  assert.equal(quiz.data.results_visible, "always");
});

const launchRequests = () => canvasLog.filter((r) => r.path === "/api/v1/courses/101/external_tools/sessionless_launch");

await check("list_lecture_recordings: launches Echo360 through Canvas, flattens folders, skips unrecorded", async () => {
  const { data } = await call(client, "list_lecture_recordings", { course_id: "101" });
  assert.equal(data.source, "Echo360 Cloud");
  assert.deepEqual(data.recordings, [
    { recording_id: "m1", title: "Week 3 Lecture", date: "2026-08-19T22:05:00-04:00" },
    { recording_id: "m2", title: "V01: Intro", group: "Module 1", date: "2026-07-31T20:00:00-04:00" },
  ]);
  // The "Recorded Lectures" tab is tried before Zoom, so Zoom is never launched.
  assert.deepEqual(launchRequests().map((r) => r.query.get("id")), ["8"]);
  const ltiPost = echoLog.find((r) => r.path === "/lti/launch");
  assert.equal(new URLSearchParams(ltiPost.body).get("oauth_signature"), "sig==");
  assert.equal(new URLSearchParams(ltiPost.body).get("context_title"), 'Bio & "Life"');
  assert.ok(echoLog.every((r) => r.auth === undefined), "the Canvas token must never reach Echo360");
});

await check("get_lecture_transcript: plain text with a timestamp about once a minute", async () => {
  const { data } = await call(client, "get_lecture_transcript", { course_id: "101", recording_id: "m1" });
  assert.equal(data.text, "[0:01] Welcome to week three. Today: residuals & <outliers>.\n\n[1:02] Any questions?");
  assert.equal(data.duration, "1:05");
  assert.match(data.note, /speech-recognition/);
  const paged = await call(client, "get_lecture_transcript", { course_id: "101", recording_id: "m1", max_chars: 1000, offset: 70 });
  assert.equal(paged.data.text, data.text.slice(70));
});

await check("get_lecture_transcript: SRT and WebVTT subtitles", async () => {
  const srt = await call(client, "get_lecture_transcript", { course_id: "101", recording_id: "m1", format: "srt" });
  assert.equal(
    srt.data.text,
    "1\n00:00:01,000 --> 00:00:03,500\nWelcome to week three.\n\n" +
      "2\n00:00:03,500 --> 00:01:02,000\nToday: residuals & <outliers>.\n\n" +
      "3\n00:01:02,000 --> 00:01:05,000\nAny questions?\n",
  );
  const vtt = await call(client, "get_lecture_transcript", { course_id: "101", recording_id: "m1", format: "vtt" });
  assert.match(vtt.data.text, /^WEBVTT\n\n00:00:01\.000 --> 00:00:03\.500\nWelcome to week three\.\n\n/);
  assert.match(vtt.data.text, /residuals &amp; &lt;outliers>\./);
});

await check("get_lecture_transcript: missing transcripts and unknown IDs explain themselves", async () => {
  const none = await call(client, "get_lecture_transcript", { course_id: "101", recording_id: "m2" });
  assert.equal(none.isError, true);
  assert.match(none.data, /"V01: Intro" has no transcript/);
  const unknown = await call(client, "get_lecture_transcript", { course_id: "101", recording_id: "m9" });
  assert.match(unknown.data, /No recording m9 .*list_lecture_recordings/);
});

await check("list_lecture_recordings: a course without Echo360 says so", async () => {
  const result = await call(client, "list_lecture_recordings", { course_id: "102" });
  assert.equal(result.isError, true);
  assert.match(result.data, /no Echo360/);
});

await check("download_lecture_transcripts: saves subtitle files, reports failures, reuses one Echo360 session", async () => {
  const { data } = await call(client, "download_lecture_transcripts", { course_id: "101", format: "vtt" });
  const dir = join(downloadDir, "Biology transcripts");
  assert.equal(data.directory, dir);
  assert.equal(data.saved, 1);
  assert.equal(data.files[0].path, join(dir, "Week 3 Lecture.vtt"));
  assert.match(await readFile(data.files[0].path, "utf8"), /^WEBVTT\n\n00:00:01\.000 --> /);
  assert.match(data.files[1].error, /no transcript/);
  const again = await call(client, "download_lecture_transcripts", { course_id: "101", recording_ids: ["m1", "nope"] });
  assert.equal(again.data.files[0].path, join(dir, "Week 3 Lecture.srt"));
  assert.equal(again.data.files[1].error, "not found in this course");
  assert.equal(echoLog.filter((r) => r.path === "/lti/launch").length, 1, "one LTI launch serves every call");
});

const edRequests = (path) => edLog.filter((r) => r.path === path);

await check("ed_list_courses: signs in to Ed through Canvas's Ed tab; active courses, most recent first", async () => {
  const { data } = await call(client, "ed_list_courses");
  assert.deepEqual(data.map((c) => c.ed_course_id), ["500", "501"]);
  assert.deepEqual(data[0], {
    ed_course_id: "500",
    code: "BIO1001",
    name: "BIO1001 course",
    session: "Semester 2 2026",
    role: "student",
    last_active: "2026-10-29T19:00:00-04:00",
    categories: ["General", "Labs (Lab 1, Lab 2)"],
    url: `${edOrigin}/au/courses/500/discussion`,
  });
  // The Ed tab is the only one launched for Ed, and the one-time login token is traded for an API token.
  assert.ok(launchRequests().some((r) => r.query.get("id") === "9"));
  assert.equal(new URLSearchParams(edRequests("/api/lti/launch")[0].body).get("id_token"), "lti.jwt");
  assert.deepEqual(edRequests("/api/login_token")[0].body, { login_token: "lt-1" });
  assert.equal(edLogins, 1);
  assert.ok(edLog.every((r) => r.auth === undefined), "the Canvas token must never reach Ed");
  const all = await call(client, "ed_list_courses", { include_archived: true });
  assert.deepEqual(all.data.map((c) => c.ed_course_id), ["500", "501", "400"]);
  assert.equal(all.data[2].status, "archived");
});

await check("ed_list_threads: one course, with Ed's filter names, authors and unread flags", async () => {
  const { data } = await call(client, "ed_list_threads", { ed_course_id: "500", filter: "new_replies", limit: 2 });
  const query = edRequests("/api/courses/500/threads").at(-1).query;
  assert.equal(query.get("filter"), "new");
  assert.equal(query.get("sort"), "new");
  assert.equal(query.get("limit"), "2");
  assert.equal(data.next_offset, 2);
  const [first, second] = data.threads;
  assert.equal(first.thread_id, 700);
  assert.equal(first.author, "Dr Tutor (staff)");
  assert.equal(first.category, "Labs › Lab 1");
  assert.equal(first.created_at, "2026-10-29T18:00:00-04:00");
  assert.equal(first.unread, true);
  assert.equal(first.answered, "by staff");
  assert.ok(first.preview.endsWith("…") && first.preview.length <= 201, first.preview);
  assert.equal(first.url, `${edOrigin}/au/courses/500/discussion/700`);
  assert.equal(second.author, "Anonymous");
  assert.equal(second.new_replies, 2);
  assert.equal(second.answered, undefined);
});

await check("ed_list_threads: a query goes to Ed's search, ranked by relevance", async () => {
  const { data } = await call(client, "ed_list_threads", { ed_course_id: "500", query: " lab " });
  const query = edRequests("/api/courses/500/threads/search").at(-1).query;
  assert.equal(query.get("query"), "lab");
  assert.equal(query.get("sort"), null);
  assert.equal(data.total, 7);
  assert.equal(data.threads[0].thread_id, 710);
});

await check("ed_list_threads: without a course, every active Ed course, newest first", async () => {
  const { data } = await call(client, "ed_list_threads", { filter: "unread" });
  assert.equal(data.courses, 2);
  assert.deepEqual(data.threads.map((t) => t.thread_id), [700, 720, 710]);
  assert.equal(data.threads[1].course, "CHEM1001");
  assert.equal(edRequests("/api/courses/400/threads").length, 0, "archived courses are skipped");
});

await check("ed_get_thread: the post as Markdown, accepted answer first, nested replies", async () => {
  const { data } = await call(client, "ed_get_thread", { thread_id: "700" });
  assert.equal(data.title, "Is the lab report due Friday?");
  assert.equal(data.author, "Test Student");
  assert.equal(data.views, 40);
  for (const part of [
    "Is the **lab report** due _Friday_? See [the spec](https://example.com/a?b=1&c=2).",
    "1.  Intro\n2.  Method",
    '```py\nprint("hi")\nx = 1 < 2\n```',
    "![image](https://static.example/img.png)",
    "Attachment: [spec.pdf](https://static.example/spec.pdf)",
    "Ratio `x_1/2`",
    "| Week | Room |\n| --- | --- |\n| 1 | A\\|B |",
  ]) {
    assert.ok(data.body.includes(part), `missing ${JSON.stringify(part)} in:\n${data.body}`);
  }
  assert.doesNotMatch(data.body, /#.*Ratio/, "an empty <heading/> must not swallow what follows");
  assert.equal(data.total_replies, 3);
  const [accepted, endorsed, privateComment] = data.replies;
  assert.deepEqual([accepted.comment_id, accepted.accepted, accepted.author], [803, true, "Sam Mentor (mentor)"]);
  assert.equal(endorsed.endorsed, true);
  assert.equal(endorsed.created_at, "2026-10-29T18:30:00-04:00");
  assert.equal(endorsed.replies[0].author, "Anonymous");
  assert.equal(endorsed.replies[0].body, "Thanks");
  assert.deepEqual([privateComment.type, privateComment.private], ["comment", true]);
});

await check("ed_get_thread: by course and number, paged", async () => {
  const { data } = await call(client, "ed_get_thread", { ed_course_id: "500", number: 12, offset: 1, limit: 1 });
  assert.equal(edRequests("/api/courses/500/threads/12").length, 1);
  assert.deepEqual(data.replies.map((r) => r.comment_id), [801]);
  assert.equal(data.offset, 1);
  assert.equal(data.next_offset, 2);
});

await check("ed tools refuse IDs that aren't numbers", async () => {
  const result = await call(client, "ed_get_thread", { thread_id: "../user" });
  assert.equal(result.isError, true);
  assert.match(result.data, /thread_id must be a number/);
});

await check("ed_list_lessons: grouped by module, the rest in title order", async () => {
  const { data } = await call(client, "ed_list_lessons", { ed_course_id: "500" });
  assert.equal(data.count, 3);
  assert.equal(data.modules[0].module, "Week 1");
  assert.deepEqual(data.modules[0].lessons[0], {
    lesson_id: 900,
    title: "Lab prep",
    slides: 4,
    status: "attempted",
    due_at: "2026-11-05T07:59:00-05:00",
    url: `${edOrigin}/au/courses/500/lessons/900`,
  });
  assert.deepEqual(data.other_lessons.map((l) => l.title), ["Week 2 notes", "Week 10 notes"]);
  assert.equal(data.other_lessons[0].state, "scheduled");
});

await check("ed_get_lesson: slides as Markdown, quiz questions with options, hidden slides left out", async () => {
  const { data } = await call(client, "ed_get_lesson", { lesson_id: "900" });
  assert.equal(data.slides, 3);
  for (const part of [
    "## 1. Truth table (document, completed)\n\nXOR:\n\n| Bit A | Bit B |\n| --- | --- |\n| 0 | 1 |",
    "## 2. Check (quiz, seen)\n\n**Question 1** (multiple-choice)\n\nWhich is **not** required?\n\n- A. Yes\n- B. No\n\n**Question 2** (true-false)",
    "## 3. Decoder (code, unseen)\n\nDecode the cipher.\n\n(Coding challenge: write and run the code in Ed.)",
  ]) {
    assert.ok(data.text.includes(part), `missing ${JSON.stringify(part)} in:\n${data.text}`);
  }
  assert.doesNotMatch(data.text, /color: red|secret|Staff only/);
  assert.equal(data.next_offset, undefined);
  const paged = await call(client, "ed_get_lesson", { lesson_id: "900", offset: 20, max_chars: 1000 });
  assert.equal(paged.data.text, data.text.slice(20, 1020));
});

await check("Ed: a rejected token signs in again once, without the caller noticing", async () => {
  assert.equal(edLogins, 1, "one sign-in serves every call");
  edRejectNext = true;
  const { data, isError } = await call(client, "ed_list_courses");
  assert.ok(!isError, data);
  assert.equal(edLogins, 2);
});

await client.close();

const badToken = await connect({ CANVAS_BASE_URL: baseUrl, CANVAS_API_TOKEN: "wrong" });
await check("bad token gives a 401 hint", async () => {
  const result = await call(badToken, "get_profile");
  assert.equal(result.isError, true);
  assert.match(result.data, /401.*Invalid access token.*invalid or expired/);
});
await badToken.close();

const unconfigured = await connect({ CANVAS_BASE_URL: "", CANVAS_API_TOKEN: "" });
await check("unconfigured server still starts and explains setup", async () => {
  const result = await call(unconfigured, "list_courses");
  assert.equal(result.isError, true);
  assert.match(result.data, /CANVAS_BASE_URL/);
});
await unconfigured.close();

// ---------- write tools ----------

const writer = await connect({ CANVAS_BASE_URL: baseUrl, CANVAS_API_TOKEN: TOKEN, CANVAS_ALLOW_WRITES: "true" });
const posts = (path) => canvasLog.filter((r) => r.method === "POST" && r.path === path);
const SUBMIT = "/api/v1/courses/101/assignments/10/submissions";

await check("writes: tools appear only when enabled, marked as not read-only", async () => {
  const { tools } = await writer.listTools();
  assert.equal(tools.length, READ_TOOLS + LOCAL_TOOLS + WRITE_TOOLS);
  assert.equal(tools.find((t) => t.name === "submit_assignment").annotations.destructiveHint, true);
});

await check("submit_assignment: preview submits nothing", async () => {
  const before = posts(SUBMIT).length;
  const { data } = await call(writer, "submit_assignment", {
    course_id: "101",
    assignment_id: "10",
    files: [{ name: "report.txt", text: "My report" }],
  });
  assert.match(data.status, /PREVIEW/);
  assert.equal(data.attempt, "3 of unlimited");
  assert.equal(data.replaces_existing_submission.score, 18);
  assert.equal(posts(SUBMIT).length, before);
  assert.equal(posts(`${SUBMIT}/self/files`).length, 0);
});

await check("submit_assignment: rejects types and extensions the assignment doesn't accept", async () => {
  const wrongExt = await call(writer, "submit_assignment", {
    course_id: "101",
    assignment_id: "10",
    files: [{ name: "report.docx", base64: "AAAA" }],
  });
  assert.equal(wrongExt.isError, true);
  assert.match(wrongExt.data, /only \.pdf, \.txt files are accepted/);
  const wrongType = await call(writer, "submit_assignment", { course_id: "101", assignment_id: "10", url: "https://x.example" });
  assert.match(wrongType.data, /doesn't accept online_url/);
});

await check("submit_assignment: confirmed upload goes to storage without the token", async () => {
  storageLog.length = 0;
  const { data } = await call(writer, "submit_assignment", {
    course_id: "101",
    assignment_id: "10",
    files: [{ name: "report.txt", text: "My report" }],
    comment: "Thanks!",
    confirm: true,
  });
  assert.equal(data.status, "SUBMITTED");
  const upload = storageLog.find((r) => r.path === "/upload");
  assert.equal(upload.auth, undefined);
  assert.match(upload.body, /upload-key[\s\S]*filename="report.txt"[\s\S]*My report/);
  assert.deepEqual(posts(`${SUBMIT}/self/files`).at(-1).body, {
    name: "report.txt",
    size: 9,
    content_type: "text/plain",
    on_duplicate: "rename",
  });
  assert.deepEqual(posts(SUBMIT).at(-1).body, {
    submission: { submission_type: "online_upload", file_ids: ["900"] },
    comment: { text_comment: "Thanks!" },
  });
});

await check("submit_assignment: text entry becomes HTML paragraphs", async () => {
  await call(writer, "submit_assignment", {
    course_id: "101",
    assignment_id: "10",
    text: "Para <one>\nline two\n\nPara two",
    confirm: true,
  });
  assert.equal(posts(SUBMIT).at(-1).body.submission.body, "<p>Para &lt;one&gt;<br>line two</p>\n<p>Para two</p>");
});

await check("share links become direct downloads", async () => {
  assert.equal(
    directDownloadUrl("https://drive.google.com/file/d/AbC_12-3/view?usp=sharing").toString(),
    "https://drive.usercontent.google.com/download?id=AbC_12-3&export=download&confirm=t",
  );
  assert.equal(
    directDownloadUrl("https://drive.google.com/open?id=XyZ").toString(),
    "https://drive.usercontent.google.com/download?id=XyZ&export=download&confirm=t",
  );
  assert.equal(
    directDownloadUrl("https://www.dropbox.com/scl/fi/abc/report.zip?rlkey=k&dl=0").toString(),
    "https://www.dropbox.com/scl/fi/abc/report.zip?rlkey=k&dl=1",
  );
  assert.equal(directDownloadUrl("https://example.com/a.zip").toString(), "https://example.com/a.zip");
});

await check("submit_assignment: link preview checks the file without uploading anything", async () => {
  const before = posts(`${SUBMIT}/self/files`).length;
  const { data } = await call(writer, "submit_assignment", {
    course_id: "101",
    assignment_id: "10",
    files: [{ url: `${storageOrigin}/download?id=abc` }],
  });
  assert.match(data.status, /PREVIEW/);
  const host = new URL(storageOrigin).host;
  assert.deepEqual(data.files, [`lab report.pdf (application/pdf, 173,000,000 bytes, Canvas will download it from ${host})`]);
  assert.equal(posts(`${SUBMIT}/self/files`).length, before);
});

await check("submit_assignment: a link that opens a web page is refused", async () => {
  const result = await call(writer, "submit_assignment", {
    course_id: "101",
    assignment_id: "10",
    files: [{ url: `${storageOrigin}/page`, name: "report.pdf" }],
  });
  assert.equal(result.isError, true);
  assert.match(result.data, /opens a web page, not the file/);
});

await check("submit_assignment: confirmed link upload has Canvas download it, waits, then submits", async () => {
  storageLog.length = 0;
  const link = `${storageOrigin}/blob/slides.pdf`;
  const { data } = await call(writer, "submit_assignment", {
    course_id: "101",
    assignment_id: "10",
    files: [{ url: link }],
    confirm: true,
  });
  assert.equal(data.status, "SUBMITTED");
  assert.deepEqual(posts(`${SUBMIT}/self/files`).at(-1).body, {
    url: link,
    name: "slides.pdf",
    size: storageFiles["/blob/slides.pdf"].length,
    content_type: "application/pdf",
    on_duplicate: "rename",
    submit_assignment: false,
  });
  const start = storageLog.find((r) => r.path === "/upload-link");
  assert.equal(start.auth, undefined);
  assert.match(start.body, /link-key/);
  assert.doesNotMatch(start.body, /filename=/);
  assert.ok(canvasLog.filter((r) => r.path === "/api/v1/progress/1").length >= 2, "polls until completed");
  assert.deepEqual(posts(SUBMIT).at(-1).body.submission.file_ids, ["901"]);
});

await check("submit_assignment: a failed link download submits nothing", async () => {
  const before = posts(SUBMIT).length;
  const result = await call(writer, "submit_assignment", {
    course_id: "101",
    assignment_id: "10",
    files: [{ url: `${storageOrigin}/blob/notes.txt?broken=1` }],
    confirm: true,
  });
  assert.equal(result.isError, true);
  assert.match(result.data, /couldn't download notes\.txt: Remote server returned 403/);
  assert.equal(posts(SUBMIT).length, before);
});

await check("submit_assignment: an existing Canvas file is submitted by ID without re-uploading", async () => {
  const preview = await call(writer, "submit_assignment", { course_id: "101", assignment_id: "10", files: [{ file_id: 58 }] });
  assert.deepEqual(preview.data.files, ["notes.txt (text/plain, 1,000 bytes, Canvas file 58)"]);
  const uploads = posts(`${SUBMIT}/self/files`).length;
  await call(writer, "submit_assignment", { course_id: "101", assignment_id: "10", files: [{ file_id: "58" }], confirm: true });
  assert.deepEqual(posts(SUBMIT).at(-1).body.submission.file_ids, ["58"]);
  assert.equal(posts(`${SUBMIT}/self/files`).length, uploads);
});

await check("submit_assignment: group preview names the group and the teammate's submission it replaces", async () => {
  const { data } = await call(writer, "submit_assignment", {
    course_id: "101",
    assignment_id: "11",
    files: [{ name: "v2.zip", base64: "UEsDBA==" }],
  });
  assert.match(data.status, /PREVIEW/);
  assert.equal(data.group.name, "Team Rocket");
  assert.deepEqual(data.replaces_existing_submission.files, ["project.zip"]);
  assert.equal(data.replaces_existing_submission.uploaded_by, "Ash");
});

await check("submit_assignment: each file needs exactly one source", async () => {
  const result = await call(writer, "submit_assignment", {
    course_id: "101",
    assignment_id: "10",
    files: [{ name: "a.txt", text: "x", file_id: "58" }],
  });
  assert.match(result.data, /exactly one of text, base64, url, file_id or path/);
});

await check("submit_assignment: the local server can upload a file from disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canvas-mcp-"));
  try {
    const path = join(dir, "final.pdf");
    await writeFile(path, makePdf(["Final"]));
    const { data } = await call(writer, "submit_assignment", { course_id: "101", assignment_id: "10", files: [{ path }] });
    assert.match(data.files[0], /^final\.pdf \(application\/pdf/);
  } finally {
    await rm(dir, { recursive: true });
  }
});

await check("post_discussion_reply: preview then post", async () => {
  const preview = await call(writer, "post_discussion_reply", { course_id: "101", topic_id: "5", message: "Great point" });
  assert.match(preview.data.status, /PREVIEW/);
  assert.equal(posts("/api/v1/courses/101/discussion_topics/5/entries").length, 0);
  const { data } = await call(writer, "post_discussion_reply", {
    course_id: "101",
    topic_id: "5",
    message: "Great point",
    confirm: true,
  });
  assert.equal(data.entry_id, "77");
  assert.equal(posts("/api/v1/courses/101/discussion_topics/5/entries").at(-1).body.message, "<p>Great point</p>");
});

await check("send_message: preview names recipients, then sends", async () => {
  const args = { recipient_ids: ["2"], course_id: "101", subject: "Question", body: "Hi Prof" };
  const preview = await call(writer, "send_message", args);
  assert.deepEqual(preview.data.to, ["Prof"]);
  assert.equal(posts("/api/v1/conversations").length, 0);
  const { data } = await call(writer, "send_message", { ...args, confirm: true });
  assert.deepEqual(data.conversation_ids, ["301"]);
  assert.equal(posts("/api/v1/conversations").at(-1).body.context_code, "course_101");
  await call(writer, "send_message", { conversation_id: "300", body: "Thanks", confirm: true });
  assert.equal(posts("/api/v1/conversations/300/add_message").at(-1).body.body, "Thanks");
});

await check("set_planner_item_done creates, then updates, the override", async () => {
  const first = await call(writer, "set_planner_item_done", { plannable_type: "assignment", plannable_id: "10" });
  assert.equal(first.data.status, "MARKED DONE");
  assert.deepEqual(posts("/api/v1/planner/overrides").at(-1).body, {
    plannable_type: "assignment",
    plannable_id: "10",
    marked_complete: true,
  });
  await call(writer, "set_planner_item_done", { plannable_type: "assignment", plannable_id: "10", done: false });
  assert.deepEqual(lastRequest("PUT", "/api/v1/planner/overrides/500").body, { marked_complete: false });
});

await check("create_planner_note uses the user's time zone", async () => {
  const { data } = await call(writer, "create_planner_note", { title: "Revise ch. 4", todo_date: "2026-11-10", course_id: "101" });
  assert.equal(data.status, "CREATED");
  assert.equal(posts("/api/v1/planner_notes").at(-1).body.todo_date, "2026-11-10T05:00:00.000Z");
});

const edPosts = (path) => edLog.filter((r) => r.method === "POST" && r.path === path);

await check("ed_post_thread: preview checks the category and posts nothing", async () => {
  const args = {
    ed_course_id: "500",
    title: "Lab Q",
    body: "Is it **due** Friday?\n\n- a\n- b",
    category: "labs",
    subcategory: "lab 2",
    anonymous: true,
  };
  const { data } = await call(writer, "ed_post_thread", args);
  assert.match(data.status, /^PREVIEW/);
  assert.equal(data.category, "Labs › Lab 2");
  assert.equal(data.visible_to, "everyone in BIO1001");
  assert.equal(data.shown_as, "Anonymous to other students; staff can still see the user's name");
  assert.equal(edPosts("/api/courses/500/threads").length, 0);

  const unknown = await call(writer, "ed_post_thread", { ...args, category: "Exams" });
  assert.match(unknown.data, /no category "Exams"\. Categories: General; Labs \(Lab 1, Lab 2\)/);
  const missing = await call(writer, "ed_post_thread", { ...args, category: undefined });
  assert.match(missing.data, /Choose a category/);
  const readOnly = await call(writer, "ed_post_thread", { ...args, ed_course_id: "501", category: "General" });
  assert.match(readOnly.data, /read-only for students/);
});

await check("ed_post_thread: confirm posts the body as Ed XML", async () => {
  const { data } = await call(writer, "ed_post_thread", {
    ed_course_id: "500",
    title: "Lab Q",
    body: "Is it **due** Friday?\n\n- a\n- b",
    category: "Labs",
    subcategory: "Lab 2",
    anonymous: true,
    confirm: true,
  });
  assert.deepEqual(edPosts("/api/courses/500/threads")[0].body.thread, {
    type: "question",
    title: "Lab Q",
    category: "Labs",
    subcategory: "Lab 2",
    subsubcategory: "",
    content:
      '<document version="2.0"><paragraph>Is it <bold>due</bold> Friday?</paragraph><list style="bullet"><list-item><paragraph>a</paragraph></list-item><list-item><paragraph>b</paragraph></list-item></list></document>',
    is_pinned: false,
    is_private: false,
    is_anonymous: true,
    is_megathread: false,
    anonymous_comments: false,
  });
  assert.deepEqual(data, { status: "POSTED", thread_id: 701, number: 13, url: `${edOrigin}/au/courses/500/discussion/701` });
});

await check("ed_reply: preview names what it replies to; answers only go on questions", async () => {
  const { data } = await call(writer, "ed_reply", { thread_id: "700", body: "Thanks!", reply_to_comment_id: "801" });
  assert.match(data.status, /^PREVIEW/);
  assert.equal(data.replying_to, 'Dr Tutor (staff)\'s answer: "Yes, Friday."');
  assert.equal(data.posting_as, "a comment");
  const nested = await call(writer, "ed_reply", { thread_id: "700", body: "x", as_answer: true, reply_to_comment_id: "801" });
  assert.match(nested.data, /Only a question takes answers/);
  const unknown = await call(writer, "ed_reply", { thread_id: "700", body: "x", reply_to_comment_id: "999" });
  assert.match(unknown.data, /no answer or comment 999/);
  assert.equal(edLog.filter((r) => r.method === "POST" && r.path.endsWith("/comments")).length, 0);
});

await check("ed_reply: confirm posts under a comment, or as an answer", async () => {
  const reply = await call(writer, "ed_reply", { thread_id: "700", body: "Thanks!", reply_to_comment_id: "801", confirm: true });
  assert.deepEqual(edPosts("/api/comments/801/comments")[0].body, {
    comment: { type: "comment", content: '<document version="2.0"><paragraph>Thanks!</paragraph></document>', is_private: false, is_anonymous: false },
  });
  assert.equal(reply.data.comment_id, 851);
  await call(writer, "ed_reply", { thread_id: "700", body: "Use `x_1`", as_answer: true, private: true, confirm: true });
  assert.deepEqual(edPosts("/api/threads/700/comments")[0].body.comment, {
    type: "answer",
    content: '<document version="2.0"><paragraph>Use <code>x_1</code></paragraph></document>',
    is_private: true,
    is_anonymous: false,
  });
});

await check("markdownToEd: blocks and inline formatting become Ed XML", async () => {
  const md =
    "# Plan\n\nSee [docs](https://x.com/?a=1&b=2) and `a**b`, snake_case_name, *em* and ~~gone~~.\nNext line\n\n" +
    "1. one\n2. two\n\n> quoted <tag>\n\n```py\nif a < b:\n    pass\n```";
  assert.equal(
    markdownToEd(md),
    '<document version="2.0"><heading level="1">Plan</heading>' +
      '<paragraph>See <link href="https://x.com/?a=1&amp;b=2">docs</link> and <code>a**b</code>, snake_case_name, <italic>em</italic> and <strike>gone</strike>.<break/>Next line</paragraph>' +
      '<list style="number"><list-item><paragraph>one</paragraph></list-item><list-item><paragraph>two</paragraph></list-item></list>' +
      "<blockquote><paragraph>quoted &lt;tag&gt;</paragraph></blockquote><pre>if a &lt; b:\n    pass</pre></document>",
  );
});

await writer.close();

// ---------- report_issue ----------

const reportEnv = {
  CANVAS_BASE_URL: baseUrl,
  CANVAS_API_TOKEN: TOKEN,
  CANVAS_ALLOW_WRITES: "",
  REPORTS_GITHUB_REPO: "test/private",
  REPORTS_GITHUB_TOKEN: GITHUB_TOKEN,
  REPORTS_GITHUB_API_URL: githubOrigin,
  REPORTS_DAILY_LIMIT: "4",
};
const reporter = await connect(reportEnv);
const report = (args) =>
  call(reporter, "report_issue", {
    user_goal: "Show the user the brief for an assignment in course 101.",
    details: "Called the tool with the IDs from list_assignments and it failed, though the item exists in Canvas.",
    ruled_out: "Rechecked the IDs and retried twice; canvas_api_get on the same item fails the same way.",
    ...args,
  });
const issuesNow = () => githubIssues.length;

await check("report_issue: listed only when a tracker is configured, and mentioned in the instructions", async () => {
  const { tools } = await reporter.listTools();
  assert.equal(tools.length, READ_TOOLS + LOCAL_TOOLS + 1);
  const tool = tools.find((t) => t.name === "report_issue");
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.match(tool.description, /When in doubt, don't file/);
  assert.deepEqual(tool.inputSchema.required.sort(), ["details", "kind", "ruled_out", "title", "user_goal"]);
  assert.match(reporter.getInstructions(), /report_issue/);
  assert.doesNotMatch(client.getInstructions(), /report_issue/);
});

await check("report_issue: a bug must name a real tool, and thin reports are refused", async () => {
  const before = issuesNow();
  const noTool = await report({ kind: "bug", title: "Something is broken somewhere" });
  assert.equal(noTool.isError, true);
  assert.match(noTool.data, /needs tool/);
  const madeUp = await report({ kind: "bug", title: "make_coffee burns the coffee", tool: "make_coffee" });
  assert.equal(madeUp.isError, true);
  assert.match(madeUp.data, /no tool called "make_coffee"/);
  const itself = await report({ kind: "bug", title: "report_issue is too strict", tool: "report_issue" });
  assert.equal(itself.isError, true);
  const thin = await report({ kind: "bug", title: "get_assignment broken", tool: "get_assignment", details: "It broke." });
  assert.equal(thin.isError, true);
  assert.equal(issuesNow(), before, "nothing was filed");
});

await check("report_issue: files a scrubbed bug with the server's own record of the failing call", async () => {
  const failed = await call(reporter, "get_assignment", { course_id: "101", assignment_id: "999" });
  assert.equal(failed.isError, true);
  const { data } = await report({
    kind: "bug",
    title: "get_assignment errors for an assignment that exists",
    tool: "mcp__canvas__get_assignment",
    details: `get_assignment(course_id 101, assignment_id 999) returned a 404. Token ${TOKEN}, mail me at student@example.edu, cc @octocat.`,
  });
  assert.equal(data.status, "filed");
  const issue = githubIssues.at(-1);
  assert.equal(data.report, `#${issue.number}`);
  assert.equal(issue.title, "get_assignment errors for an assignment that exists");
  assert.deepEqual(issue.labels, ["agent-report", "bug"]);
  assert.match(issue.body, /<!-- canvas-mcp-report kind=bug tool=get_assignment -->/);
  assert.match(issue.body, /Unverified/);
  assert.match(issue.body, /\| Server \| local \(stdio\)/);
  assert.match(issue.body, /### Recent calls to `get_assignment` seen by the server/);
  assert.match(issue.body, /error  \{"course_id":"101","assignment_id":"999"\}/);
  assert.ok(!issue.body.includes(TOKEN), "the Canvas token is redacted");
  assert.ok(!issue.body.includes("student@example.edu"), "email addresses are redacted");
  assert.ok(issue.body.includes("@​octocat"), "@mentions are defused");
});

await check("report_issue: the same problem again is added to the open report", async () => {
  const before = issuesNow();
  const { data } = await report({
    kind: "bug",
    title: "get_assignment returns an error for an existing assignment",
    tool: "get_assignment",
  });
  assert.equal(data.status, "already_reported");
  assert.equal(data.report, `#${before}`);
  assert.equal(issuesNow(), before);
  const comment = githubComments.at(-1);
  assert.equal(comment.issue, before);
  assert.match(comment.body, /Reported again by an agent/);
});

await check("report_issue: something the developer declined isn't filed again", async () => {
  const before = issuesNow();
  const { data } = await report({ kind: "feature", title: "Add a tool that exports the gradebook as a CSV" });
  assert.equal(data.status, "declined");
  assert.equal(data.report, "#1");
  assert.equal(issuesNow(), before);
});

await check("report_issue: features are filed, and issues opened by hand or PRs aren't treated as reports", async () => {
  const { data } = await report({
    kind: "feature",
    title: "list_modules should show each item's completion requirement",
    tool: "list_modules",
  });
  assert.equal(data.status, "filed");
  const issue = githubIssues.at(-1);
  assert.deepEqual(issue.labels, ["agent-report", "enhancement"]);
  assert.match(issue.body, /### What's missing/);
  assert.match(issue.body, /None in the last 2 hours/);
});

await check("report_issue: stops at the daily limit", async () => {
  assert.equal((await report({ kind: "bug", title: "list_files misses files inside folders", tool: "list_files" })).data.status, "filed");
  assert.equal((await report({ kind: "bug", title: "get_syllabus drops embedded tables", tool: "get_syllabus" })).data.status, "filed");
  const before = issuesNow();
  const over = await report({ kind: "bug", title: "get_quiz shows the wrong question count", tool: "get_quiz" });
  assert.equal(over.isError, true);
  assert.match(over.data, /last 24 hours/);
  assert.equal(issuesNow(), before);
});

await reporter.close();

await check("report_issue: refuses to file into a public repository", async () => {
  const publicReporter = await connect({ ...reportEnv, REPORTS_GITHUB_REPO: "test/public" });
  try {
    const before = issuesNow();
    const result = await call(publicReporter, "report_issue", {
      kind: "feature",
      title: "Add a tool for something new entirely",
      user_goal: "Do something the tools can't do yet.",
      details: "No tool here covers this, and the agent tried every plausible one first.",
      ruled_out: "Tried canvas_api_get and the related list tools; none of them return this data.",
    });
    assert.equal(result.isError, true);
    assert.match(result.data, /public/);
    assert.equal(issuesNow(), before);
  } finally {
    await publicReporter.close();
  }
});

// ---------- HTTP entry point, served the way Vercel would: a Web Request in, a Web Response out ----------

const ACCESS_KEY = "test-access-key";
Object.assign(process.env, { CANVAS_BASE_URL: baseUrl, CANVAS_API_TOKEN: TOKEN, MCP_ACCESS_KEY: ACCESS_KEY });
const httpServer = createServer(async (req, res) => {
  const headers = Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]));
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const response = await handleMcpRequest(
    new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: "half",
    }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
const httpBase = await listen(httpServer);

const httpClient = async (url, requestInit) => {
  const client = new Client({ name: "smoke-test-http", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit }));
  return client;
};

await check("HTTP: key in path works end to end", async () => {
  const client = await httpClient(`${httpBase}/mcp/${ACCESS_KEY}`);
  const { tools } = await client.listTools();
  assert.equal(tools.length, READ_TOOLS);
  assert.ok(!tools.some((t) => t.name === "download_files"), "the remote server can't write to the user's disk");
  const { data } = await call(client, "list_courses");
  assert.deepEqual(data.map((c) => c.id), ["101", "102"]);
  await client.close();
});

await check("HTTP: key as Bearer header works", async () => {
  const client = await httpClient(`${httpBase}/mcp`, { headers: { Authorization: `Bearer ${ACCESS_KEY}` } });
  const { data } = await call(client, "get_profile");
  assert.equal(data.name, "Test Student");
  await client.close();
});

await check("HTTP: writes follow CANVAS_ALLOW_WRITES, but never read local files", async () => {
  process.env.CANVAS_ALLOW_WRITES = "true";
  try {
    const client = await httpClient(`${httpBase}/mcp/${ACCESS_KEY}`);
    assert.equal((await client.listTools()).tools.length, READ_TOOLS + WRITE_TOOLS);
    const result = await call(client, "submit_assignment", {
      course_id: "101",
      assignment_id: "10",
      files: [{ path: "C:/Windows/win.ini" }],
    });
    assert.equal(result.isError, true);
    assert.match(result.data, /path only works with the local Canvas server/);
    await client.close();
  } finally {
    delete process.env.CANVAS_ALLOW_WRITES;
  }
});

await check("HTTP: report_issue appears when a tracker is configured", async () => {
  Object.assign(process.env, {
    REPORTS_GITHUB_REPO: "test/private",
    REPORTS_GITHUB_TOKEN: GITHUB_TOKEN,
    REPORTS_GITHUB_API_URL: githubOrigin,
  });
  try {
    const client = await httpClient(`${httpBase}/mcp/${ACCESS_KEY}`);
    const { tools } = await client.listTools();
    assert.equal(tools.length, READ_TOOLS + 1);
    assert.ok(tools.some((t) => t.name === "report_issue"));
    await client.close();
  } finally {
    delete process.env.REPORTS_GITHUB_REPO;
    delete process.env.REPORTS_GITHUB_TOKEN;
    delete process.env.REPORTS_GITHUB_API_URL;
  }
});

await check("HTTP: wrong or missing key is rejected with 401", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  for (const path of ["/mcp", "/mcp/wrong-key", "/mcp?key=wrong-key"]) {
    const res = await fetch(`${httpBase}${path}`, { method: "POST", headers, body });
    assert.equal(res.status, 401, path);
  }
});

await check("HTTP: fails closed when MCP_ACCESS_KEY is unset", async () => {
  delete process.env.MCP_ACCESS_KEY;
  try {
    const res = await fetch(`${httpBase}/mcp/anything`, { method: "POST", body: "{}" });
    assert.equal(res.status, 500);
  } finally {
    process.env.MCP_ACCESS_KEY = ACCESS_KEY;
  }
});

httpServer.close();
canvas.close();
storage.close();
echo.close();
edServer.close();
github.close();
await rm(downloadDir, { recursive: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
