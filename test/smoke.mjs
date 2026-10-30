// End-to-end check: runs the built server over stdio against a mock Canvas API.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpRequest } from "../dist/http.js";

const TOKEN = "test-token";

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(401, { errors: [{ message: "Invalid access token." }] });
  }
  const origin = `http://${req.headers.host}`;
  const routes = {
    "/api/v1/users/self/profile": () =>
      send(200, { id: "1", name: "Test Student", primary_email: "s@example.edu", time_zone: "America/New_York" }),
    "/api/v1/courses": () =>
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
    "/api/v1/planner/items": () =>
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
    "/api/v1/courses/101/assignments/10": () =>
      send(200, {
        id: "10",
        name: "Lab report",
        description: "<p>Write up the <strong>enzyme</strong> lab.</p><script>x()</script><ul><li>2 pages</li></ul>",
        points_possible: 20,
        allowed_attempts: -1,
        rubric: [{ id: "c1", description: "Clarity", points: 10, ratings: [{ points: 10, description: "Clear" }] }],
      }),
    "/api/v1/courses/101/assignments/10/submissions/self": () =>
      send(200, {
        workflow_state: "graded",
        score: 18,
        submission_comments: [{ author_name: "Prof", created_at: "2026-10-01T00:00:00Z", comment: "Nice work" }],
        rubric_assessment: { c1: { points: 8, comments: "Mostly clear" } },
      }),
    "/api/v1/courses/101/modules": () =>
      send(200, [
        { id: "1", name: "Week 1", items: [{ title: "Intro", type: "Page", page_url: "intro" }] },
        { id: "2", name: "Week 2", items_url: `${origin}/api/v1/courses/101/modules/2/items` },
      ]),
    "/api/v1/courses/101/modules/2/items": () =>
      send(200, [{ title: "Slides", type: "File", content_id: "55", completion_requirement: { completed: true } }]),
    "/api/v1/courses/101/files": () =>
      send(200, [{ id: "55", display_name: "slides.pdf" }], { link: `<http://evil.example/api/v1/steal>; rel="next"` }),
  };
  const handler = routes[url.pathname];
  if (handler) return handler();
  send(404, { errors: [{ message: "The specified resource does not exist." }] });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

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
  return { ...result, data: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
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

const client = await connect({ CANVAS_BASE_URL: baseUrl, CANVAS_API_TOKEN: TOKEN });

await check("lists all tools with string ID schemas", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 16);
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

// HTTP entry point, served the way Vercel would: a Web Request in, a Web Response out.
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
await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const httpBase = `http://127.0.0.1:${httpServer.address().port}`;

const httpClient = async (url, requestInit) => {
  const client = new Client({ name: "smoke-test-http", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit }));
  return client;
};

await check("HTTP: key in path works end to end", async () => {
  const client = await httpClient(`${httpBase}/mcp/${ACCESS_KEY}`);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 16);
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
server.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
