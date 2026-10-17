import { createHash } from "node:crypto";
import { SourceError } from "../core/errors.js";
import type { EntityProfile } from "../core/entity.js";
import type {
  Availability,
  BirthDate,
  ControlNatures,
  Controller,
  ControllersResult,
} from "../core/people.js";
import type { AdapterContext } from "../adapters/types.js";
import type { Identifier, Provenance, SourceId } from "../core/types.js";
import type { Runtime } from "../runtime.js";
import {
  findControllersRegistry,
  resolveCompany,
  unavailableBecause,
  type CompanyContext,
} from "./company.js";
import { adapterContext, describeFailure } from "./gather.js";
import { fallbackEntityId, makeEntityId } from "../core/ids.js";

/** Default and maximum number of levels followed upwards from the company (D22). */
export const DEFAULT_DEPTH = 3;
export const MAX_DEPTH = 10;
/** Companies whose controllers are fetched in one call: protects the registry quota (D22). */
export const MAX_COMPANIES = 30;
/** Output cap so one huge group can not flood the assistant's context (D25). */
const MAX_NODES = 200;
/** Companies of one level fetched at the same time (the per-host rate limiter still applies). */
const CONCURRENCY = 5;

export type TerminalReason =
  /** A natural person: the end of the chain. */
  | "natural_person"
  /** The company is exempt from PSC reporting (e.g. listed on a regulated market). */
  | "exempt"
  /** The company filed a statement instead of naming controllers. */
  | "statement"
  /** The registry lists controllers but every one has ceased. */
  | "all_ceased"
  /** The registry lists no controllers and no reason. */
  | "no_controllers_published"
  /** A corporate controller we can not follow (foreign or unidentified registry). */
  | "not_followable"
  /** The identity of a controller is withheld by the registry. */
  | "redacted"
  | "depth_limit"
  | "budget"
  | "error";

export interface OwnershipNode {
  nodeId: string;
  kind: "entity" | "person";
  name?: string;
  entityId?: string;
  identifiers: { scheme: string; value: string }[];
  /** Levels above the screened company (0 = the company itself). */
  level: number;
  terminal?: TerminalReason;
  terminalDetail?: string;
  /** Registration details of a corporate controller we could not follow. */
  registration?: Controller["registration"];
  person?: {
    nationality?: string;
    countryOfResidence?: string;
    birth?: BirthDate;
  };
}

export interface OwnershipEdge {
  /** The controller. */
  from: string;
  /** The controlled company. */
  to: string;
  natures: ControlNatures;
  notifiedOn?: string;
  ceasedOn?: string;
  active: boolean;
}

/** Why a chain was not followed to its end. `depth` is by design; the others lose information. */
export type CutReason = "depth" | "budget" | "size" | "error" | "registry";

export interface OwnershipGraph {
  rootNodeId: string;
  nodes: OwnershipNode[];
  edges: OwnershipEdge[];
  depthRequested: number;
  /** Deepest level that holds a node. */
  depthReached: number;
  companiesExpanded: number;
  /** True if any chain was cut short (see cutBy). */
  truncated: boolean;
  cutBy: CutReason[];
  /** Nodes that nobody in the graph owns: the tops of the chains. */
  ultimateOwners: {
    nodeId: string;
    kind: "entity" | "person";
    name?: string;
    terminal?: TerminalReason;
  }[];
  personsOmitted: number;
  provenance: Provenance[];
}

export interface OwnershipInput {
  seed: Identifier;
  depth?: number;
  includeCeased?: boolean;
  includePersons?: boolean;
  fresh?: boolean;
  /** Already-resolved company (saves resolving it again). */
  company?: CompanyContext;
}

export interface OwnershipOutcome {
  profile: EntityProfile;
  ownership: Availability<OwnershipGraph>;
  warnings: string[];
  sourcesQueried: SourceId[];
  fromCache: boolean;
}

/**
 * Stable id for an individual controller, the same wherever in the graph they appear, so one person
 * controlling two companies is one node. Derived from what the registry publishes (name, birth
 * month and year, nationality, residence): enough to tell people apart in practice, but only a
 * pseudonym, not an anonymisation.
 */
const personNodeId = (c: Controller): string =>
  "person:" +
  createHash("sha256")
    .update(
      [c.name, c.birth?.year, c.birth?.month, c.nationality, c.countryOfResidence]
        .map((v) => String(v ?? "").toLowerCase())
        .join("|"),
    )
    .digest("hex")
    .slice(0, 12);

const idsOf = (ids: (Identifier | undefined)[]): OwnershipNode["identifiers"] =>
  ids
    .filter((i): i is Identifier => i !== undefined)
    .map((i) => ({ scheme: i.scheme, value: i.value }));

