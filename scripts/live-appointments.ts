// One real Companies House person-appointments lookup (D49). Needs COMPANIES_HOUSE_API_KEY.
// Takes the first current person of a company, prints counts only: no names, no ids.
import { loadConfig } from "../src/core/config.js";
import { createRuntime } from "../src/runtime.js";
import { makeIdentifier } from "../src/core/identifiers.js";
import { getOfficers } from "../src/services/officers.js";
import { getOfficerAppointments } from "../src/services/officerAppointments.js";

const rt = createRuntime(loadConfig());
const seed = makeIdentifier("GB_CRN", process.argv[2] ?? "00445790", { country: "GB" });
const off = await getOfficers(rt, { seed, activeOnly: true, limit: 100 });
if (off.officers.state !== "available") {
  console.log("officers:", off.officers.state);
} else {
  const person = off.officers.data.officers.find((o) => o.kind === "person" && o.officerRef);
  if (!person?.officerRef) {
    console.log("no person with an officerRef");
  } else {
    const t0 = Date.now();
    const out = await getOfficerAppointments(rt, { officerRef: person.officerRef });
    const a = out.appointments;
    if (a.state !== "available") console.log("appointments:", a.state);
    else {
      const d = a.data;
      const roles: Record<string, number> = {};
      for (const x of d.appointments) roles[x.role] = (roles[x.role] ?? 0) + 1;
      console.log(
        `appointments read ${d.appointments.length} of ${d.total}; active ${d.activeCount}; ` +
          `truncated ${d.truncated}; roles`,
        roles,
        `; ${Date.now() - t0} ms; warnings ${out.warnings.length}`,
      );
    }
  }
}
