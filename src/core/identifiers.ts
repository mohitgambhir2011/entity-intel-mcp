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
  if (!/^[A-Z0-9+*]+$/.test(number) || !/[0-9]/.test(number)) return undefined;
  return { country, number };
}

/**
 * Published VAT number shapes per VIES country (number part, without the country prefix).
 * Used to decide whether free text is a VAT number: parseVat alone is too lenient, because many
 * company names start with a country code ("Deutsche Bank" -> DE + UTSCHEBANK).
 */
const VAT_SHAPES: Record<string, RegExp> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^(\d{7}[A-W][A-IW]?|d[A-Z+*]\d{5}[A-W])$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
  XI: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};

/** True when the number part has the published shape for its country. */
export function hasVatShape(vat: ParsedVat): boolean {
  return VAT_SHAPES[vat.country]?.test(vat.number) ?? false;
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
  const vat = parseVat(raw);
  if (vat && hasVatShape(vat)) return { scheme: "VAT", value: raw, country: vat.country };
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
