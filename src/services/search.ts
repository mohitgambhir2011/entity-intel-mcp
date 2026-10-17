import type { SourceAdapter } from "../adapters/types.js";
import { detectIdentifier, makeIdentifier } from "../core/identifiers.js";
import type { EntityStatus, Identifier, SearchHit, SourceId } from "../core/types.js";
import { sourceRank } from "../core/sources.js";
import { normaliseName } from "../resolution/normalise.js";
import { scoreName, type ConfidenceBand } from "../resolution/score.js";
import type { Runtime } from "../runtime.js";
import { adapterContext, describeFailure, gather } from "./gather.js";
import { chooseEntityId, mergePartials } from "./merge.js";

export interface Candidate {
  entityId: string;
  name: string;
  jurisdiction?: string;
  status?: EntityStatus;
  address?: string;
  identifiers: { scheme: string; value: string; country?: string }[];
  sources: SourceId[];
  match: { confidence: number; band: ConfidenceBand; reasons: string[]; warnings: string[] };
}

export interface SearchOutcome {
  candidates: Candidate[];
  total: number;
  warnings: string[];
  sourcesQueried: SourceId[];
  fromCache: boolean;
}

export interface SearchInput {
  query: string;
  country?: string;
  status?: "operating" | "distressed" | "ended" | "any";
  limit?: number;
  fresh?: boolean;
}

export async function searchEntities(rt: Runtime, input: SearchInput): Promise<SearchOutcome> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 25);
  const country = input.country?.toUpperCase();
  const query = input.query.trim();

  // An identifier resolves exactly: one candidate, band "certain" (D26).
  const detected = detectIdentifier(query, country);
  if (detected) return searchByIdentifier(rt, detected, input.fresh);

  const warnings: string[] = [];
  if (/^\d{6,9}$/.test(query.replace(/\s/g, "")) && !country) {
    warnings.push(
      "This looks like a company number; add country=GB, country=IE, country=NO or country=FI to look it up in that register",
    );
  }

  // With a country filter, only that country's register is searched (plus the multi-country
  // sources, whose hits are filtered by jurisdiction below).
  const inScope = (a: SourceAdapter): boolean => !country || !a.country || a.country === country;
  const active = rt.adapters.filter((a) => a.search && inScope(a));
  if ((!country || country === "GB") && !rt.adapters.some((a) => a.id === "companies_house")) {
    const s = rt.statuses.find((x) => x.id === "gb");
    warnings.push(`Companies House not searched: ${s?.reason ?? "not enabled"}`);
  }

  const ctx = adapterContext(rt, input.fresh);
  const results = await Promise.allSettled(active.map((a) => a.search!(query, ctx, 25)));
  const hits: SearchHit[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") hits.push(...r.value);
    else warnings.push(describeFailure(active[i]!.id, r.reason));
  });

  const filtered = country ? hits.filter((h) => h.jurisdiction?.toUpperCase() === country) : hits;
  let candidates = group(filtered, query);

  if (input.status && input.status !== "any") {
    const before = candidates.length;
    candidates = candidates.filter((c) => c.status?.group === input.status);
    const dropped = before - candidates.length;
    if (dropped > 0)
      warnings.push(`${dropped} candidates not matching status "${input.status}" were left out`);
  }

  candidates.sort(
    (a, b) =>
      b.match.confidence - a.match.confidence ||
      Number(b.status?.group === "operating") - Number(a.status?.group === "operating"),
  );
  addCrossCandidateWarnings(candidates);

  const fromCache =
    filtered.length > 0 && filtered.every((h) => h.identifier.provenance.every((p) => p.fromCache));
  return {
    candidates: candidates.slice(0, limit),
    total: candidates.length,
    warnings,
    sourcesQueried: active.map((a) => a.id),
    fromCache,
  };
}

