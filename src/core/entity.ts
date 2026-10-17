import type {
  Address,
  EntityName,
  EntityStatus,
  Identifier,
  ISODate,
  LegalForm,
  Provenance,
  SourceId,
  Sourced,
} from "./types.js";

/** Two or more sources disagree on a field (D2): we keep every value instead of picking silently. */
export interface Conflict {
  field: string;
  values: Sourced<unknown>[];
  note?: string;
}

export type FamilyState = "available" | "not_yet_supported" | "unavailable" | "error";

export interface FamilyCoverage {
  state: FamilyState;
  sourcesTried: SourceId[];
  note?: string;
}

export interface CoverageReport {
  jurisdiction?: string;
  families: Record<string, FamilyCoverage>;
}

/** Identity-level entity (first slice of the full Entity in docs/11-data-model.md). */
export interface EntityProfile {
  entityId: string;
  /** Superseded ids that redirect here (D20). */
  aliases: string[];
  names: EntityName[];
  identifiers: Identifier[];
  jurisdiction?: string;
  legalForm?: Sourced<LegalForm>;
  status?: Sourced<EntityStatus>;
  incorporationDate?: Sourced<ISODate>;
  dissolutionDate?: Sourced<ISODate>;
  registeredAddress?: Sourced<Address>;
  headquartersAddress?: Sourced<Address>;
  conflicts: Conflict[];
  coverage: CoverageReport;
  sources: SourceId[];
}

export function mergeProvenance(a: Provenance[], b: Provenance[]): Provenance[] {
  const seen = new Set(a.map((p) => `${p.source}|${p.sourceRecordId}`));
  return [...a, ...b.filter((p) => !seen.has(`${p.source}|${p.sourceRecordId}`))];
}
