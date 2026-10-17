import { InvalidInputError } from "../core/errors.js";
import { tokenize } from "../core/text.js";
import type { EntityProfile } from "../core/entity.js";
import type { Identifier, SourceId } from "../core/types.js";
import {
  ListIndex,
  SCREENED_SCHEMES,
  SCREENING_CAVEAT,
  type ListCheck,
  type ScreeningResult,
  type SanctionsHit,
  type SanctionsListId,
  type SanctionsScreening,
  type ScreenSubject,
} from "../sanctions/index.js";
import type { Runtime } from "../runtime.js";
import { describeFailure, gather } from "./gather.js";
import type { CompanyContext } from "./company.js";
import { collectRelated, type Include, type RelatedBlock, type Relation } from "./related.js";
import { mergePartials } from "./merge.js";

export interface ScreenInput {
  /** Screen a free-text name... */
  name?: string;
  /** ...or a resolved entity (its legal and former names plus its identifiers). */
  seed?: Identifier;
  kind?: "person" | "entity" | "any";
  lists?: SanctionsListId[];
  /** Also screen the entity's current officers and/or owners (needs `seed`). */
  include?: Include[];
  /** Levels of ownership to follow when `include` has owners. */
  ownersDepth?: number;
  fresh?: boolean;
}

/** A related party (officer or owner) with a hit. Parties without hits are only counted. */
export interface RelatedHit {
  /** Every way the party is related (a person can be both officer and owner). */
  relations: Relation[];
  description: string;
  name: string;
  result: "match" | "possible_match";
  /** Best score among the party's hits. */
  score: number;
  /** Top hits (list remarks left out; the entity-level hits carry them). */
  hits: Omit<SanctionsHit, "remarks">[];
}

export interface RelatedOutcome {
  officers: RelatedBlock;
  owners: RelatedBlock;
  /** Names that were screened (personal data). */
  screened: { officers: string[]; owners: string[] };
  hits: RelatedHit[];
}

export interface ScreenOutcome {
  screening: SanctionsScreening;
  warnings: string[];
  sourcesQueried: SourceId[];
  /** Present when an entity was resolved first. */
  profile?: EntityProfile;
  /** The names and identifiers that were screened. */
  subject: ScreenSubject;
  /** Present when officers / owners were requested. */
  related?: RelatedOutcome;
  /** The worst result across the entity and every related party; never clearer than the data allows. */
  overall: ScreeningResult;
  fromCache: boolean;
}

const MAX_HITS = 25;
/** Lists are republished at least every few weeks; much older means a stalled or moved source. */
const WARN_AFTER_DAYS = 14;
/** Past this age a list can no longer support a clean result (the old OFSI feed froze after 2026-01-28 yet still downloaded fine). */
const STALE_AFTER_DAYS = 45;
const DAY_MS = 86_400_000;

/** Related parties returned with hits (D25: bounded output); the overall result still counts all. */
const MAX_RELATED_HITS = 25;
const HITS_PER_PARTY = 3;

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
  let companyCtx: CompanyContext | undefined;
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
    companyCtx = {
      profile,
      warnings: [...g.warnings],
      sourcesQueried: g.sourcesQueried,
      fromCache: g.fromCache,
    };
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

  const include = input.include ?? [];
  // Started now so it overlaps the list downloads. A handler is attached immediately: if this
  // promise rejected while the lists were still loading and nobody was listening, Node would treat
  // it as unhandled and terminate the whole server process.
  const relatedPromise =
    input.seed && companyCtx && include.length > 0
      ? collectRelated(rt, input.seed, include, {
          company: companyCtx,
          ownersDepth: input.ownersDepth,
          fresh: input.fresh,
        }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
      : undefined;

  const settled = await Promise.allSettled(
    wanted.map((list) => rt.sanctions.get(list, { fresh: input.fresh })),
  );
  const listsChecked: ListCheck[] = [];
  let listsFromCache = true;
  const hits: SanctionsHit[] = [];
  const loaded: { index: ListIndex }[] = [];
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
      loaded.push(r.value);
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

  // Officers / owners: screen each against the lists that loaded.
  let related: RelatedOutcome | undefined;
  let relatedFromCache = true;
  let overall: ScreeningResult = result;
  const listsIncomplete = listsChecked.some((c) => c.state === "unavailable" || c.stale === true);
  if (relatedPromise) {
    const settledRelated = await relatedPromise;
    if (!settledRelated.ok) throw settledRelated.error;
    const rel = settledRelated.value;
    relatedFromCache = rel.fromCache;
    warnings.push(...rel.warnings);
    let relHits: RelatedHit[] = [];
    for (const party of rel.subjects) {
      const partyHits = loaded
        .flatMap((l) => l.index.screen(party.subject, thresholds))
        .sort((a, b) => b.score - a.score);
      const best = partyHits[0]?.score ?? 0;
      if (best >= thresholds.possible) {
        const result = best >= thresholds.match ? "match" : "possible_match";
        relHits.push({
          relations: party.relations,
          description: party.description,
          name: party.name,
          result,
          score: best,
          hits: partyHits.slice(0, HITS_PER_PARTY).map(({ remarks: _remarks, ...h }) => h),
        });
        overall = worse(overall, result);
      }
    }
    relHits.sort(
      (a, b) => Number(b.result === "match") - Number(a.result === "match") || b.score - a.score,
    );
    if (relHits.length > MAX_RELATED_HITS) {
      warnings.push(
        `Showing the ${MAX_RELATED_HITS} highest-scoring of ${relHits.length} related parties with hits`,
      );
      relHits = relHits.slice(0, MAX_RELATED_HITS);
    }
    const names = (relation: Relation): string[] =>
      rel.subjects.filter((p) => p.relations.includes(relation)).map((p) => p.name);
    related = {
      officers: rel.officers,
      owners: rel.owners,
      screened: { officers: names("officer"), owners: names("owner") },
      hits: relHits,
    };
    const requestedIncomplete =
      (rel.officers.requested && rel.officers.incomplete) ||
      (rel.owners.requested && rel.owners.incomplete);
    if (requestedIncomplete) {
      overall = worse(overall, "incomplete");
      warnings.push(
        "Officers or owners could not be fully screened, so the overall result is NOT a clear result",
      );
    }
    if (relHits.length > 0) {
      warnings.push(
        "Individuals are matched by name only: confirm identity (date of birth, nationality) against the official list entry before concluding anything",
      );
    }
  } else if (listsIncomplete || nameless) {
    overall = worse(overall, "incomplete");
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
    related,
    overall,
    fromCache: entityFromCache && listsFromCache && relatedFromCache && !input.fresh,
  };
}

const SEVERITY: Record<ScreeningResult, number> = {
  no_match: 0,
  incomplete: 1,
  possible_match: 2,
  match: 3,
};

/** The more serious of two results: a match outranks everything, "incomplete" outranks "no_match". */
function worse(a: ScreeningResult, b: ScreeningResult): ScreeningResult {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}
