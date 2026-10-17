import type { SanctionEntry, SanctionsListId } from "./types.js";
import { parseEu } from "./parsers/eu.js";
import { parseOfac } from "./parsers/ofac.js";
import { parseUk } from "./parsers/uk.js";

export interface ListDefinition {
  id: SanctionsListId;
  label: string;
  /** Official bulk download. Public; no credentials are sent. */
  url: string;
  /** Host suffixes the download may be redirected to (the publisher's CDN). */
  redirectHosts: string[];
  /** A snapshot with fewer entries is treated as a broken download and never cached. */
  minEntries: number;
  parse(xml: string): { entries: SanctionEntry[]; versionDate?: string };
}

/**
 * The EU file is published behind a fixed public token (documented on the EU Financial Sanctions
 * Files page); it can be overridden with EIM_EU_SANCTIONS_URL if the EU rotates it.
 */
export const EU_DEFAULT_URL =
  "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw";

export function listDefinitions(overrides: { euUrl?: string } = {}): ListDefinition[] {
  return [
    {
      id: "UK",
      label: "UK Sanctions List (FCDO; replaced the OFSI Consolidated List on 2026-01-28)",
      url: "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml",
      redirectHosts: [],
      minEntries: 3000,
      parse: parseUk,
    },
    {
      id: "EU",
      label: "EU consolidated financial sanctions list",
      url: overrides.euUrl ?? EU_DEFAULT_URL,
      redirectHosts: [],
      minEntries: 1000,
      parse: parseEu,
    },
    {
      id: "OFAC_SDN",
      label: "US OFAC SDN list",
      url: "https://www.treasury.gov/ofac/downloads/sdn.xml",
      // Treasury redirects to a pre-signed object-store URL.
      redirectHosts: [".treasury.gov", ".treas.gov", ".amazonaws.com"],
      minEntries: 5000,
      parse: parseOfac,
    },
  ];
}
