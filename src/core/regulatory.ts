// Regulatory status: what a financial regulator's register says about a firm.
import type { Provenance } from "./types.js";

export interface RegulatoryPermission {
  /** The regulated activity, as the register words it. */
  name: string;
  /** Limitations the register attaches to this permission (cut). */
  limitations: string[];
}

export interface RegulatoryRegulator {
  name: string;
  effectiveFrom?: string;
  terminatedOn?: string;
}

export interface RegulatoryRequirement {
  effectiveFrom?: string;
  /** What the register calls this kind of requirement (the field name it files the text under). */
  kind: string;
  /** The notice text, cut. Untrusted registry text. */
  text: string;
}

/** One firm on a regulator's register. */
export interface RegulatoryResult {
  /** Firm reference number. */
  frn: string;
  name: string;
  /** The register's authorisation status, e.g. "Authorised" or "No longer authorised". */
  status: string;
  statusEffectiveFrom?: string;
  businessType?: string;
  clientMoneyPermission?: string;
  /** Anti-money-laundering supervision status, when the register states one. */
  mlrsStatus?: string;
  regulators: RegulatoryRegulator[];
  permissions: RegulatoryPermission[];
  /** Permissions the register lists (may exceed what was read). */
  permissionsTotal: number;
  requirements: RegulatoryRequirement[];
  requirementsTotal: number;
  /** True when more permissions or requirements exist than were read. */
  truncated: boolean;
  /** How the firm was matched to the company asked about. */
  matchedBy: "frn" | "companies_house_number";
  provenance: Provenance;
}
