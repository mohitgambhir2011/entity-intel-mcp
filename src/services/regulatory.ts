import { SourceError } from "../core/errors.js";
import type { EntityProfile } from "../core/entity.js";
import type { Availability } from "../core/people.js";
import type { RegulatoryResult } from "../core/regulatory.js";
import type { Identifier, SourceId } from "../core/types.js";
import type { Runtime } from "../runtime.js";
import {
  findRegistry,
  resolveCompany,
  unavailableBecause,
  type CompanyContext,
} from "./company.js";
import { adapterContext, describeFailure } from "./gather.js";

export interface RegulatoryInput {
  seed: Identifier;
  fresh?: boolean;
  company?: CompanyContext;
}

export interface RegulatoryOutcome {
  profile: EntityProfile;
  regulatory: Availability<RegulatoryResult>;
  warnings: string[];
  sourcesQueried: SourceId[];
  fromCache: boolean;
}

const NOT_FOUND_DETAIL =
  "No firm on the register was matched to this company. The register cannot be searched by " +
  "company number, so the company is found by name and accepted only when the firm's record " +
  "carries the same Companies House number: a firm authorised under another name, or one that " +
  "states no company number, would not be found. This is not proof that the company is unregulated";

/** The regulator's record of a company (FCA Register for UK firms), or the reason there is none. */
export async function getRegulatoryStatus(
  rt: Runtime,
  input: RegulatoryInput,
): Promise<RegulatoryOutcome> {
  const company = input.company ?? (await resolveCompany(rt, input.seed, { fresh: input.fresh }));
  const warnings = [...company.warnings];
  const done = (regulatory: RegulatoryOutcome["regulatory"], fromCache = company.fromCache) => ({
    profile: company.profile,
    regulatory,
    warnings,
    sourcesQueried: company.sourcesQueried,
    fromCache,
  });

  const registry = findRegistry(rt, company.profile, "regulatory");
  if (!registry) return done(unavailableBecause(rt, company.profile, "regulatory"));

  try {
    const res = await registry.adapter.regulatory!(
      {
        identifiers: company.profile.identifiers,
        names: [...new Set(company.profile.names.map((n) => n.name))],
      },
      adapterContext(rt, input.fresh),
    );
    if (!res) {
      return done({ state: "unavailable", reason: "no_such_record", detail: NOT_FOUND_DETAIL });
    }
    return done({ state: "available", data: res }, company.fromCache && res.provenance.fromCache);
  } catch (err) {
    if (!(err instanceof SourceError)) throw err;
    const detail = describeFailure(registry.adapter.id, err);
    warnings.push(detail);
    return done({ state: "error", detail });
  }
}
