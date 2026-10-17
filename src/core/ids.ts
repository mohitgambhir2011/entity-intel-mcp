import { createHash } from "node:crypto";
import type { CountryCode } from "./types.js";

/** D20: "<country>:<registry>:<number>", e.g. "GB:CH:00445790". */
export function makeEntityId(country: CountryCode, registry: string, number: string): string {
  return `${country.toUpperCase()}:${registry.toUpperCase()}:${number}`;
}

/** D20 fallback when no registry number is known: hash of normalised name + country. */
export function fallbackEntityId(name: string, country: CountryCode): string {
  const norm = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const h = createHash("sha256")
    .update(`${country.toUpperCase()}|${norm}`)
    .digest("hex")
    .slice(0, 12);
  return `hash:${country.toUpperCase()}:${h}`;
}