/** Runs `fn` over `items` with at most `limit` in flight; results keep the input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Walks up the chain of controllers (persons with significant control) from a company, level by
 * level, until natural persons, exempt or unfollowable companies, the depth limit, or the request
 * budget. Cycles are detected. Ceased controllers are skipped unless asked for.
 */
export async function getOwnership(rt: Runtime, input: OwnershipInput): Promise<OwnershipOutcome> {
  const depth = Math.min(Math.max(Math.trunc(input.depth ?? DEFAULT_DEPTH), 1), MAX_DEPTH);
  const company = input.company ?? (await resolveCompany(rt, input.seed, { fresh: input.fresh }));
  const warnings = [...company.warnings];
  const finish = (
    ownership: OwnershipOutcome["ownership"],
    fromCache = company.fromCache,
  ): OwnershipOutcome => ({
    profile: company.profile,
    ownership,
    warnings,
    sourcesQueried: company.sourcesQueried,
    fromCache,
  });

  // Only registries the chain walker can follow; anything else is reported, not mis-followed.
  const registry = findControllersRegistry(rt, company.profile);
  if (!registry) return finish(unavailableBecause(rt, company.profile, "controllers"));
  const { adapter } = registry;

  const built = await walk(rt, adapter.controllers!.bind(adapter), company, registry.identifier, {
    depth,
    includeCeased: input.includeCeased ?? false,
    includePersons: input.includePersons ?? true,
    fresh: input.fresh,
    warn: (w) => warnings.push(w),
  });
  if (!built) {
    return finish({
      state: "unavailable",
      reason: "no_such_record",
      detail: "The registry has no such company",
    });
  }
  // If the company itself could not be read there is no ownership information at all: that is an
  // error, not an (empty) result.
  if (built.rootFailure) return finish({ state: "error", detail: built.rootFailure });
  return finish({ state: "available", data: built.graph }, company.fromCache && built.allFromCache);
}

type ControllersFn = (
  id: Identifier,
  ctx: AdapterContext,
) => Promise<ControllersResult | undefined>;

interface WalkOptions {
  depth: number;
  includeCeased: boolean;
  includePersons: boolean;
  fresh?: boolean;
  warn: (w: string) => void;
}

