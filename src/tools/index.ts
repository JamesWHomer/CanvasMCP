import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CanvasClient } from "../canvas.js";
import { registerAssessmentTools } from "./assessment.js";
import { registerCommunityTools } from "./community.js";
import { registerCoreTools } from "./core.js";
import { registerFileTools } from "./files.js";
import { registerLectureTools } from "./lectures.js";
import { registerWriteTools } from "./write.js";

export interface ToolOptions {
  /** Register tools that change Canvas (submissions, posts, messages, planner). */
  allowWrites: boolean;
  /** Let tools read files from this machine's disk; only safe for the local stdio server. */
  allowLocalFiles: boolean;
}

export function registerTools(server: McpServer, canvas: () => CanvasClient, options: ToolOptions): void {
  const ctx = { server, canvas, allowLocalFiles: options.allowLocalFiles };
  registerCoreTools(ctx);
  registerFileTools(ctx);
  registerCommunityTools(ctx);
  registerAssessmentTools(ctx);
  registerLectureTools(ctx);
  if (options.allowWrites) registerWriteTools(ctx);
}
