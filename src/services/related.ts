import { InvalidInputError } from "../core/errors.js";
import type { Availability } from "../core/people.js";
import type { Identifier } from "../core/types.js";
import { SCREENED_SCHEMES, type ScreenSubject } from "../sanctions/index.js";
import type { Runtime } from "../runtime.js";
import type { CompanyContext } from "./company.js";
import { getOfficers } from "./officers.js";
import { DEFAULT_DEPTH, getOwnership } from "./ownership.js";

export type Include = "officers" | "owners";
export type Relation = "officer" | "owner";

export interface RelatedSubject {
  /** Every way this party is related (one person can be both officer and owner). */
  relations: Relation[];
  /** Roles / kinds of control, e.g. "officer: director; owner: ownership-of-shares-25-to-50-percent". */
  description: string;
  name: string;
  subject: ScreenSubject;
}

export interface RelatedBlock {
  requested: boolean;
  state: "screened" | "unavailable" | "not_yet_supported" | "error";
  detail?: string;
  /** Subjects handed to the screen. */
  subjects: number;
  /** Subjects that could not be screened at all (identity withheld by the registry). */
  notScreenable: number;
  /** True when the list of subjects is known to be incomplete (a result built on it is not clear). */
  incomplete: boolean;
}

export interface RelatedCollection {
  subjects: RelatedSubject[];
  officers: RelatedBlock;
  owners: RelatedBlock;
  warnings: string[];
  fromCache: boolean;
}

/** Hard cap on related subjects screened in one call. */
export const MAX_RELATED = 200;
const OFFICER_PAGE = 100;

const block = (requested: boolean): RelatedBlock => ({
  requested,
  state: "screened",
  subjects: 0,
  notScreenable: 0,
  incomplete: false,
});

/** A group whose data could not be had at all: the screen can not be called clear. */
function blockFromUnavailable(
  a: Exclude<Availability<unknown>, { state: "available" }>,
): RelatedBlock {
  return {
    ...block(true),
    state: a.state,
    detail: a.detail,
    incomplete: true,
  };
}

const registrationIds = (ids: { scheme: string; value: string }[]): string[] =>
  ids.filter((i) => SCREENED_SCHEMES.has(i.scheme)).map((i) => i.value);

type Candidate = Omit<RelatedSubject, "relations" | "description"> & {
  relation: Relation;
  description: string;
};

/**
 * Gathers the current officers and/or the owners (persons with significant control, to
 * `ownersDepth` levels) of an already-resolved company as subjects to screen. Anything that stops
 * the list from being complete is reported on its block: the caller must not turn that into a
 * clean result.
 */
