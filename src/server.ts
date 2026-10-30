import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "./canvas.js";
import { registerTools } from "./tools/index.js";

/** Builds a Canvas client from CANVAS_BASE_URL / CANVAS_API_TOKEN, or undefined if either is missing. */
export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): CanvasClient | undefined {
  const baseUrl = env.CANVAS_BASE_URL?.trim();
  const token = env.CANVAS_API_TOKEN?.trim();
  return baseUrl && token ? new CanvasClient(baseUrl, token) : undefined;
}

/** Write tools are opt-in: CANVAS_ALLOW_WRITES=true (or 1/yes). */
export function writesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.CANVAS_ALLOW_WRITES?.trim() ?? "");
}

// The server starts even when unconfigured so clients can list it, and each tool explains what's missing.
export function createCanvasServer(
  client: CanvasClient | undefined,
  { allowLocalFiles }: { allowLocalFiles: boolean },
): McpServer {
  const allowWrites = writesEnabled();
  const server = new McpServer(
    { name: "canvas", version: "1.1.0" },
    {
      instructions:
        "Access to the user's Canvas LMS account. Start with list_courses to get course IDs. " +
        "For \"what's due\" or \"what am I missing\" questions use get_planner; for \"what's new\" use get_recent_activity. " +
        "Use read_file to read PDFs, slides and other course files. " +
        (allowLocalFiles
          ? "Use download_files to save original files (e.g. a template to fill in) to the user's computer. "
          : "") +
        "Timestamps are UTC; get_profile returns the user's time zone for converting them." +
        (allowWrites
          ? " Write tools are enabled. submit_assignment, post_discussion_reply and send_message act on the user's behalf " +
            "and are visible to others: always call them first without confirm, show the user the preview, and only call " +
            "again with confirm: true after the user explicitly approves."
          : ""),
    },
  );
  registerTools(
    server,
    () => {
      if (!client) {
        throw new Error(
          "Canvas isn't configured. Set CANVAS_BASE_URL (e.g. https://yourschool.instructure.com) and CANVAS_API_TOKEN, " +
            "either as environment variables or in the .env file next to package.json.",
        );
      }
      return client;
    },
    { allowWrites, allowLocalFiles },
  );
  return server;
}
