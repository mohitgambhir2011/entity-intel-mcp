// Group structure from GLEIF Level 2: who consolidates whom, for LEI holders (E1).
//
// This is ACCOUNTING CONSOLIDATION, not a percentage of shares. A parent consolidates a child when
// it controls it for accounting purposes (usually more than 50%, but not always), so it says "the
// parent controls the child" and never "the parent holds N%". Level 2 does not name natural persons.

import type { Provenance } from "./types.js";

export interface GroupParty {
  lei: string;
  /** Registry text: untrusted. */
  name?: string;
  jurisdiction?: string;
  /** GLEIF's own entity status (ACTIVE, INACTIVE, ...), as published. */
  entityStatus?: string;
  /** The home-registry entity id where GLEIF carries a registry number we know, else `ID:LEI:<lei>`. */
  entityId: string;
}

export interface GroupRelationship {
  /** e.g. IS_DIRECTLY_CONSOLIDATED_BY, IS_ULTIMATELY_CONSOLIDATED_BY. */
  type: string;
  /** e.g. ACTIVE, INACTIVE, NULL. */
  status: string;
  startDate?: string;
  endDate?: string;
  accountingPeriod?: { start?: string; end?: string };
  /** How well the relationship is corroborated (GLEIF's wording). */
  corroboration?: { level?: string; documents?: string; reference?: string };
  /** When GLEIF last updated the relationship record. */
  lastUpdated?: string;
}

/**
 * One side of the parent question. Four distinct answers, never merged:
 *  - reported: GLEIF names a parent;
 *  - reporting_exception: the entity reported WHY it names none (for example NON_CONSOLIDATING,
 *    NATURAL_PERSONS, NO_LEI, NON_PUBLIC); that is an answer, not a gap;
 *  - not_reported: GLEIF holds neither a parent nor an exception: unknown, not "no parent";
 *  - error: the lookup failed.
 */
export type ParentLink =
  | { state: "reported"; parent: GroupParty; relationship: GroupRelationship }
  | { state: "reporting_exception"; category: string; reason: string; reference?: string }
  | { state: "not_reported" }
  | { state: "error"; detail: string };

export type ChildList =
  | {
      state: "available";
      /** The number of children GLEIF reports in total. */
      total: number;
      items: GroupParty[];
      /** True when fewer children are listed than GLEIF reports. */
      truncated: boolean;
    }
  | { state: "error"; detail: string };

export interface GroupStructure {
  lei: string;
  /** When GLEIF published the golden copy these answers come from (how current the data is). */
  goldenCopyPublishedAt?: string;
  directParent?: ParentLink;
  ultimateParent?: ParentLink;
  directChildren?: ChildList;
  /** Number of ultimate children (everything below, however deep); absent if not asked or it failed. */
  ultimateChildrenTotal?: number;
  provenance: Provenance[];
}

export type GroupDirection = "parents" | "children" | "both";
