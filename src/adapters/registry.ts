import type { Config } from "../core/config.js";
import type { IdentifierScheme } from "../core/types.js";
import { createCompaniesHouseAdapter } from "./companies-house/index.js";
import { finlandAdapter } from "./fi-prh/index.js";
import { gleifAdapter } from "./gleif/index.js";
import { norwayAdapter } from "./no-brreg/index.js";
import type { SourceAdapter } from "./types.js";
import { viesAdapter } from "./vies/index.js";

/**
 * The catalogue of sources: what exists, what each needs, and how to build it. Adding a country
 * means adding one entry here plus one folder under src/adapters/ (D32).
 */
export interface AdapterInfo {
  /** Short id used in EIM_ADAPTERS, e.g. "gb". */
  id: string;
  country: string;
  label: string;
  /** Environment variables that must be set; empty when the source is keyless. */
  requiredEnv: string[];
  /** Identifier schemes this adapter can look up. */
  schemes: IdentifierScheme[];
  /** Whether the adapter is implemented yet. */
  implemented: boolean;
  /** Builds the adapter. Only called when it is enabled. */
  create?: (config: Config) => SourceAdapter;
}

export interface AdapterStatus extends Omit<AdapterInfo, "create"> {
  enabled: boolean;
  reason: string;
}

export const ADAPTERS: AdapterInfo[] = [
  {
    id: "gleif",
    country: "EU",
    label: "GLEIF LEI records",
    requiredEnv: [],
    schemes: ["LEI"],
    implemented: true,
    create: () => gleifAdapter,
  },
  {
    id: "vies",
    country: "EU",
    label: "VIES VAT validation",
    requiredEnv: [],
    schemes: ["VAT"],
    implemented: true,
    create: () => viesAdapter,
  },
  {
    id: "gb",
    country: "GB",
    label: "Companies House",
    requiredEnv: ["COMPANIES_HOUSE_API_KEY"],
    schemes: ["GB_CRN"],
    implemented: true,
    create: (config) => createCompaniesHouseAdapter(config.companiesHouseApiKey),
  },
  {
    id: "gb-fca",
    country: "GB",
    label: "FCA Register",
    requiredEnv: ["FCA_AUTH_EMAIL", "FCA_AUTH_KEY"],
    schemes: ["FCA_FRN"],
    implemented: false,
  },
  {
    id: "no",
    country: "NO",
    label: "Bronnoysund Register Centre (Enhetsregisteret)",
    requiredEnv: [],
    schemes: ["NO_ORGNR"],
    implemented: true,
    create: () => norwayAdapter,
  },
  {
    id: "fi",
    country: "FI",
    label: "Finnish Patent and Registration Office (PRH open data)",
    requiredEnv: [],
    schemes: ["FI_YTUNNUS"],
    implemented: true,
    create: () => finlandAdapter,
  },
  {
    id: "ie",
    country: "IE",
    label: "Companies Registration Office",
    requiredEnv: [],
    schemes: ["IE_CRO"],
    implemented: false,
  },
];

/** Decides, for every catalogue entry, whether it is usable now and says why not if it is not. */
export function adapterStatuses(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): AdapterStatus[] {
  return ADAPTERS.map(({ create: _create, ...info }) => {
    const missing = info.requiredEnv.filter((name) => !env[name] || env[name]!.trim() === "");
    const allowed = !config.adapterAllowList || config.adapterAllowList.includes(info.id);
    if (!allowed) return { ...info, enabled: false, reason: "not in EIM_ADAPTERS allow-list" };
    if (missing.length > 0) {
      return { ...info, enabled: false, reason: `missing credentials: ${missing.join(", ")}` };
    }
    if (!info.implemented) return { ...info, enabled: false, reason: "not implemented yet" };
    return { ...info, enabled: true, reason: "enabled" };
  });
}

/** Instantiates the adapters whose status is enabled. */
export function buildAdapters(config: Config, statuses: AdapterStatus[]): SourceAdapter[] {
  const enabled = new Set(statuses.filter((s) => s.enabled).map((s) => s.id));
  return ADAPTERS.filter((a) => enabled.has(a.id) && a.create).map((a) => a.create!(config));
}
