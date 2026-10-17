// Real FCA Register lookups (needs FCA_AUTH_EMAIL, FCA_AUTH_KEY and COMPANIES_HOUSE_API_KEY).
// Prints status, counts and firm names only.
import { loadConfig } from "../src/core/config.js";
import { makeIdentifier } from "../src/core/identifiers.js";
import { createRuntime } from "../src/runtime.js";
import { getRegulatoryStatus } from "../src/services/regulatory.js";

const rt = createRuntime(loadConfig(process.env));

for (const [label, scheme, value] of [
  ["Barclays Bank UK PLC by company number", "GB_CRN", "09740322"],
  ["Barclays Bank UK PLC by FRN", "FCA_FRN", "759676"],
  ["Tesco PLC (not an FCA firm itself)", "GB_CRN", "00445790"],
] as const) {
  const r = await getRegulatoryStatus(rt, {
    seed: makeIdentifier(scheme, value, { country: "GB" }),
  });
  const d = r.regulatory.state === "available" ? r.regulatory.data : undefined;
  console.log(
    `${label}: ${r.profile.entityId} | ${r.profile.names[0]?.name}\n` +
      `  regulatory: ${r.regulatory.state}` +
      (d
        ? ` | FRN ${d.frn} ${d.name} | ${d.status} since ${d.statusEffectiveFrom} | matchedBy ${d.matchedBy}\n` +
          `  regulators: ${d.regulators.map((x) => x.name).join(", ")} | permissions ${d.permissions.length}/${d.permissionsTotal} | requirements ${d.requirements.length}/${d.requirementsTotal} | truncated ${d.truncated}`
        : r.regulatory.state === "unavailable"
          ? ` ${r.regulatory.reason}`
          : "") +
      `\n  warnings: ${r.warnings.join(" | ") || "none"}`,
  );
}
