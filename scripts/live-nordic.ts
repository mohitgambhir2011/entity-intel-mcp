// Real Norwegian (Enhetsregisteret) and Finnish (PRH) lookups, crosswalks and roles. No keys needed.
// Prints counts and company names only (no individuals' names).
import { loadConfig } from "../src/core/config.js";
import { makeIdentifier } from "../src/core/identifiers.js";
import { createRuntime } from "../src/runtime.js";
import { resolveCompany } from "../src/services/company.js";
import { getOfficers } from "../src/services/officers.js";
import { getOwnership } from "../src/services/ownership.js";
import { searchEntities } from "../src/services/search.js";

const rt = createRuntime(loadConfig({ EIM_ADAPTERS: "gleif,vies,no,fi" } as NodeJS.ProcessEnv));

async function show(
  label: string,
  scheme: "NO_ORGNR" | "FI_YTUNNUS" | "LEI" | "VAT",
  value: string,
): Promise<void> {
  const c = await resolveCompany(rt, makeIdentifier(scheme, value));
  const p = c.profile;
  console.log(
    `${label}: ${p.entityId} | ${p.names[0]?.name} | ${p.status?.value.normalized} (${p.status?.value.sourceText}) | ` +
      `${p.legalForm?.value.localName} | ${p.registeredAddress?.value.formatted}\n   ids: ` +
      p.identifiers.map((i) => `${i.scheme}=${i.value}${i.validated ? "*" : ""}`).join(" ") +
      ` | sources: ${p.sources.join(",")} | warnings: ${c.warnings.length}`,
  );
}

await show("NO  Equinor     ", "NO_ORGNR", "923609016");
await show("NO  via LEI     ", "LEI", "OW6OFBNCKXC4US5C7523");
await show("FI  Nokia       ", "FI_YTUNNUS", "0112038-9");
await show("FI  via VAT     ", "VAT", "FI01120389");
await show("FI  via LEI     ", "LEI", "549300A0JPRWG1KI7U06");
await show("FI  ceased      ", "FI_YTUNNUS", "0100002-9");
await show("FI  bankrupt    ", "FI_YTUNNUS", "0104057-3");

const off = await getOfficers(rt, {
  seed: makeIdentifier("NO_ORGNR", "923609016"),
  activeOnly: true,
  limit: 100,
});
if (off.officers.state === "available") {
  const roles: Record<string, number> = {};
  for (const o of off.officers.data.officers) roles[o.role] = (roles[o.role] ?? 0) + 1;
  console.log(
    "\nEquinor current roles:",
    roles,
    "| registry total",
    off.officers.data.registryTotal,
  );
}
for (const [label, scheme, value] of [
  ["NO", "NO_ORGNR", "923609016"],
  ["FI", "FI_YTUNNUS", "0112038-9"],
] as const) {
  const o = await getOfficers(rt, { seed: makeIdentifier(scheme, value) });
  const w = await getOwnership(rt, { seed: makeIdentifier(scheme, value) });
  console.log(
    `${label} officers:`,
    o.officers.state,
    "| ownership:",
    w.ownership.state,
    w.ownership.state === "unavailable" ? w.ownership.reason : "",
  );
}

for (const [q, country] of [
  ["Equinor", "NO"],
  ["Nokia", "FI"],
  ["Nordea", "FI"],
] as const) {
  const s = await searchEntities(rt, { query: q, country, limit: 4 });
  console.log(`\nsearch ${q} (${country}): ${s.total} candidates`);
  for (const c of s.candidates)
    console.log(
      `  ${c.entityId} ${c.name} [${c.match.band} ${c.match.confidence}] ${c.status?.normalized ?? ""}`,
    );
}
rt.storage.close();
