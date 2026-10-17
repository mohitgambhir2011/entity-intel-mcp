// Manual check against the real services. Not part of the test suite: `npx tsx scripts/live-smoke.ts`
import { createCompaniesHouseAdapter } from "../src/adapters/companies-house/index.js";
import { gleifAdapter } from "../src/adapters/gleif/index.js";
import { viesAdapter } from "../src/adapters/vies/index.js";
import type { AdapterContext } from "../src/adapters/types.js";
import { loadConfig } from "../src/core/config.js";
import { makeIdentifier } from "../src/core/identifiers.js";
import { Cache } from "../src/infra/cache.js";
import { DEFAULT_HOST_RULES, HttpClient } from "../src/infra/http.js";
import { MemoryStorage } from "../src/infra/storage/memory.js";

const config = loadConfig();
const ctx: AdapterContext = {
  http: new HttpClient({ rules: DEFAULT_HOST_RULES, userAgent: "entity-intel-mcp/0.0.1 (smoke)" }),
  cache: new Cache(new MemoryStorage(), 30 * 86400),
};

const lei = await gleifAdapter.lookup(makeIdentifier("LEI", "2138002P5RNKC5W2JZ46"), ctx);
console.log(
  "GLEIF:",
  lei?.names[0]?.name,
  lei?.status?.value.normalized,
  lei?.identifiers.map((i) => `${i.scheme}=${i.value}`).join(" "),
);

const vies = await viesAdapter.lookup(makeIdentifier("VAT", "IE6388047V"), ctx);
console.log("VIES:", vies?.names[0]?.name ?? "(name withheld)", vies?.identifiers[0]?.validated);

const ch = createCompaniesHouseAdapter(config.companiesHouseApiKey);
const co = await ch.lookup(makeIdentifier("GB_CRN", "00445790"), ctx);
console.log(
  "CH:",
  co?.names[0]?.name,
  co?.status?.value.normalized,
  co?.registeredAddress?.value.formatted,
);
const hits = await ch.search!("tesco", ctx, 3);
console.log("CH search:", hits.map((h) => `${h.name} (${h.identifier.value})`).join(" | "));
const again = await ch.lookup(makeIdentifier("GB_CRN", "00445790"), ctx);
console.log("CH second lookup from cache:", again?.identifiers[0]?.provenance[0]?.fromCache);
