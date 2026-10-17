#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./core/config.js";
import { createServer } from "./server/server.js";

async function main(): Promise<void> {
  const server = createServer(loadConfig());
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel; log to stderr only.
  console.error("entity-intel-mcp running on stdio");
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
