import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CanvasClient } from "../canvas.js";
import { registerAssessmentTools } from "./assessment.js";
import { registerCommunityTools } from "./community.js";
import { registerCoreTools } from "./core.js";
import { registerEdTools, registerEdWriteTools } from "./ed.js";
import { registerFileTools } from "./files.js";
import { registerLectureTools } from "./lectures.js";
import type { ReportStore } from "../reports.js";
import { registerReportTool, trackCalls } from "./report.js";
import { makeRunner } from "./shared.js";
import { registerWriteTools } from "./write.js";

export interface ToolOptions {
  /** Register tools that change Canvas or Ed (submissions, posts, messages, planner). */
  allowWrites: boolean;
  /** Let tools read files from this machine's disk; only safe for the local stdio server. */
  allowLocalFiles: boolean;
  /** Where report_issue files bug reports and feature requests; the tool is left out without one. */
  reports?: ReportStore;
}

export function registerTools(server: McpServer, canvas: () => CanvasClient, options: ToolOptions): void {
  const calls = trackCalls(server);
  const ctx = { server, canvas, allowLocalFiles: options.allowLocalFiles, run: makeRunner(canvas) };
  registerCoreTools(ctx);
  registerFileTools(ctx);
  registerCommunityTools(ctx);
  registerAssessmentTools(ctx);
  registerLectureTools(ctx);
  registerEdTools(ctx);
  if (options.allowWrites) {
    registerWriteTools(ctx);
    registerEdWriteTools(ctx);
  }
  // Last, so the tool names it accepts in a report include every other tool.
  if (options.reports) registerReportTool(ctx, options.reports, calls);
}
