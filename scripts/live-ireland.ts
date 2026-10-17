// Real Irish CRO open data lookups (no key). Prints company data only.
import { loadConfig } from "../src/core/config.js";
import { makeIdentifier } from "../src/core/identifiers.js";
import { createRuntime } from "../src/runtime.js";
import { resolveCompany } from "../src/services/company.js";
import { getOwnership } from "../src/services/ownership.js";
import { searchEntities } from "../src/services/search.js";

const rt = createRuntime(loadConfig({ EIM_ADAPTERS: "gleif,vies,ie" } as NodeJS.ProcessEnv));

for (const [label, scheme, value] of [
  ["Ryanair Holdings by number", "IE_CRO", "249885"],
  ["Ryanair Holdings by LEI", "LEI", "635400BR2ROC1FVEBQ56"],
  ["Dissolved company", "IE_CRO", "279457"],
] as const) {
  const c = await resolveCompany(rt, makeIdentifier(scheme, value));
  const p = c.profile;
  console.log(
    `${label}: ${p.entityId} | ${p.names[0]?.name} | ${p.status?.value.normalized} (${p.status?.value.sourceText}) | ` +
      `${p.legalForm?.value.localName} | ${p.incorporationDate?.value} | sources ${p.sources.join(",")} | ` +
      `ids ${p.identifiers.map((i) => i.scheme).join(",")} | warnings ${c.warnings.length}`,
  );
}
const own = await getOwnership(rt, { seed: makeIdentifier("IE_CRO", "249885", { country: "IE" }) });
console.log(
  "ownership:",
  own.ownership.state,
  own.ownership.state === "unavailable" ? own.ownership.reason : "",
);
const s = await searchEntities(rt, { query: "Ryanair Holdings", country: "IE", limit: 4 });
for (const c of s.candidates)
  console.log(`  ${c.entityId} ${c.name} [${c.match.band}] ${c.status?.normalized}`);
