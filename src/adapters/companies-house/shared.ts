import type { Address } from "../../core/types.js";

export const BASE = "https://api.company-information.service.gov.uk";
export const LICENCE = "Open Government Licence v3.0";

export interface ChAddress {
  address_line_1?: string;
  address_line_2?: string;
  premises?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
}

export function mapAddress(a: ChAddress | undefined): Address | undefined {
  if (!a) return undefined;
  const lines = [a.premises, a.address_line_1, a.address_line_2].filter(
    (l): l is string => typeof l === "string" && l !== "",
  );
  const parts = [...lines, a.locality, a.region, a.postal_code, a.country].filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
  if (parts.length === 0) return undefined;
  return {
    lines,
    locality: a.locality,
    region: a.region,
    postalCode: a.postal_code,
    country: "GB",
    formatted: parts.join(", "),
  };
}

export function authHeader(key: string): Record<string, string> {
  // Companies House uses HTTP Basic with the API key as the username and an empty password.
  return { authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` };
}
