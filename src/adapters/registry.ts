import type { Config } from "../core/config.js";

export type CoverageState = "full" | "partial" | "none";

export interface AdapterInfo {
  id: string;
  country: string;
  label: string;
  /** Environment variables that must be set; empty when the source is keyless. */
  requiredEnv: string[];
  /** Whether the adapter is implemented yet. */
  implemented: boolean;
}

export interface AdapterStatus extends AdapterInfo {
  enabled: boolean;
  reason: string;
}

export const ADAPTERS: AdapterInfo[] = [
  { id: "gleif", country: "EU", label: "GLEIF LEI records", requiredEnv: [], implemented: true },
  { id: "vies", country: "EU", label: "VIES VAT validation", requiredEnv: [], implemented: true },
  {
    id: "gb",
    country: "GB",
    label: "Companies House",
    requiredEnv: ["COMPANIES_HOUSE_API_KEY"],
    implemented: true,
  },
  {
    id: "gb-fca",
    country: "GB",
    label: "FCA Register",
    requiredEnv: ["FCA_AUTH_EMAIL", "FCA_AUTH_KEY"],
    implemented: false,
  },
  {
    id: "no",
    country: "NO",
    label: "Bronnoysund Register Centre",
    requiredEnv: [],
    implemented: false,
  },
  {
    id: "fi",
    country: "FI",
    label: "Finnish Patent and Registration Office",
    requiredEnv: [],
    implemented: false,
  },
  {
    id: "ie",
    country: "IE",
    label: "Companies Registration Office",
    requiredEnv: [],
    implemented: false,
  },
];

export function adapterStatuses(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): AdapterStatus[] {
  return ADAPTERS.map((a) => {
    const missing = a.requiredEnv.filter((name) => !env[name] || env[name]!.trim() === "");
    const allowed = !config.adapterAllowList || config.adapterAllowList.includes(a.id);
    if (!allowed) return { ...a, enabled: false, reason: "not in EIM_ADAPTERS allow-list" };
    if (missing.length > 0) {
      return { ...a, enabled: false, reason: `missing credentials: ${missing.join(", ")}` };
    }
    if (!a.implemented) return { ...a, enabled: false, reason: "not implemented yet" };
    return { ...a, enabled: true, reason: "enabled" };
  });
}