async function walk(
  rt: Runtime,
  controllersOf: ControllersFn,
  company: CompanyContext,
  rootNumber: Identifier,
  o: WalkOptions,
): Promise<{ graph: OwnershipGraph; allFromCache: boolean; rootFailure?: string } | undefined> {
  const ctx = adapterContext(rt, o.fresh);
  const rootId = makeEntityId("GB", "CH", rootNumber.value);
  const rootName = company.profile.names.find((n) => n.kind === "legal")?.name;

  const nodes = new Map<string, OwnershipNode>();
  const edges: OwnershipEdge[] = [];
  const provenance: Provenance[] = [];
  const queued = new Set<string>([rootNumber.value]);
  let expanded = 0;
  const cutBy = new Set<CutReason>();
  const cut = (r: CutReason): void => {
    cutBy.add(r);
  };
  let personsOmitted = 0;
  let allFromCache = true;
  let failed = false;
  let rootFailure: string | undefined;

  nodes.set(rootId, {
    nodeId: rootId,
    kind: "entity",
    name: rootName,
    entityId: company.profile.entityId,
    identifiers: idsOf(company.profile.identifiers),
    level: 0,
  });

  type Pending = { node: OwnershipNode; number: string };
  let frontier: Pending[] = [{ node: nodes.get(rootId)!, number: rootNumber.value }];

  for (let level = 0; level < o.depth && frontier.length > 0; level++) {
    // Decide the budget first so the fetches of a level can run side by side.
    const room = Math.max(0, MAX_COMPANIES - expanded);
    const batch = frontier.slice(0, room);
    for (const skipped of frontier.slice(room)) {
      skipped.node.terminal = "budget";
      skipped.node.terminalDetail = "Not followed: request budget reached";
      cut("budget");
    }
    expanded += batch.length;

    const fetched = await mapLimit(batch, CONCURRENCY, async (item) => {
      try {
        const res = await controllersOf(
          { scheme: "GB_CRN", value: item.number, country: "GB", validated: false, provenance: [] },
          ctx,
        );
        return { res };
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        return { failure: describeFailure("companies_house", err) };
      }
    });

    const next: Pending[] = [];
    for (let i = 0; i < batch.length; i++) {
      const { node, number } = batch[i]!;
      const result = fetched[i]!;
      if (result.failure !== undefined) {
        o.warn(result.failure);
        node.terminal = "error";
        node.terminalDetail = "The registry could not be read for this company";
        cut("error");
        failed = true;
        if (level === 0) rootFailure = result.failure;
        continue;
      }
      const res = result.res;
      if (!res) {
        // The company number resolved at the start; a missing record higher up is a data problem.
        node.terminal = "no_controllers_published";
        node.terminalDetail = "The registry has no record for this company";
        if (level === 0) return undefined;
        continue;
      }
      provenance.push(res.provenance);
      allFromCache &&= res.provenance.fromCache;
      if (res.truncated) {
        o.warn(`Controllers of company ${number} are incomplete (registry lists ${res.total})`);
        cut("registry");
      }

      const visible = res.controllers.filter((c) => c.active || o.includeCeased);
      if (visible.length === 0) {
        if (res.exemption) {
          node.terminal = "exempt";
          node.terminalDetail = res.exemption.description;
        } else if (res.statements.length > 0) {
          node.terminal = "statement";
          node.terminalDetail = res.statements.map((s) => s.description).join("; ");
        } else if (res.controllers.length > 0) {
          node.terminal = "all_ceased";
          node.terminalDetail = `All ${res.controllers.length} controller(s) on the register have ceased (include_ceased shows them)`;
        } else {
          node.terminal = "no_controllers_published";
          node.terminalDetail = "The registry lists no persons with significant control";
        }
        continue;
      }

      for (const c of visible) {
        if (nodes.size >= MAX_NODES) {
          cut("size");
          break;
        }
        let child: OwnershipNode;
        if (c.kind === "person") {
          if (!o.includePersons) {
            personsOmitted++;
            continue;
          }
          const id = personNodeId(c);
          child =
            nodes.get(id) ??
            ({
              nodeId: id,
              kind: "person",
              name: c.displayName,
              identifiers: [],
              level: level + 1,
              terminal: c.redacted ? "redacted" : "natural_person",
              terminalDetail: c.redacted
                ? "The registry withholds this controller's identity"
                : undefined,
              person: {
                nationality: c.nationality,
                countryOfResidence: c.countryOfResidence,
                birth: c.birth,
              },
            } satisfies OwnershipNode);
        } else if (c.corporateIdentifier) {
          const num = c.corporateIdentifier.value;
          const id = makeEntityId("GB", "CH", num);
          const known = nodes.get(id);
          child =
            known ??
            ({
              nodeId: id,
              kind: "entity",
              name: c.displayName,
              entityId: id,
              identifiers: idsOf([c.corporateIdentifier]),
              level: level + 1,
            } satisfies OwnershipNode);
          if (!known) {
            if (level + 1 < o.depth && !queued.has(num)) {
              queued.add(num);
              next.push({ node: child, number: num });
            } else if (level + 1 >= o.depth) {
              child.terminal = "depth_limit";
              child.terminalDetail = "Not followed: depth limit reached";
              cut("depth");
            }
          }
        } else {
          const id = fallbackEntityId(c.displayName ?? c.registration?.number ?? "unknown", "XX");
          child =
            nodes.get(id) ??
            ({
              nodeId: id,
              kind: "entity",
              name: c.displayName,
              identifiers: [],
              level: level + 1,
              terminal: "not_followable",
              terminalDetail: c.registration
                ? `Registered outside Companies House (${[c.registration.placeRegistered, c.registration.countryRegistered].filter(Boolean).join(", ") || "unknown registry"})`
                : "No registration details published",
              registration: c.registration,
            } satisfies OwnershipNode);
        }
        nodes.set(child.nodeId, child);
        edges.push({
          from: child.nodeId,
          to: node.nodeId,
          natures: c.natures,
          notifiedOn: c.notifiedOn,
          ceasedOn: c.ceasedOn,
          active: c.active,
        });
      }
    }
    frontier = next;
  }

  const all = [...nodes.values()];
  const hasOwner = new Set(edges.map((e) => e.to));
  const ultimate = all
    .filter((n) => n.nodeId !== rootId && !hasOwner.has(n.nodeId))
    .map((n) => ({ nodeId: n.nodeId, kind: n.kind, name: n.name, terminal: n.terminal }));

  return {
    allFromCache: allFromCache && !failed,
    rootFailure,
    graph: {
      rootNodeId: rootId,
      nodes: all,
      edges,
      depthRequested: o.depth,
      depthReached: Math.max(...all.map((n) => n.level)),
      companiesExpanded: expanded,
      truncated: cutBy.size > 0,
      cutBy: [...cutBy],
      ultimateOwners: ultimate,
      personsOmitted,
      provenance,
    },
  };
}
