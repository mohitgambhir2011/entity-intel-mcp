#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./core/config.js";
import { createRuntime } from "./runtime.js";
import { createServer } from "./server/server.js";

async function main(): Promise<void> {
  const rt = createRuntime(loadConfig());
  const server = createServer(rt);
  const shutdown = (): void => {
    rt.storage.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel; log to stderr only.
  console.error("entity-intel-mcp running on stdio");
  // Index already-cached sanctions lists (no network); others download on first screening.
  rt.sanctions.warmFromCache();
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
