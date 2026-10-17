import type { SourceAdapter } from "../adapters/types.js";
import type { EntityProfile } from "../core/entity.js";
import { InvalidInputError } from "../core/errors.js";
import type { Availability } from "../core/people.js";
import type { Identifier, SourceId } from "../core/types.js";
import type { Runtime } from "../runtime.js";
import { gather } from "./gather.js";
import { mergePartials } from "./merge.js";

export interface CompanyContext {
  profile: EntityProfile;
  /** The company's UK registration number, if it has one: what the officer/PSC adapter needs. */
  ukNumber?: Identifier;
  warnings: string[];
  sourcesQueried: SourceId[];
  fromCache: boolean;
}

/**
 * Resolves the seed to an entity first (so every personal-data family hangs off the same entity
 * as get_entity) and picks out its UK company number. Throws InvalidInputError if nothing is found.
 */
export async function resolveCompany(
  rt: Runtime,
  seed: Identifier,
  opts: { fresh?: boolean } = {},
): Promise<CompanyContext> {
  const g = await gather(rt, seed, opts);
  if (g.partials.length === 0) {
    const why = g.warnings.length > 0 ? ` ${g.warnings.join("; ")}` : "";
    throw new InvalidInputError(`No entity found for ${seed.scheme} ${seed.value}.${why}`);
  }
  const profile = mergePartials(g.partials, g.sourcesQueried);
  return {
    profile,
    ukNumber: profile.identifiers.find((i) => i.scheme === "GB_CRN"),
    warnings: g.warnings,
    sourcesQueried: g.sourcesQueried,
    fromCache: g.fromCache,
  };
}

/** Why a personal-data family can't be provided for this company, in D28's vocabulary. */
export function whyUnavailable(
  rt: Runtime,
  ctx: CompanyContext,
  adapter: SourceAdapter | undefined,
  family: "Officer" | "Ownership",
): Availability<never> {
  if (!ctx.ukNumber) {
    return {
      state: "not_yet_supported",
      detail:
        `${family} data is currently available only for companies registered at Companies House ` +
        "(UK). Other countries are planned (see docs/23-coverage.md).",
    };
  }
  if (!adapter) {
    const s = rt.statuses.find((x) => x.schemes.includes("GB_CRN"));
    return {
      state: "unavailable",
      reason: "requires_credentials",
      detail: `${s?.label ?? "Companies House"} is not enabled: ${s?.reason ?? "not configured"}`,
    };
  }
  return {
    state: "unavailable",
    reason: "no_such_record",
    detail: "The registry has no such company",
  };
}