export async function collectRelated(
  rt: Runtime,
  seed: Identifier,
  include: Include[],
  opts: { company: CompanyContext; ownersDepth?: number; fresh?: boolean },
): Promise<RelatedCollection> {
  const warnings: string[] = [];
  const candidates: Candidate[] = [];
  const known = new Set(opts.company.warnings);
  const newWarnings = (all: string[]): string[] => all.filter((w) => !known.has(w));

  const wantOfficers = include.includes("officers");
  const wantOwners = include.includes("owners");
  let officers = block(false);
  let owners = block(false);
  let fromCache = true;

  // The two groups are independent registry reads: fetch them side by side.
  const [off, own] = await Promise.all([
    wantOfficers
      ? getOfficers(rt, {
          seed,
          company: opts.company,
          activeOnly: true,
          limit: OFFICER_PAGE,
          fresh: opts.fresh,
        })
      : undefined,
    wantOwners
      ? getOwnership(rt, {
          seed,
          company: opts.company,
          depth: opts.ownersDepth ?? DEFAULT_DEPTH,
          includePersons: true,
          fresh: opts.fresh,
        })
      : undefined,
  ]);

  if (off) {
    officers = block(true);
    fromCache &&= off.fromCache;
    warnings.push(...newWarnings(off.warnings));
    const o = off.officers;
    if (o.state !== "available") {
      officers = blockFromUnavailable(o);
    } else {
      for (const officer of o.data.officers) {
        candidates.push({
          relation: "officer",
          description: officer.sourceRole || officer.role,
          name: officer.displayName,
          subject: {
            names: [...new Set([officer.displayName, officer.name])].filter(Boolean),
            identifiers: registrationIds(
              officer.corporateIdentifier ? [officer.corporateIdentifier] : [],
            ),
            kind: officer.kind === "person" ? "person" : "entity",
          },
        });
      }
      officers.subjects = o.data.officers.length;
      if (o.data.matching > o.data.officers.length || o.data.truncated) {
        officers.incomplete = true;
        warnings.push(
          `Only ${o.data.officers.length} of ${o.data.matching} current officers could be screened`,
        );
      }
    }
  }

  if (own) {
    owners = block(true);
    fromCache &&= own.fromCache;
    warnings.push(...newWarnings(own.warnings));
    const w = own.ownership;
    if (w.state !== "available") {
      owners = blockFromUnavailable(w);
    } else {
      const g = w.data;
      const root = g.nodes.find((n) => n.nodeId === g.rootNodeId);
      if (g.edges.length === 0 && root?.terminal) {
        // Nothing to screen is not the same as nothing screened: say why there are no owners.
        warnings.push(
          `No owners to screen: ${root.terminalDetail ?? root.terminal.replace(/_/g, " ")}`,
        );
      }
      // Every kind of control a party exercises anywhere in the graph, not just one edge's.
      const codesByController = new Map<string, Set<string>>();
      for (const e of g.edges) {
        const set = codesByController.get(e.from) ?? new Set<string>();
        for (const code of e.natures.codes) set.add(code);
        codesByController.set(e.from, set);
      }
      for (const node of g.nodes) {
        if (node.nodeId === g.rootNodeId) continue;
        if (node.terminal === "redacted" || !node.name) {
          owners.notScreenable++;
          continue;
        }
        candidates.push({
          relation: "owner",
          description: [...(codesByController.get(node.nodeId) ?? [])].join(", ") || "controller",
          name: node.name,
          subject: {
            names: [node.name],
            identifiers: registrationIds(node.identifiers),
            kind: node.kind === "person" ? "person" : "entity",
          },
        });
        owners.subjects++;
      }
      // Depth limits are by design and are stated; losing information is not.
      const lossy = g.cutBy.filter((r) => r !== "depth");
      if (lossy.length > 0) {
        owners.incomplete = true;
        warnings.push(
          `The ownership chain is incomplete (${lossy.join(", ")}), so not every owner was screened`,
        );
      }
      if (g.cutBy.includes("depth")) {
        warnings.push(
          `Owners were screened up to ${g.depthRequested} level(s); higher levels were not followed`,
        );
      }
      if (owners.notScreenable > 0) {
        owners.incomplete = true;
        warnings.push(
          `${owners.notScreenable} controller(s) have protected identities and could not be screened`,
        );
      }
    }
  }

  // One party can be both officer and owner: screen it once, keep every relation.
  const merged = new Map<string, RelatedSubject>();
  for (const c of candidates) {
    const key = `${c.subject.kind}|${c.name.toLowerCase()}`;
    const line = `${c.relation}: ${c.description}`;
    const prev = merged.get(key);
    if (prev) {
      if (!prev.relations.includes(c.relation)) prev.relations.push(c.relation);
      prev.description += `; ${line}`;
      prev.subject.identifiers = [
        ...new Set([...prev.subject.identifiers, ...c.subject.identifiers]),
      ];
    } else {
      merged.set(key, {
        relations: [c.relation],
        description: line,
        name: c.name,
        subject: { ...c.subject, identifiers: [...c.subject.identifiers] },
      });
    }
  }
  let list = [...merged.values()];
  if (list.length > MAX_RELATED) {
    warnings.push(`Only the first ${MAX_RELATED} of ${list.length} related parties were screened`);
    list = list.slice(0, MAX_RELATED);
    officers.incomplete ||= officers.requested;
    owners.incomplete ||= owners.requested;
  }
  return { subjects: list, officers, owners, warnings, fromCache };
}

/** Misuse guard shared by the tool and the service. */
export function assertIncludeNeedsEntity(include: Include[] | undefined, hasEntity: boolean): void {
  if (include && include.length > 0 && !hasEntity) {
    throw new InvalidInputError(
      "include (officers / owners) needs an entity: pass entity_id or identifier instead of a name",
    );
  }
}
