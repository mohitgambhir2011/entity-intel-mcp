import { SourceError } from "../core/errors.js";
import type { EntityProfile } from "../core/entity.js";
import type { GroupDirection, GroupStructure } from "../core/group.js";
import type { Availability } from "../core/people.js";
import type { Identifier, SourceId } from "../core/types.js";
import type { Runtime } from "../runtime.js";
import { resolveCompany, type CompanyContext } from "./company.js";
import { adapterContext, describeFailure } from "./gather.js";

export const DEFAULT_CHILDREN = 25;
export const MAX_CHILDREN = 100;

export interface GroupInput {
  seed: Identifier;
  direction?: GroupDirection;
  childrenLimit?: number;
  fresh?: boolean;
  company?: CompanyContext;
}

export interface GroupOutcome {
  profile: EntityProfile;
  group: Availability<GroupStructure>;
  warnings: string[];
  sourcesQueried: SourceId[];
  fromCache: boolean;
}

/**
 * GLEIF Level 2 group structure of a company (E1). Only companies with an LEI are covered, so a
 * miss is "no LEI known", never "no parent".
 */
export async function getGroupStructure(rt: Runtime, input: GroupInput): Promise<GroupOutcome> {
  const company = input.company ?? (await resolveCompany(rt, input.seed, { fresh: input.fresh }));
  const warnings = [...company.warnings];
  const done = (group: GroupOutcome["group"], fromCache = company.fromCache): GroupOutcome => ({
    profile: company.profile,
    group,
    warnings,
    sourcesQueried: company.sourcesQueried.includes("gleif")
      ? company.sourcesQueried
      : [...company.sourcesQueried, "gleif"],
    fromCache,
  });

  const adapter = rt.adapters.find((a) => a.groupStructure);
  if (!adapter) {
    return done({
      state: "unavailable",
      reason: "not_enabled",
      detail: "The GLEIF adapter is not enabled (see EIM_ADAPTERS)",
    });
  }
  const lei = company.profile.identifiers.find((i) => i.scheme === "LEI");
  if (!lei) {
    return done({
      state: "unavailable",
      reason: "no_such_record",
      detail:
        "No LEI is known for this company, and GLEIF group structure only covers LEI holders. " +
        "This says nothing about whether the company has a parent or subsidiaries.",
    });
  }

  try {
    const res = await adapter.groupStructure!(
      lei.value,
      {
        direction: input.direction ?? "both",
        childrenLimit: Math.min(Math.max(input.childrenLimit ?? DEFAULT_CHILDREN, 1), MAX_CHILDREN),
      },
      adapterContext(rt, input.fresh),
    );
    if (!res) {
      return done({
        state: "unavailable",
        reason: "no_such_record",
        detail: "GLEIF has no record for this LEI",
      });
    }
    // Each part reports its own failure; surface them so the summary cannot read as complete.
    for (const [name, part] of [
      ["direct parent", res.directParent],
      ["ultimate parent", res.ultimateParent],
      ["direct children", res.directChildren],
    ] as const) {
      if (part?.state === "error") warnings.push(`GLEIF ${name} could not be read: ${part.detail}`);
    }
    if (res.directChildren?.state === "available" && res.directChildren.truncated) {
      warnings.push(
        `GLEIF reports ${res.directChildren.total} direct children; ${res.directChildren.items.length} are listed.`,
      );
    }
    return done(
      { state: "available", data: res },
      company.fromCache && res.provenance.every((p) => p.fromCache),
    );
  } catch (err) {
    if (!(err instanceof SourceError)) throw err;
    const detail = describeFailure(adapter.id, err);
    warnings.push(detail);
    return done({ state: "error", detail });
  }
}
