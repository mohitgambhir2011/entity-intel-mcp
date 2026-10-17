import type { CountryCode, Identifier, IdentifierScheme } from "./types.js";

/** EU VAT prefixes as used by VIES. Greece is "EL"; Northern Ireland goods use "XI". */
export const VIES_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "EL",
  "ES",
  "FI",
  "FR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
  "XI",
]);

export function stripSeparators(raw: string): string {
  return raw.replace(/[\s.\-_/]/g, "").toUpperCase();
}

/** ISO 17442 LEI: 18 alphanumerics + 2 check digits, ISO 7064 MOD 97-10. */
export function isValidLei(input: string): boolean {
  const lei = stripSeparators(input);
  if (!/^[A-Z0-9]{18}[0-9]{2}$/.test(lei)) return false;
  let remainder = 0;
  for (const ch of lei) {
    const digits = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

/** Companies House number: 8 digits, or a 2-letter prefix + 6 digits (SC, NI, OC, SO...). */
export function normalizeGbCompanyNumber(input: string): string | undefined {
  const raw = stripSeparators(input);
  if (/^[0-9]{1,8}$/.test(raw)) return raw.padStart(8, "0");
  if (/^[A-Z]{2}[0-9]{6}$/.test(raw)) return raw;
  return undefined;
}

export interface ParsedVat {
  country: CountryCode;
  number: string;
}

/** Splits "IE6388047V" / "IE 6388047V" into country + number. Does not validate the number. */
export function parseVat(input: string): ParsedVat | undefined {
  const raw = stripSeparators(input);
  const country = raw.slice(0, 2);
  const number = raw.slice(2);
  if (!VIES_COUNTRIES.has(country) || number.length < 4 || number.length > 14) return undefined;
  if (!/^[A-Z0-9]+$/.test(number)) return undefined;
  return { country, number };
}

export interface DetectedIdentifier {
  scheme: IdentifierScheme;
  value: string;
  country?: CountryCode;
}

/**
 * Best-effort detection of what a bare string is. Ambiguous shapes (e.g. 8 digits could be a GB
 * company number or something else) are only resolved when `country` is given or the shape is unique.
 */
export function detectIdentifier(
  input: string,
  country?: CountryCode,
): DetectedIdentifier | undefined {
  const raw = stripSeparators(input);
  if (raw.length === 20 && isValidLei(raw)) return { scheme: "LEI", value: raw };
  const vat = /^[A-Z]{2}/.test(raw) ? parseVat(raw) : undefined;
  if (vat && !/^(SC|NI|OC|SO|OE|NC|FC|SL|LP|SP|R0|IP|NP|RC|NV|ZC|GE|GS|IC|NL)[0-9]{6}$/.test(raw)) {
    return { scheme: "VAT", value: raw, country: vat.country };
  }
  const gb = normalizeGbCompanyNumber(raw);
  if (gb && (country?.toUpperCase() === "GB" || /^[A-Z]{2}[0-9]{6}$/.test(gb))) {
    return { scheme: "GB_CRN", value: gb, country: "GB" };
  }
  return undefined;
}

export function makeIdentifier(
  scheme: IdentifierScheme,
  value: string,
  fields: Partial<Omit<Identifier, "scheme" | "value">> = {},
): Identifier {
  return { scheme, value, validated: false, provenance: [], ...fields };
}
