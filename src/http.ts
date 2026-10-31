// Remote entry point: MCP over Streamable HTTP (stateless, JSON responses) for serverless hosting.
import { createHash, timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CanvasClient } from "./canvas.js";
import { clientFromEnv, createCanvasServer } from "./server.js";

// Kept across requests while the instance lives, so per-client lookups (the user's time zone) are cached.
let client: CanvasClient | undefined;

const json = (status: number, message: string) =>
  Response.json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }, { status });

/** The access key can arrive as a Bearer token, as /mcp/<key> in the path, or as ?key=<key>. */
function presentedKey(req: Request): string | undefined {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const url = new URL(req.url);
  return url.searchParams.get("key") ?? url.pathname.match(/\/mcp\/([^/]+)\/?$/)?.[1] ?? undefined;
}

// Hashing first gives equal-length buffers, so the comparison is constant-time regardless of input length.
function keyMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

export async function handleMcpRequest(req: Request): Promise<Response> {
  // Fail closed: without an access key configured, the Canvas token must not be reachable.
  const expected = process.env.MCP_ACCESS_KEY?.trim();
  if (!expected) return json(500, "Server misconfigured: MCP_ACCESS_KEY is not set.");
  if (!keyMatches(presentedKey(req), expected)) return json(401, "Unauthorized: missing or wrong access key.");

  client ??= clientFromEnv();
  const server = createCanvasServer(client, { allowLocalFiles: false });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
