import { SourceError } from "../../core/errors.js";
import type {
  ChildList,
  GroupDirection,
  GroupParty,
  GroupRelationship,
  GroupStructure,
  ParentLink,
} from "../../core/group.js";
import { isValidLei } from "../../core/identifiers.js";
import type { Provenance } from "../../core/types.js";
import { TTL } from "../../infra/cache.js";
import { iso, type AdapterContext } from "../types.js";

const BASE = "https://api.gleif.org/api/v1";
const HEADERS = { accept: "application/vnd.api+json" };

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {};
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const day = (v: unknown): string | undefined => str(v)?.slice(0, 10);
/** Only an https link is kept: a registry-supplied reference is never followed by the server. */
const https = (v: unknown): string | undefined => {
  const s = str(v);
  return s && /^https:\/\//i.test(s) ? s.slice(0, 500) : undefined;
};
/** GLEIF vocabulary (UPPER_SNAKE): anything else is replaced, so odd text never leaves as an enum. */
const code = (v: unknown): string | undefined => {
  const s = str(v);
  return s && /^[A-Z0-9_]{1,60}$/.test(s) ? s : undefined;
};

const bad = (what: string): SourceError =>
  new SourceError(`gleif returned an unexpected ${what}`, "gleif", "bad_response");

interface Fetched<T> {
  value: T | null;
  prov: Provenance;
}

/** A cached GET that maps 404 to null (GLEIF answers 404 for "no such related record"). */
async function fetchJson(
  ctx: AdapterContext,
  url: string,
  cacheKey: string,
  recordId: string,
): Promise<Fetched<Rec>> {
  const res = await ctx.cache.getOrFetch(
    cacheKey,
    { ttlSeconds: TTL.gleif, source: "gleif", fresh: ctx.fresh },
    async (): Promise<Rec | null> => {
      const r = await ctx.http.getJson<unknown>(url, {
        source: "gleif",
        headers: HEADERS,
        allowStatus: [404],
      });
      if (r.status === 404) return null;
      const body = rec(r.body);
      if (body.data === undefined || body.data === null) throw bad("response");
      return body;
    },
  );
  return {
    value: res.value,
    prov: {
      source: "gleif",
      sourceRecordId: recordId,
      sourceUrl: url,
      retrievedAt: iso(res.fetchedAt),
      fromCache: res.fromCache,
    },
  };
}

/**
 * The entity id for a party. `localEntityId` is supplied by the adapter (it knows which registries
 * GLEIF numbers map to); this module stays independent of that table.
 */
export type LocalEntityId = (
  ra: string | undefined,
  registeredAs: string | undefined,
  lei: string,
) => string;

function partyOf(r: Rec, localEntityId: LocalEntityId): GroupParty | undefined {
  const attrs = rec(r.attributes);
  const lei = str(attrs.lei);
  if (!lei || !isValidLei(lei)) return undefined;
  const e = rec(attrs.entity);
  return {
    lei,
    name: str(rec(e.legalName).name),
    jurisdiction: str(e.jurisdiction),
    entityStatus: code(e.status),
    entityId: localEntityId(str(rec(e.registeredAt).id), str(e.registeredAs), lei),
  };
}

function relationshipOf(
  body: Rec,
  expectedStart: string,
  expectedType: string,
): { rel: GroupRelationship; end: string } {
  const attrs = rec(rec(body.data).attributes);
  const r = rec(attrs.relationship);
  const start = str(rec(r.startNode).id);
  const end = str(rec(r.endNode).id);
  const type = code(r.type);
  const status = code(r.status);
  if (!start || !end || !type || !status || !isValidLei(end)) throw bad("relationship");
  // The direct endpoint must answer with a direct relationship, and the ultimate one with an ultimate one.
  if (type !== expectedType) throw bad("relationship (wrong type)");
  // An answer about some other entity must never become this entity's relationship.
  if (start !== expectedStart) throw bad("relationship (wrong entity)");

  const periods = (Array.isArray(r.periods) ? r.periods : []).map(rec);
  const relPeriod = periods.find((p) => p.type === "RELATIONSHIP_PERIOD");
  const acct = periods.find((p) => p.type === "ACCOUNTING_PERIOD");
  const reg = rec(attrs.registration);
  const reference = https(reg.corroborationReference);
  return {
    end,
    rel: {
      type,
      status,
      startDate: day(relPeriod?.startDate),
      endDate: day(relPeriod?.endDate),
      accountingPeriod: acct ? { start: day(acct.startDate), end: day(acct.endDate) } : undefined,
      corroboration:
        reg.corroborationLevel || reg.corroborationDocuments || reference
          ? {
              level: code(reg.corroborationLevel),
              documents: code(reg.corroborationDocuments),
              reference,
            }
          : undefined,
      lastUpdated: day(reg.lastUpdateDate),
    },
  };
}

/** Runs one independent part; a source failure becomes that part's error state, not a failed call. */
async function settle<T extends { state: string }>(
  run: () => Promise<T>,
): Promise<T | { state: "error"; detail: string }> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof SourceError) return { state: "error", detail: err.message };
    throw err;
  }
}

