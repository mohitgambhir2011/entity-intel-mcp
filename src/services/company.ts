import type { Capability, SourceAdapter } from "../adapters/types.js";
import type { EntityProfile, FamilyCoverage } from "../core/entity.js";
import { InvalidInputError } from "../core/errors.js";
import type { Availability } from "../core/people.js";
import type { Identifier, PartialEntity, SourceId } from "../core/types.js";
import type { Runtime } from "../runtime.js";
import { gather } from "./gather.js";
import { mergePartials } from "./merge.js";

export interface CompanyContext {
  profile: EntityProfile;
  warnings: string[];
  sourcesQueried: SourceId[];
  fromCache: boolean;
}

/**
 * Resolves the seed to an entity first, so every personal-data family (officers, owners) hangs off
 * the same entity as get_entity. Throws InvalidInputError if nothing is found.
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
  return {
    profile: buildProfile(rt, g.partials, g.sourcesQueried),
    warnings: g.warnings,
    sourcesQueried: g.sourcesQueried,
    fromCache: g.fromCache,
  };
}

/**
 * Merges the partial records into one profile and states, per company, whether officers and
 * ownership can be had: from the enabled sources and what each country's register provides, not
 * from a fixed list that goes stale with every adapter.
 */
export function buildProfile(
  rt: Runtime,
  partials: PartialEntity[],
  sourcesTried: SourceId[],
): EntityProfile {
  const profile = mergePartials(partials, sourcesTried);
  const family = (
    found: RegistryHandle | undefined,
    capability: Capability,
    tool: string,
  ): FamilyCoverage => {
    if (found) return { state: "available", sourcesTried: [], note: `Call ${tool}` };
    const why = unavailableBecause(rt, profile, capability);
    return {
      state: why.state === "not_yet_supported" ? "not_yet_supported" : "unavailable",
      sourcesTried: [],
      note: why.state === "available" ? undefined : why.detail,
    };
  };
  profile.coverage.families.officers = family(
    findRegistry(rt, profile, "officers"),
    "officers",
    "get_officers",
  );
  profile.coverage.families.ownership = family(
    findControllersRegistry(rt, profile),
    "controllers",
    "get_ownership",
  );
  profile.coverage.families.filings = family(
    findRegistry(rt, profile, "filings"),
    "filings",
    "get_filings_and_insolvency",
  );
  profile.coverage.families.insolvency = family(
    findRegistry(rt, profile, "insolvency"),
    "insolvency",
    "get_filings_and_insolvency",
  );
  return profile;
}

export type { Capability };

export interface RegistryHandle {
  adapter: SourceAdapter;
  /** The entity's identifier that this adapter understands. */
  identifier: Identifier;
}

/**
 * The first enabled adapter that offers `capability` and understands one of the entity's
 * identifiers (its home registry), with that identifier.
 */
export function findRegistry(
  rt: Runtime,
  profile: EntityProfile,
  capability: Capability,
): RegistryHandle | undefined {
  for (const adapter of rt.adapters) {
    if (!adapter[capability]) continue;
    const identifier = profile.identifiers.find((i) => adapter.supports(i));
    if (identifier) return { adapter, identifier };
  }
  return undefined;
}

/**
 * The registry that can trace ownership. The chain walker (ownership.ts) follows Companies House
 * numbers, so a registry offering controllers under any other scheme can not be used for it yet.
 */
export function findControllersRegistry(
  rt: Runtime,
  profile: EntityProfile,
): RegistryHandle | undefined {
  const found = findRegistry(rt, profile, "controllers");
  return found?.identifier.scheme === "GB_CRN" ? found : undefined;
}

const FAMILY_LABEL: Record<Capability, string> = {
  officers: "Officer",
  controllers: "Ownership",
  filings: "Filing",
  charges: "Charge",
  insolvency: "Insolvency",
};

/**
 * Why a personal-data family can't be provided for this company, in D28's vocabulary:
 * 1. its country's register is known and says it will not provide it (restricted / not published);
 * 2. its register exists here but is switched off (missing credentials, allow-list);
 * 3. nothing here covers the company's country yet.
 */
export function unavailableBecause(
  rt: Runtime,
  profile: EntityProfile,
  capability: Capability,
): Availability<never> {
  const label = FAMILY_LABEL[capability];
  const schemes = new Set(profile.identifiers.map((i) => i.scheme));

  for (const adapter of rt.adapters) {
    const restriction = adapter.restrictions?.[capability];
    if (restriction && profile.identifiers.some((i) => adapter.supports(i))) {
      return { state: "unavailable", reason: restriction.reason, detail: restriction.detail };
    }
  }

  const off = rt.statuses.find(
    (s) => !s.enabled && s.implemented && s.schemes.some((sc) => schemes.has(sc)),
  );
  if (off) {
    return {
      state: "unavailable",
      reason: off.reason.startsWith("missing credentials") ? "requires_credentials" : "not_enabled",
      detail: `${off.label} is not enabled: ${off.reason}`,
    };
  }

  const covered = rt.adapters
    .filter((a) => a[capability] && a.country)
    .map((a) => rt.statuses.find((s) => s.enabled && s.country === a.country)?.label)
    .filter((l): l is string => Boolean(l));
  return {
    state: "not_yet_supported",
    detail:
      `${label} data is not available for this company's country yet.` +
      (covered.length > 0 ? ` Covered: ${covered.join("; ")}.` : "") +
      " Others are planned (see docs/23-coverage.md).",
  };
}