async function searchByIdentifier(
  rt: Runtime,
  detected: NonNullable<ReturnType<typeof detectIdentifier>>,
  fresh?: boolean,
): Promise<SearchOutcome> {
  const seed = makeIdentifier(detected.scheme, detected.value, { country: detected.country });
  const g = await gather(rt, seed, { fresh });
  const warnings = [...g.warnings];
  if (g.partials.length === 0) {
    warnings.push("No source returned a record for this identifier");
    return {
      candidates: [],
      total: 0,
      warnings,
      sourcesQueried: g.sourcesQueried,
      fromCache: false,
    };
  }
  const profile = mergePartials(g.partials, g.sourcesQueried);
  const name = profile.names.find((n) => n.kind === "legal")?.name ?? "(name not published)";
  const candidate: Candidate = {
    entityId: profile.entityId,
    name,
    jurisdiction: profile.jurisdiction,
    status: profile.status?.value,
    address: profile.registeredAddress?.value.formatted,
    identifiers: profile.identifiers.map((i) => ({
      scheme: i.scheme,
      value: i.value,
      country: i.country,
    })),
    sources: profile.sources,
    match: {
      confidence: 1,
      band: "certain",
      reasons: [`exact ${detected.scheme} identifier match`],
      warnings: [],
    },
  };
  return {
    candidates: [candidate],
    total: 1,
    warnings,
    sourcesQueried: g.sourcesQueried,
    fromCache: g.fromCache,
  };
}

/**
 * Merges hits that are the same name in the same country but come from DIFFERENT sources (e.g. the
 * GLEIF and Companies House records of one company). Two records from the same source are two
 * entities, however similar their names: name-only matches never merge entities.
 */
function group(hits: SearchHit[], query: string): Candidate[] {
  const groups = new Map<string, SearchHit[][]>();
  for (const h of hits) {
    const k = `${h.jurisdiction ?? "?"}|${normaliseName(h.name).key}`;
    const buckets = groups.get(k) ?? [];
    // Put the hit in the first bucket that has no record from its source yet.
    const bucket = buckets.find((b) => !b.some((x) => x.source === h.source));
    if (bucket) bucket.push(h);
    else buckets.push([h]);
    groups.set(k, buckets);
  }
  return [...groups.values()].flat().map((g) => {
    const sorted = [...g].sort((a, b) => sourceRank(a.source) - sourceRank(b.source));
    const best = sorted[0]!;
    const identifiers: Identifier[] = sorted.map((h) => h.identifier);
    const m = scoreName(query, best.name);
    const reasons = [...m.reasons];
    if (sorted.length > 1) {
      reasons.push(`same name and country in ${new Set(sorted.map((h) => h.source)).size} sources`);
    }
    const warnings = [...m.warnings];
    const status =
      sorted.find((h) => h.status && h.status.normalized !== "unknown")?.status ?? best.status;
    if (status && status.group !== "operating" && status.group !== "unknown") {
      warnings.push(`entity status is ${status.normalized.replace(/_/g, " ")}`);
    }
    return {
      entityId: chooseEntityId(identifiers, best.name, best.jurisdiction),
      name: best.name,
      jurisdiction: best.jurisdiction,
      status,
      address: sorted.find((h) => h.address)?.address,
      identifiers: identifiers.map((i) => ({
        scheme: i.scheme,
        value: i.value,
        country: i.country,
      })),
      sources: [...new Set(sorted.map((h) => h.source))],
      match: { confidence: m.score, band: m.band, reasons, warnings },
    };
  });
}

function addCrossCandidateWarnings(candidates: Candidate[]): void {
  const byName = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const k = normaliseName(c.name).key;
    byName.set(k, [...(byName.get(k) ?? []), c]);
  }
  for (const list of byName.values()) {
    const countries = new Set(list.map((c) => c.jurisdiction));
    if (list.length > 1 && countries.size > 1) {
      for (const c of list) c.match.warnings.push("same name also appears in another country");
    } else if (list.length > 1) {
      for (const c of list)
        c.match.warnings.push("several entities share this name: verify by identifier");
    }
  }
}
