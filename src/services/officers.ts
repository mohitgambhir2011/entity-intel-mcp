import { SourceError } from "../core/errors.js";
import type { EntityProfile } from "../core/entity.js";
import type { Availability, Officer, OfficerRole } from "../core/people.js";
import type { Identifier, Provenance, SourceId } from "../core/types.js";
import type { Runtime } from "../runtime.js";
import { adapterContext, describeFailure } from "./gather.js";
import {
  findRegistry,
  resolveCompany,
  unavailableBecause,
  type CompanyContext,
} from "./company.js";

export interface OfficersInput {
  seed: Identifier;
  activeOnly?: boolean;
  role?: OfficerRole;
  limit?: number;
  offset?: number;
  fresh?: boolean;
  /** Already-resolved company (saves resolving it again). */
  company?: CompanyContext;
}

export interface OfficersPage {
  officers: Officer[];
  /** After the active / role filters, before paging. */
  matching: number;
  /** Everything the registry holds for the company. */
  registryTotal: number;
  activeCount: number;
  resignedCount: number;
  /** True when the registry holds more officers than were fetched. */
  truncated: boolean;
  /** Where and when the list was obtained (D2); each officer inherits it. */
  provenance: Provenance;
}

export interface OfficersOutcome {
  profile: EntityProfile;
  officers: Availability<OfficersPage>;
  warnings: string[];
  sourcesQueried: SourceId[];
  fromCache: boolean;
  limit: number;
  offset: number;
}

const byRecency = (a: Officer, b: Officer): number =>
  Number(b.active) - Number(a.active) || (b.appointedOn ?? "").localeCompare(a.appointedOn ?? "");

export async function getOfficers(rt: Runtime, input: OfficersInput): Promise<OfficersOutcome> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);
  const company = input.company ?? (await resolveCompany(rt, input.seed, { fresh: input.fresh }));
  const warnings = [...company.warnings];
  const done = (officers: OfficersOutcome["officers"], fromCache = company.fromCache) => ({
    profile: company.profile,
    officers,
    warnings,
    sourcesQueried: company.sourcesQueried,
    fromCache,
    limit,
    offset,
  });

  const registry = findRegistry(rt, company.profile, "officers");
  if (!registry) return done(unavailableBecause(rt, company.profile, "officers"));
  const { adapter, identifier } = registry;

  try {
    const res = await adapter.officers!(identifier, adapterContext(rt, input.fresh));
    if (!res) {
      return done({
        state: "unavailable",
        reason: "no_such_record",
        detail: "The registry has no such company",
      });
    }

    const all = res.officers.filter(
      (o) =>
        ((input.activeOnly ?? true) ? o.active : true) && (!input.role || o.role === input.role),
    );
    all.sort(byRecency);
    if (res.truncated) {
      warnings.push(
        `The registry lists ${res.total} officers but only ${res.officers.length} could be read`,
      );
    }
    return done(
      {
        state: "available",
        data: {
          officers: all.slice(offset, offset + limit),
          matching: all.length,
          registryTotal: res.total,
          activeCount: res.activeCount,
          resignedCount: res.resignedCount,
          truncated: res.truncated,
          provenance: res.provenance,
        },
      },
      company.fromCache && res.provenance.fromCache,
    );
  } catch (err) {
    if (!(err instanceof SourceError)) throw err;
    const detail = describeFailure(adapter.id, err);
    warnings.push(detail);
    return done({ state: "error", detail });
  }
}
