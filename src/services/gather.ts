import { findLeiByCompaniesHouseNumber } from "../adapters/gleif/index.js";
import type { AdapterContext } from "../adapters/types.js";
import { SourceError } from "../core/errors.js";
import type { Identifier, PartialEntity, Provenance, SourceId } from "../core/types.js";
import type { Runtime } from "../runtime.js";

export interface GatherResult {
  partials: PartialEntity[];
  /** Adapters we actually called (not those skipped for missing credentials). */
  sourcesQueried: SourceId[];
  warnings: string[];
  /** True only when every piece of data came from the cache. */
  fromCache: boolean;
}

export function adapterContext(rt: Runtime, fresh?: boolean): AdapterContext {
  return { http: rt.http, cache: rt.cache, fresh, now: rt.now };
}

function allProvenance(p: PartialEntity): Provenance[] {
  return [
    ...p.names.flatMap((n) => n.provenance),
    ...p.identifiers.flatMap((i) => i.provenance),
    ...(p.status?.provenance ?? []),
  ];
}

const key = (i: Identifier): string => `${i.scheme}:${i.value}`;

export function describeFailure(source: string, err: unknown): string {
  if (err instanceof SourceError) return err.message;
  console.error(`unexpected error in ${source}:`, err instanceof Error ? err.message : err);
  return `${source}: unexpected error`;
}

/**
 * Starts from one identifier, asks every enabled adapter that understands it, and follows any new
 * identifiers they reveal (e.g. GLEIF -> Companies House number) for up to three rounds.
 * Source failures become warnings so the caller still gets whatever data was available (D28).
 */
export async function gather(
  rt: Runtime,
  seed: Identifier,
  opts: { fresh?: boolean } = {},
): Promise<GatherResult> {
  const ctx = adapterContext(rt, opts.fresh);
  const known = new Map<string, Identifier>([[key(seed), seed]]);
  const done = new Set<string>();
  const partials: PartialEntity[] = [];
  const queried = new Set<SourceId>();
  const warnings: string[] = [];
  const failed = new Set<string>();
  let crosswalkTried = false;

  for (let round = 0; round < 3; round++) {
    const jobs: {
      id: Identifier;
      run: () => Promise<PartialEntity | undefined>;
      source: SourceId;
    }[] = [];
    for (const id of known.values()) {
      for (const adapter of rt.adapters) {
        const jobKey = `${adapter.id}|${key(id)}`;
        if (done.has(jobKey) || !adapter.supports(id)) continue;
        done.add(jobKey);
        jobs.push({ id, source: adapter.id, run: () => adapter.lookup(id, ctx) });
      }
    }

    if (jobs.length > 0) {
      const results = await Promise.allSettled(
        jobs.map((j) => {
          queried.add(j.source);
          return j.run();
        }),
      );
      results.forEach((r, i) => {
        const job = jobs[i]!;
        if (r.status === "fulfilled") {
          if (r.value) {
            partials.push(r.value);
            for (const found of r.value.identifiers) {
              if (!known.has(key(found))) known.set(key(found), found);
            }
          }
        } else if (!failed.has(job.source)) {
          failed.add(job.source);
          warnings.push(describeFailure(job.source, r.reason));
        }
      });
      continue;
    }

    // No lookups left: try the reverse crosswalk UK company number -> LEI once.
    const crn = [...known.values()].find((i) => i.scheme === "GB_CRN");
    const hasLei = [...known.values()].some((i) => i.scheme === "LEI");
    const gleifOn = rt.adapters.some((a) => a.id === "gleif");
    if (crn && !hasLei && gleifOn && !crosswalkTried) {
      crosswalkTried = true;
      queried.add("gleif");
      try {
        const lei = await findLeiByCompaniesHouseNumber(crn.value, ctx);
        if (lei) {
          const found: Identifier = { scheme: "LEI", value: lei, validated: true, provenance: [] };
          known.set(key(found), found);
          continue;
        }
      } catch (err) {
        if (!failed.has("gleif")) {
          failed.add("gleif");
          warnings.push(describeFailure("gleif", err));
        }
      }
    }
    break;
  }

  if (!rt.adapters.some((a) => a.supports(seed))) {
    warnings.push(missingSourceWarning(rt, seed));
  } else if (seed.scheme !== "GB_CRN") {
    const crn = [...known.values()].find((i) => i.scheme === "GB_CRN");
    if (crn && !rt.adapters.some((a) => a.supports(crn))) {
      warnings.push(missingSourceWarning(rt, crn));
    }
  }

  const provs = partials.flatMap(allProvenance);
  return {
    partials,
    sourcesQueried: [...queried],
    warnings,
    fromCache: provs.length > 0 && provs.every((p) => p.fromCache),
  };
}

function missingSourceWarning(rt: Runtime, id: Identifier): string {
  if (id.scheme === "GB_CRN") {
    const s = rt.statuses.find((x) => x.id === "gb");
    return `Companies House not queried: ${s?.reason ?? "not enabled"}`;
  }
  return `No enabled source can look up ${id.scheme} identifiers`;
}
