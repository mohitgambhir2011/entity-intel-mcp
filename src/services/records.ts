import type { Capability } from "../adapters/types.js";
import type { EntityProfile } from "../core/entity.js";
import { SourceError } from "../core/errors.js";
import type { Availability } from "../core/people.js";
import type { ChargesResult, FilingsResult, InsolvencyResult } from "../core/records.js";
import type { Identifier, Provenance, SourceId } from "../core/types.js";
import type { Runtime } from "../runtime.js";
import {
  findRegistry,
  resolveCompany,
  unavailableBecause,
  type CompanyContext,
} from "./company.js";
import { adapterContext, describeFailure } from "./gather.js";

export type RecordFamily = "filings" | "charges" | "insolvency";
export const ALL_FAMILIES: RecordFamily[] = ["filings", "charges", "insolvency"];

export interface RecordsInput {
  seed: Identifier;
  include?: RecordFamily[];
  /** Registry filing category, e.g. "accounts". */
  category?: string;
  limit?: number;
  offset?: number;
  fresh?: boolean;
  company?: CompanyContext;
}

export interface RecordsOutcome {
  profile: EntityProfile;
  filings?: Availability<FilingsResult>;
  charges?: Availability<ChargesResult>;
  insolvency?: Availability<InsolvencyResult>;
  warnings: string[];
  sourcesQueried: SourceId[];
  fromCache: boolean;
  limit: number;
  offset: number;
}

const CAPABILITY: Record<RecordFamily, Capability> = {
  filings: "filings",
  charges: "charges",
  insolvency: "insolvency",
};

/**
 * Filing history, charges and insolvency cases of a company, each reported on its own: one failing
 * family never hides the others, and an outage is an error state, never an empty list (D28).
 */
export async function getRecords(rt: Runtime, input: RecordsInput): Promise<RecordsOutcome> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);
  const include = new Set(input.include?.length ? input.include : ALL_FAMILIES);
  const company = input.company ?? (await resolveCompany(rt, input.seed, { fresh: input.fresh }));
  const warnings = [...company.warnings];
  const ctx = adapterContext(rt, input.fresh);
  const provenances: Provenance[] = [];

  async function run<T extends { provenance: Provenance }>(
    family: RecordFamily,
    call: (
      adapter: NonNullable<ReturnType<typeof findRegistry>>["adapter"],
      id: Identifier,
    ) => Promise<T | undefined>,
  ): Promise<Availability<T> | undefined> {
    if (!include.has(family)) return undefined;
    const registry = findRegistry(rt, company.profile, CAPABILITY[family]);
    if (!registry) return unavailableBecause(rt, company.profile, CAPABILITY[family]);
    try {
      const res = await call(registry.adapter, registry.identifier);
      if (!res) {
        return {
          state: "unavailable",
          reason: "no_such_record",
          detail: "The registry has no such company",
        };
      }
      provenances.push(res.provenance);
      return { state: "available", data: res };
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      const detail = describeFailure(registry.adapter.id, err);
      warnings.push(detail);
      return { state: "error", detail };
    }
  }

  const [filings, charges, insolvency] = await Promise.all([
    run("filings", (a, id) => a.filings!(id, { category: input.category, limit, offset }, ctx)),
    run("charges", (a, id) => a.charges!(id, ctx)),
    run("insolvency", (a, id) => a.insolvency!(id, ctx)),
  ]);

  if (charges?.state === "available" && charges.data.truncated) {
    warnings.push(
      `The register lists ${charges.data.total} charges but only ${charges.data.charges.length} could be read`,
    );
  }

  // A status that says the company is in trouble with no case on record deserves a second look.
  const group = company.profile.status?.value.group;
  if (
    insolvency?.state === "available" &&
    group === "distressed" &&
    insolvency.data.cases.length === 0
  ) {
    warnings.push(
      "The company's status is distressed but the registry lists no insolvency case: check the register directly",
    );
  }

  return {
    profile: company.profile,
    filings,
    charges,
    insolvency,
    warnings,
    sourcesQueried: company.sourcesQueried,
    fromCache: company.fromCache && provenances.every((p) => p.fromCache),
    limit,
    offset,
  };
}