async function parentSide(
  ctx: AdapterContext,
  lei: string,
  side: "direct" | "ultimate",
  localEntityId: LocalEntityId,
  provenance: Provenance[],
): Promise<ParentLink> {
  const relUrl = `${BASE}/lei-records/${lei}/${side}-parent-relationship`;
  const relRes = await fetchJson(ctx, relUrl, `gleif:l2:${side}-parent-rel:${lei}`, lei);
  provenance.push(relRes.prov);

  if (relRes.value) {
    const { rel, end } = relationshipOf(
      relRes.value,
      lei,
      side === "direct" ? "IS_DIRECTLY_CONSOLIDATED_BY" : "IS_ULTIMATELY_CONSOLIDATED_BY",
    );
    const recUrl = `${BASE}/lei-records/${lei}/${side}-parent`;
    const parentRes = await fetchJson(ctx, recUrl, `gleif:l2:${side}-parent:${lei}`, end);
    provenance.push(parentRes.prov);
    const parentRec = rec(parentRes.value?.data);
    const parent = partyOf(parentRec, localEntityId);
    // The record GLEIF returns must be the parent the relationship names.
    if (!parent || parent.lei !== end) throw bad("parent record");
    return { state: "reported", parent, relationship: rel };
  }

  const exUrl = `${BASE}/lei-records/${lei}/${side}-parent-reporting-exception`;
  const exRes = await fetchJson(ctx, exUrl, `gleif:l2:${side}-parent-ex:${lei}`, lei);
  provenance.push(exRes.prov);
  if (exRes.value) {
    const a = rec(rec(exRes.value.data).attributes);
    const category = code(a.category);
    const reason = code(a.reason);
    if (
      !category ||
      !reason ||
      category !== `${side.toUpperCase()}_ACCOUNTING_CONSOLIDATION_PARENT`
    ) {
      throw bad("reporting exception");
    }
    return {
      state: "reporting_exception",
      category,
      reason,
      reference: https(a.reference),
    };
  }
  return { state: "not_reported" };
}

async function children(
  ctx: AdapterContext,
  lei: string,
  limit: number,
  localEntityId: LocalEntityId,
  provenance: Provenance[],
): Promise<ChildList> {
  const url = `${BASE}/lei-records/${lei}/direct-children?page[size]=${limit}&page[number]=1`;
  const res = await fetchJson(ctx, url, `gleif:l2:children:${lei}:${limit}`, lei);
  provenance.push(res.prov);
  // 404 here means the endpoint knows no such record; "no children" is a 200 with total 0.
  if (!res.value) throw bad("children list (record not found)");
  const total = rec(rec(res.value.meta).pagination).total;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) {
    throw bad("children list (no total)");
  }
  const raw = Array.isArray(res.value.data) ? res.value.data : [];
  const items: GroupParty[] = [];
  for (const r of raw) {
    const p = partyOf(rec(r), localEntityId);
    if (p && p.lei !== lei) items.push(p);
  }
  return {
    state: "available",
    total,
    items,
    // Fewer listed than reported, whether by the page size or by records we could not read.
    truncated: items.length < total,
  };
}

/**
 * GLEIF Level 2 for one LEI. Returns undefined when GLEIF has no such LEI. The parents and the
 * children are independent: one failing is reported on its own and never hides the others.
 */
export async function fetchGroupStructure(
  lei: string,
  opts: { direction: GroupDirection; childrenLimit: number },
  ctx: AdapterContext,
  localEntityId: LocalEntityId,
): Promise<GroupStructure | undefined> {
  if (!isValidLei(lei)) return undefined;
  const exists = await fetchJson(ctx, `${BASE}/lei-records/${lei}`, `gleif:lei:${lei}`, lei);
  if (!exists.value) return undefined;
  const provenance: Provenance[] = [exists.prov];
  // GLEIF stamps every answer with the date of the golden copy it came from: say how current it is.
  const published = str(rec(rec(exists.value.meta).goldenCopy).publishDate);
  const out: GroupStructure = { lei, goldenCopyPublishedAt: published, provenance };

  const wantParents = opts.direction !== "children";
  const wantChildren = opts.direction !== "parents";
  const jobs: Promise<void>[] = [];
  if (wantParents) {
    jobs.push(
      settle(() => parentSide(ctx, lei, "direct", localEntityId, provenance)).then((v) => {
        out.directParent = v as ParentLink;
      }),
      settle(() => parentSide(ctx, lei, "ultimate", localEntityId, provenance)).then((v) => {
        out.ultimateParent = v as ParentLink;
      }),
    );
  }
  if (wantChildren) {
    jobs.push(
      settle(() => children(ctx, lei, opts.childrenLimit, localEntityId, provenance)).then((v) => {
        out.directChildren = v as ChildList;
      }),
      (async () => {
        try {
          const r = await fetchJson(
            ctx,
            `${BASE}/lei-records/${lei}/ultimate-children?page[size]=1&page[number]=1`,
            `gleif:l2:uchildren:${lei}`,
            lei,
          );
          provenance.push(r.prov);
          const total = rec(rec(r.value?.meta).pagination).total;
          if (typeof total === "number" && Number.isInteger(total) && total >= 0) {
            out.ultimateChildrenTotal = total;
          }
        } catch (err) {
          if (!(err instanceof SourceError)) throw err;
          // Left absent: the caller can see it is unknown, and directChildren reports its own state.
        }
      })(),
    );
  }
  await Promise.all(jobs);
  return out;
}
