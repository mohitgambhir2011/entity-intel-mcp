import type { AdapterContext, SourceAdapter } from "../adapters/types.js";
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

const MAX_ROUNDS = 3;

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

interface Job<T> {
  adapter: SourceAdapter;
  run: () => Promise<T>;
}

/**
 * Starts from one identifier, asks every enabled adapter that understands it, and follows the
 * identifiers they reveal (lookups) or can be translated into (crosswalks, e.g. UK company number
 * to LEI) for up to three rounds. Lookups and crosswalks of one round run concurrently.
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

  const warn = (source: string, reason: unknown): void => {
    if (failed.has(source)) return; // one warning per source is enough
    failed.add(source);
    warnings.push(describeFailure(source, reason));
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const lookups: Job<PartialEntity | undefined>[] = [];
    const crosswalks: Job<Identifier | undefined>[] = [];
    const schemesKnown = new Set([...known.values()].map((i) => i.scheme));

    for (const id of known.values()) {
      for (const adapter of rt.adapters) {
        const lookupKey = `${adapter.id}|lookup|${key(id)}`;
        if (!done.has(lookupKey) && adapter.supports(id)) {
          done.add(lookupKey);
          lookups.push({ adapter, run: () => adapter.lookup(id, ctx) });
        }
        for (const cw of adapter.crosswalks ?? []) {
          const cwKey = `${adapter.id}|${cw.from}>${cw.to}|${key(id)}`;
          // Only translate when we do not already know an identifier of the target scheme.
          if (id.scheme !== cw.from || schemesKnown.has(cw.to) || done.has(cwKey)) continue;
          done.add(cwKey);
          crosswalks.push({ adapter, run: () => cw.find(id, ctx) });
        }
      }
    }
    if (lookups.length === 0 && crosswalks.length === 0) break;
    for (const job of [...lookups, ...crosswalks]) queried.add(job.adapter.id);

    const [lookupResults, crosswalkResults] = await Promise.all([
      Promise.allSettled(lookups.map((j) => j.run())),
      Promise.allSettled(crosswalks.map((j) => j.run())),
    ]);

    lookupResults.forEach((r, i) => {
      const source = lookups[i]!.adapter.id;
      if (r.status === "rejected") return warn(source, r.reason);
      if (!r.value) return;
      partials.push(r.value);
      for (const found of r.value.identifiers) {
        if (!known.has(key(found))) known.set(key(found), found);
      }
    });
    crosswalkResults.forEach((r, i) => {
      const source = crosswalks[i]!.adapter.id;
      if (r.status === "rejected") return warn(source, r.reason);
      if (r.value && !known.has(key(r.value))) known.set(key(r.value), r.value);
    });
  }

  // Say why an identifier could not be followed because its source is switched off.
  for (const id of known.values()) {
    if (!rt.adapters.some((a) => a.supports(id))) {
      const why = missingSourceWarning(rt, id, id === seed);
      if (why) warnings.push(why);
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

/**
 * Explains why no enabled adapter handles `id`: names the disabled adapter that would, with its
 * reason (e.g. the missing environment variable). Identifiers discovered along the way (not the
 * seed) are only reported when a disabled adapter exists for them; a bare "no source" would be
 * noise for schemes we have never supported.
 */
function missingSourceWarning(rt: Runtime, id: Identifier, isSeed: boolean): string | undefined {
  const disabled = rt.statuses.filter((s) => !s.enabled && s.schemes.includes(id.scheme));
  if (disabled.length > 0) {
    return disabled.map((s) => `${s.label} not queried: ${s.reason}`).join("; ");
  }
  return isSeed ? `No enabled source can look up ${id.scheme} identifiers` : undefined;
}
