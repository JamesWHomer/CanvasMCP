import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "./canvas.js";
import { registerTools } from "./tools.js";

/** Builds a Canvas client from CANVAS_BASE_URL / CANVAS_API_TOKEN, or undefined if either is missing. */
export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): CanvasClient | undefined {
  const baseUrl = env.CANVAS_BASE_URL?.trim();
  const token = env.CANVAS_API_TOKEN?.trim();
  return baseUrl && token ? new CanvasClient(baseUrl, token) : undefined;
}

// The server starts even when unconfigured so clients can list it, and each tool explains what's missing.
export function createCanvasServer(client: CanvasClient | undefined): McpServer {
  const server = new McpServer(
    { name: "canvas", version: "1.0.0" },
    {
      instructions:
        "Read-only access to the user's Canvas LMS account. Start with list_courses to get course IDs. " +
        "For \"what's due\" or \"what am I missing\" questions use get_planner. " +
        "Timestamps are UTC; get_profile returns the user's time zone for converting them.",
    },
  );
  registerTools(server, () => {
    if (!client) {
      throw new Error(
        "Canvas isn't configured. Set CANVAS_BASE_URL (e.g. https://yourschool.instructure.com) and CANVAS_API_TOKEN, " +
          "either as environment variables or in the .env file next to package.json.",
      );
    }
    return client;
  });
  return server;
}
