// Real Companies House officers / PSC and a related-party sanctions screen. Needs
// COMPANIES_HOUSE_API_KEY. Prints counts and company names only (no individuals' names).
import { loadConfig } from "../src/core/config.js";
import { createRuntime } from "../src/runtime.js";
import { makeIdentifier } from "../src/core/identifiers.js";
import { getOfficers } from "../src/services/officers.js";
import { getOwnership } from "../src/services/ownership.js";
import { screenSanctions } from "../src/services/screen.js";

const rt = createRuntime(loadConfig());
const seed = (n: string) => makeIdentifier("GB_CRN", n, { country: "GB" });

const off = await getOfficers(rt, { seed: seed("00445790"), activeOnly: true, limit: 100 });
if (off.officers.state === "available") {
  const d = off.officers.data;
  const roles: Record<string, number> = {};
  for (const o of d.officers) roles[o.role] = (roles[o.role] ?? 0) + 1;
  console.log(
    `Tesco PLC officers: ${d.matching} current (${d.activeCount} active / ${d.resignedCount} resigned on register); roles`,
    roles,
  );
} else console.log("officers:", off.officers);

for (const n of ["00519500", "01074897", "00445790"]) {
  const own = await getOwnership(rt, { seed: seed(n), depth: 4 });
  if (own.ownership.state !== "available") {
    console.log(n, own.ownership);
    continue;
  }
  const g = own.ownership.data;
  console.log(
    `\n${n}: depth ${g.depthReached}, companies expanded ${g.companiesExpanded}, cutBy [${g.cutBy}]`,
  );
  for (const node of g.nodes) {
    console.log(
      `  L${node.level} ${node.kind === "person" ? "(individual)" : node.name} ${node.terminal ? "[" + node.terminal + "]" : ""}`,
    );
  }
}

const s = await screenSanctions(rt, { seed: seed("00445790"), include: ["officers", "owners"] });
console.log(
  "\nscreen Tesco PLC + officers + owners ->",
  s.overall,
  "| entity:",
  s.screening.result,
  "| officers screened:",
  s.related?.screened.officers.length,
  "| owners screened:",
  s.related?.screened.owners.length,
  "| related hits:",
  s.related?.hits.length,
);
for (const w of s.warnings) console.log("  warning:", w);
rt.storage.close();
