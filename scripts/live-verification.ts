// One real Companies House officers request to check what the register shows for identity
// verification (D48). Needs COMPANIES_HOUSE_API_KEY. Prints counts only: no names, no officer ids.
import { loadConfig } from "../src/core/config.js";
import { createRuntime } from "../src/runtime.js";
import { makeIdentifier } from "../src/core/identifiers.js";
import { getOfficers } from "../src/services/officers.js";

const rt = createRuntime(loadConfig());
const seed = makeIdentifier("GB_CRN", process.argv[2] ?? "00445790", { country: "GB" });
const off = await getOfficers(rt, { seed, activeOnly: true, limit: 100 });

if (off.officers.state !== "available") {
  console.log("officers:", off.officers.state);
} else {
  const people = off.officers.data.officers.filter((o) => o.kind === "person");
  const states: Record<string, number> = {};
  for (const o of people) {
    const s = o.verification?.state ?? "absent";
    states[s] = (states[s] ?? 0) + 1;
  }
  console.log(`persons: ${people.length}; verification states:`, states);
  console.log(`with officerRef: ${people.filter((o) => o.officerRef).length}`);
}
