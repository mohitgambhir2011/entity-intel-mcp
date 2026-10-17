// Prints example tool responses built from the recorded fixtures (used to keep docs honest).
// Run: npx tsx scripts/print-examples.ts
import { startHarness } from "../test/harness.js";

const h = await startHarness();
const which = process.argv[2] ?? "get_entity";
const args: Record<string, Record<string, unknown>> = {
  get_entity: { identifier: "00445790", country: "GB" },
  search_entities: { query: "Tesco PLC", country: "GB", limit: 2 },
  resolve_identifier: { identifier: "2138002P5RNKC5W2JZ46" },
  check_coverage: { country: "GB" },
};
const r = await h.call(which, args[which]!);
console.log(JSON.stringify(r.json, null, 2));
await h.close();
