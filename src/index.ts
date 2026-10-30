#!/usr/bin/env node
// Local stdio entry point, for running the server on this machine.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { clientFromEnv, createCanvasServer } from "./server.js";

// Real environment variables win; the project's .env only fills in what's missing.
function loadDotEnv(): void {
  const envPath = fileURLToPath(new URL("../.env", import.meta.url));
  if (!existsSync(envPath)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envPath, "utf8")))) {
    if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
  }
}

loadDotEnv();

const client = clientFromEnv();
await createCanvasServer(client).connect(new StdioServerTransport());
console.error(client ? `Canvas MCP server connected to ${client.origin}` : "Canvas MCP server started without credentials");
