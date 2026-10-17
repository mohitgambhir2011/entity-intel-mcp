// Real Companies House filing history, charges and insolvency (needs COMPANIES_HOUSE_API_KEY).
// Prints counts, types and company names only (no practitioners' names).
import { loadConfig } from "../src/core/config.js";
import { makeIdentifier } from "../src/core/identifiers.js";
import { createRuntime } from "../src/runtime.js";
import { getRecords } from "../src/services/records.js";

const rt = createRuntime(loadConfig(process.env));

for (const [label, number] of [
  ["Tesco PLC", "00445790"],
  ["Tesco Stores (many charges)", "00519500"],
  ["Liquidated NI company", "NI017460"],
] as const) {
  const r = await getRecords(rt, {
    seed: makeIdentifier("GB_CRN", number, { country: "GB" }),
    limit: 3,
  });
  const f = r.filings?.state === "available" ? r.filings.data : undefined;
  const c = r.charges?.state === "available" ? r.charges.data : undefined;
  const i = r.insolvency?.state === "available" ? r.insolvency.data : undefined;
  console.log(
    `${label}: ${r.profile.entityId} status=${r.profile.status?.value.normalized}\n` +
      `  filings: ${r.filings?.state} total=${f?.total} first=${f?.items.map((x) => `${x.date} ${x.type}`).join(", ")}\n` +
      `  charges: ${r.charges?.state} total=${c?.total} outstanding=${c?.outstanding} read=${c?.charges.length}\n` +
      `  insolvency: ${r.insolvency?.state} cases=${i?.cases.map((x) => x.type).join(",") || 0} flags=${i?.statusFlags.join(",")}\n` +
      `  warnings: ${r.warnings.length ? r.warnings.join(" | ") : "none"}`,
  );
}
