import type { SourceId } from "./types.js";

/**
 * Which source wins when several describe the same thing: the home registry first, then GLEIF,
 * then VIES (which only confirms that a VAT number is valid). Append new registries before gleif.
 */
export const SOURCE_PRIORITY: SourceId[] = [
  "companies_house",
  "fca",
  "brreg_no",
  "prh_fi",
  "gleif",
  "vies",
];

/** Lower is better; unknown sources rank last. */
export function sourceRank(source: SourceId): number {
  const i = SOURCE_PRIORITY.indexOf(source);
  return i === -1 ? SOURCE_PRIORITY.length : i;
}
