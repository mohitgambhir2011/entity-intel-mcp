// End-to-end check: spawns the built server over stdio and calls the tools against the real
// services. Needs `npm run build` and COMPANIES_HOUSE_API_KEY. Not part of the test suite.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: {
    ...(process.env as Record<string, string>),
    EIM_DB_PATH: join(tmpdir(), `eim-smoke-${Date.now()}.db`),
  },
  stderr: "ignore",
});
const client = new Client({ name: "live-smoke", version: "0" });
await client.connect(transport);

async function call(name: string, args: Record<string, unknown>): Promise<void> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[])[0]!.text;
  console.log(`\n== ${name} ${JSON.stringify(args)} ${res.isError ? "(ERROR)" : ""}`);
  if (res.isError) return console.log(text);
  const j = JSON.parse(text);
  console.log("summary :", j.summary);
  if (j.warnings.length) console.log("warnings:", j.warnings);
  console.log("meta    :", JSON.stringify(j.meta));
  if (name === "search_entities") {
    for (const c of j.data.candidates.slice(0, 5)) {
      console.log(
        ` - ${c.name} [${c.entityId}] ${c.match.band} ${c.match.confidence} ${c.status?.normalized ?? ""} ${c.match.warnings.join("; ")}`,
      );
    }
  } else if (name === "get_entity") {
    const d = j.data;
    console.log(
      "entity  :",
      d.entityId,
      d.names[0]?.name,
      d.status?.value.normalized,
      d.legalForm?.value.normalized,
    );
    console.log(
      "ids     :",
      d.identifiers
        .map((i: { scheme: string; value: string }) => `${i.scheme}=${i.value}`)
        .join(" "),
    );
    console.log("conflict:", d.conflicts.length, "| sources:", d.sources.join(","));
  } else if (name === "resolve_identifier") {
    console.log("data    :", JSON.stringify(j.data).slice(0, 400));
  }
}

await call("check_coverage", { country: "GB" });
await call("search_entities", { query: "Tesco PLC", country: "GB" });
await call("search_entities", { query: "2138002P5RNKC5W2JZ46" });
await call("get_entity", { identifier: "00445790", country: "GB" });
await call("get_entity", { identifier: "00445790", country: "GB" });
await call("resolve_identifier", { identifier: "IE6388047V" });
await call("resolve_identifier", { identifier: "DE811128135" });
await call("get_entity", { identifier: "NOTANID" });
await client.close();
