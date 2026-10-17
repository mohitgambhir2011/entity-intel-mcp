import { InvalidInputError } from "../core/errors.js";
import {
  detectIdentifier,
  isValidLei,
  makeIdentifier,
  normalizeGbCompanyNumber,
  parseVat,
  stripSeparators,
} from "../core/identifiers.js";
import type { Identifier, IdentifierScheme } from "../core/types.js";

export interface EntityRefInput {
  entity_id?: string;
  identifier?: string;
  scheme?: string;
  country?: string;
}

export const SUPPORTED_SCHEMES = ["LEI", "GB_CRN", "VAT"] as const;

/** Turns tool arguments into one Identifier to start a lookup from. Throws InvalidInputError. */
export function resolveRef(input: EntityRefInput): Identifier {
  if (input.entity_id && input.identifier) {
    throw new InvalidInputError("Provide either entity_id or identifier, not both");
  }
  if (input.entity_id) return fromEntityId(input.entity_id.trim());
  if (input.identifier) return fromIdentifier(input.identifier, input.scheme, input.country);
  throw new InvalidInputError("Provide entity_id or identifier");
}

function fromEntityId(id: string): Identifier {
  const parts = id.split(":");
  if (parts[0] === "GB" && parts[1] === "CH" && parts[2]) {
    const n = normalizeGbCompanyNumber(parts[2]);
    if (n) return makeIdentifier("GB_CRN", n, { country: "GB" });
  }
  if (parts[0] === "ID" && parts[1] === "LEI" && parts[2] && isValidLei(parts[2])) {
    return makeIdentifier("LEI", parts[2].toUpperCase());
  }
  if (parts[0] === "ID" && parts[1] === "VAT" && parts[2] && parseVat(parts[2])) {
    return makeIdentifier("VAT", parts[2].toUpperCase());
  }
  if (parts[0] === "hash") {
    throw new InvalidInputError(
      "Entity ids starting with 'hash:' come from name matches and cannot be looked up directly; " +
        "search again and use a company number, LEI or VAT number",
    );
  }
  throw new InvalidInputError(`Unrecognised entity_id format: ${id.slice(0, 40)}`);
}

function fromIdentifier(raw: string, scheme?: string, country?: string): Identifier {
  const upper = scheme?.toUpperCase() as IdentifierScheme | undefined;
  if (upper) {
    if (!(SUPPORTED_SCHEMES as readonly string[]).includes(upper)) {
      throw new InvalidInputError(
        `Scheme ${upper} is not supported yet. Supported: ${SUPPORTED_SCHEMES.join(", ")}`,
      );
    }
    const value = stripSeparators(raw);
    if (upper === "LEI") {
      if (!isValidLei(value))
        throw new InvalidInputError("Not a valid LEI (length or check digits)");
      return makeIdentifier("LEI", value, { validated: true });
    }
    if (upper === "GB_CRN") {
      const n = normalizeGbCompanyNumber(value);
      if (!n) throw new InvalidInputError("Not a valid UK company number");
      return makeIdentifier("GB_CRN", n, { country: "GB" });
    }
    const vat = parseVat(value);
    if (!vat) {
      throw new InvalidInputError(
        "Not a recognised EU VAT number: it must start with a VIES country code (e.g. IE, DE, FR). " +
          "UK (GB) VAT numbers are not covered by VIES.",
      );
    }
    return makeIdentifier("VAT", `${vat.country}${vat.number}`, { country: vat.country });
  }

  const detected = detectIdentifier(raw, country);
  if (!detected) {
    throw new InvalidInputError(
      "Could not tell what kind of identifier this is. Pass scheme (LEI, GB_CRN or VAT), " +
        "or country=GB for a UK company number.",
    );
  }
  return makeIdentifier(detected.scheme, detected.value, { country: detected.country });
}
