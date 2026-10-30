// End-to-end check: runs the built server (stdio and HTTP) against a mock Canvas API and a mock file-storage host.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

const TOKEN = "test-token";
const READ_TOOLS = 26;
const WRITE_TOOLS = 5;

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
  const file = storageFiles[req.url];
  res.writeHead(file ? 200 : 404);
  res.end(file);
});

// ---------- mock Canvas ----------

const canvasLog = [];
let overrides = [];
const canvas = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const raw = await readBody(req);
  const body = raw && req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : undefined;
  canvasLog.push({ method: req.method, path: url.pathname, query: url.searchParams, body });
  const send = (status, data, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(data));
  };
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
        rubric: [{ id: "c1", description: "Clarity", points: 10, ratings: [{ points: 10, description: "Clear" }] }],
      }),
    "GET /api/v1/courses/101/assignments/10/submissions/self": () =>
      send(200, {
        workflow_state: "graded",
        score: 18,
        attempt: 1,
        submitted_at: "2026-10-01T00:00:00Z",
        submission_comments: [{ author_name: "Prof", created_at: "2026-10-01T00:00:00Z", comment: "Nice work" }],
        rubric_assessment: { c1: { points: 8, comments: "Mostly clear" } },
      }),
    "POST /api/v1/courses/101/assignments/10/submissions/self/files": () =>
      send(200, { upload_url: `${storageOrigin}/upload`, upload_params: { key: "upload-key" } }),
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
        { id: "7", name: "Team Rocket", course_id: "101", members_count: 2 },
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
  };
  if (req.method === "GET" && url.pathname.match(/^\/files\/\d+\/download$/)) {
    const id = url.pathname.split("/")[2];
    const names = { 55: "slides.pdf", 56: "spec.docx", 57: "lecture.pptx", 58: "notes.txt", 59: "diagram.png" };
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

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const baseUrl = await listen(canvas);
const storageOrigin = await listen(storage);

// ---------- harness ----------

async function connect(env) {
  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
      env: { ...getDefaultEnvironment(), ...env },
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

await check("lists read tools only by default, with string ID schemas", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, READ_TOOLS);
  assert.ok(!tools.some((t) => t.name === "submit_assignment"));
  const getAssignment = tools.find((t) => t.name === "get_assignment");
  assert.equal(getAssignment.inputSchema.properties.course_id.type, "string");
  assert.deepEqual(getAssignment.inputSchema.required.sort(), ["assignment_id", "course_id"]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint));
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

await check("list_my_groups: current courses only, with members", async () => {
  const { data } = await call(client, "list_my_groups");
  assert.deepEqual(data.map((g) => g.name), ["Team Rocket"]);
  assert.deepEqual(data[0].members.map((m) => m.name), ["Test Student", "Ash"]);
  const all = await call(client, "list_my_groups", { include_past: true });
  assert.equal(all.data.length, 2);
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
  assert.equal(tools.length, READ_TOOLS + WRITE_TOOLS);
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
  assert.equal(data.attempt, "2 of unlimited");
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

await writer.close();

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
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
