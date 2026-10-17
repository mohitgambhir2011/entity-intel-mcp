import { InvalidInputError } from "../core/errors.js";
import { tokenize } from "../core/text.js";
import type { EntityProfile } from "../core/entity.js";
import type { Identifier, SourceId } from "../core/types.js";
import {
  SCREENING_CAVEAT,
  type ListCheck,
  type SanctionsHit,
  type SanctionsListId,
  type SanctionsScreening,
  type ScreenSubject,
} from "../sanctions/index.js";
import type { Runtime } from "../runtime.js";
import { describeFailure, gather } from "./gather.js";
import { mergePartials } from "./merge.js";

export interface ScreenInput {
  /** Screen a free-text name... */
  name?: string;
  /** ...or a resolved entity (its legal and former names plus its identifiers). */
  seed?: Identifier;
  kind?: "person" | "entity" | "any";
  lists?: SanctionsListId[];
  fresh?: boolean;
}

export interface ScreenOutcome {
  screening: SanctionsScreening;
  warnings: string[];
  sourcesQueried: SourceId[];
  /** Present when an entity was resolved first. */
  profile?: EntityProfile;
  /** The names and identifiers that were screened. */
  subject: ScreenSubject;
  fromCache: boolean;
}

const MAX_HITS = 25;
/** Lists are republished at least every few weeks; much older means a stalled or moved source. */
const WARN_AFTER_DAYS = 14;
/** Past this age a list can no longer support a clean result (the old OFSI feed froze after 2026-01-28 yet still downloaded fine). */
const STALE_AFTER_DAYS = 45;
const DAY_MS = 86_400_000;

/** Identifier schemes that sanctions lists may carry as registration numbers. */
const SCREENED_SCHEMES = new Set(["LEI", "GB_CRN", "VAT"]);

/**
 * Screens a name or a resolved entity against the selected lists. Never reports "no_match" when a
 * list could not be checked: that would turn an outage into a clean result (D28).
 */
export async function screenSanctions(rt: Runtime, input: ScreenInput): Promise<ScreenOutcome> {
  if (!input.name && !input.seed) throw new InvalidInputError("Provide a name or an entity");
  if (input.name && input.seed) {
    throw new InvalidInputError(
      "Provide either a name or an entity (entity_id/identifier), not both",
    );
  }

  const warnings: string[] = [];
  let sourcesQueried: SourceId[] = [];
  let profile: EntityProfile | undefined;
  let entityFromCache = true;
  let subject: ScreenSubject;

  if (input.seed) {
    const g = await gather(rt, input.seed, { fresh: input.fresh });
    warnings.push(...g.warnings);
    sourcesQueried = g.sourcesQueried;
    if (g.partials.length === 0) {
      throw new InvalidInputError(
        `No entity found for ${input.seed.scheme} ${input.seed.value}, so there is nothing to screen. ` +
          "Screen by name instead.",
      );
    }
    profile = mergePartials(g.partials, g.sourcesQueried);
    entityFromCache = g.fromCache;
    subject = {
      names: [
        ...new Set(
          profile.names
            .filter((n) => n.kind === "legal" || n.kind === "former" || n.kind === "trading")
            .map((n) => n.name),
        ),
      ],
      identifiers: profile.identifiers
        .filter((i) => SCREENED_SCHEMES.has(i.scheme))
        .map((i) => i.value),
      kind: "entity",
    };
  } else {
    const name = input.name!.trim();
    // A name with no letters or digits (whitespace, punctuation) screens nothing; reporting
    // "no_match" for it would be a false all-clear.
    if (tokenize(name).length === 0) {
      throw new InvalidInputError("The name contains no letters or digits to screen");
    }
    subject = { names: [name], identifiers: [], kind: input.kind ?? "any" };
  }

  const wanted = [...new Set(input.lists?.length ? input.lists : rt.sanctions.lists)];
  const thresholds = { match: rt.config.sanctionsMatch, possible: rt.config.sanctionsPossible };

  const settled = await Promise.allSettled(
    wanted.map((list) => rt.sanctions.get(list, { fresh: input.fresh })),
  );
  const listsChecked: ListCheck[] = [];
  let listsFromCache = true;
  const hits: SanctionsHit[] = [];
  settled.forEach((r, i) => {
    const list = wanted[i]!;
    if (r.status === "fulfilled") {
      const ageDays = r.value.versionDate
        ? Math.floor((rt.now().getTime() - Date.parse(r.value.versionDate)) / DAY_MS)
        : undefined;
      const stale = ageDays !== undefined && ageDays > STALE_AFTER_DAYS;
      listsChecked.push({
        list,
        state: "checked",
        versionDate: r.value.versionDate,
        fetchedAt: r.value.fetchedAt,
        entries: r.value.entries,
        ageDays: ageDays !== undefined && ageDays >= 0 ? ageDays : undefined,
        stale: stale || undefined,
      });
      if (ageDays !== undefined && ageDays > WARN_AFTER_DAYS) {
        warnings.push(
          `${list} is ${ageDays} days old (version ${r.value.versionDate}): the publisher may have stopped updating it`,
        );
      }
      listsFromCache &&= r.value.fromCache;
      hits.push(...r.value.index.screen(subject, thresholds));
    } else {
      const reason = describeFailure(list, r.reason);
      listsChecked.push({ list, state: "unavailable", reason });
      warnings.push(`${list} could not be checked: ${reason}`);
    }
  });

  hits.sort((a, b) => b.score - a.score || a.list.localeCompare(b.list));
  const capped = hits.slice(0, MAX_HITS);
  if (hits.length > MAX_HITS) {
    warnings.push(`Showing the ${MAX_HITS} highest-scoring of ${hits.length} hits`);
  }

  // An entity whose registry publishes no name (e.g. a German VAT number via VIES) can only be
  // screened by identifier, which is far weaker: say so instead of reporting a clean result.
  const nameless = subject.names.length === 0;
  if (nameless) {
    warnings.push(
      "This entity has no published name, so it was screened by identifier only: NOT a clear result. Screen by name once known",
    );
  }
  const top = capped[0]?.score ?? 0;
  const incomplete =
    nameless || listsChecked.some((c) => c.state === "unavailable" || c.stale === true);
  const result: SanctionsScreening["result"] =
    top >= thresholds.match
      ? "match"
      : top >= thresholds.possible
        ? "possible_match"
        : incomplete
          ? "incomplete"
          : "no_match";
  if (result === "incomplete" && listsChecked.some((c) => c.stale)) {
    warnings.push("A list is too old to rely on, so this is NOT a clear result");
  }
  if (result === "incomplete" && listsChecked.some((c) => c.state === "unavailable")) {
    warnings.push("Not all requested lists were checked, so this is NOT a clear result");
  }
  if (capped.some((h) => h.basis === "exact_identifier")) {
    warnings.push(
      "Identifier hits compare registration numbers only, not the issuing country: check the jurisdiction",
    );
  }
  if (capped.some((h) => h.weakAlias)) {
    warnings.push("Some hits are to low-quality aliases and are capped below the match threshold");
  }

  return {
    screening: {
      screenedAt: rt.now().toISOString(),
      result,
      listsChecked,
      hits: capped,
      thresholds,
      caveat: SCREENING_CAVEAT,
    },
    warnings,
    sourcesQueried,
    profile,
    subject,
    fromCache: entityFromCache && listsFromCache && !input.fresh,
  };
}
