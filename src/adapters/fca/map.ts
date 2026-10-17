import { normalizeGbCompanyNumber } from "../../core/identifiers.js";
import type {
  RegulatoryPermission,
  RegulatoryRegulator,
  RegulatoryRequirement,
} from "../../core/regulatory.js";

export const BASE = "https://register.fca.org.uk/services/V0.1";
export const LICENCE = "FCA Financial Services Register (public register, FCA terms of use)";

const MAX_TEXT = 300;
const MAX_LIMITATIONS = 3;

// ---------------------------------------------------------------- raw shapes (only what we read)

/** Every answer is HTTP 200 with this envelope; the outcome is in Status and Message. */
export interface FcaEnvelope<T> {
  Status?: string;
  Message?: string;
  ResultInfo?: { Next?: string; total_count?: string } | null;
  Data?: T | null;
}

export interface FcaFirm {
  FRN?: string;
  "Organisation Name"?: string;
  "Business Type"?: string;
  "Status Effective Date"?: string;
  "Client Money Permission"?: string;
  "Companies House Number"?: string;
  "MLRs Status"?: string;
}

export interface FcaSearchHit {
  "Reference Number"?: string;
  Status?: string;
  Name?: string;
  "Type of business or Individual"?: string;
}

// ---------------------------------------------------------------- envelope

export type Outcome = "ok" | "not_found" | "error";

/**
 * The register answers 200 for everything. "Ok..." messages are answers, status codes ending in
 * "-11" mean nothing was found, and anything else (invalid input, an unknown code) is an error:
 * never a negative fact and never cached.
 */
export function outcomeOf(env: FcaEnvelope<unknown> | null | undefined): Outcome {
  if (!env || typeof env !== "object" || typeof env.Status !== "string") return "error";
  if (typeof env.Message === "string" && env.Message.startsWith("Ok")) return "ok";
  return /-11$/.test(env.Status) ? "not_found" : "error";
}

// ---------------------------------------------------------------- mapping

/** "06/04/2017" -> "2017-04-06"; anything else is dropped. */
export function isoDate(v: string | undefined): string | undefined {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v ?? "");
  return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
}

const cut = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}...` : s);

/** The firm's Companies House number as a canonical UK number, if it states a valid one. */
export function crnOf(firm: FcaFirm): string | undefined {
  const raw = firm["Companies House Number"];
  return raw ? normalizeGbCompanyNumber(raw) : undefined;
}

/** Permissions arrive as an object keyed by activity, each with a list of limitation blocks. */
export function mapPermissions(data: unknown): RegulatoryPermission[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const out: RegulatoryPermission[] = [];
  for (const [name, blocks] of Object.entries(data as Record<string, unknown>)) {
    const limitations: string[] = [];
    for (const block of Array.isArray(blocks) ? blocks : []) {
      const lim = (block as Record<string, unknown> | null)?.["Limitation"];
      for (const text of Array.isArray(lim) ? lim : []) {
        if (typeof text === "string" && limitations.length < MAX_LIMITATIONS) {
          limitations.push(cut(text));
        }
      }
    }
    out.push({ name, limitations });
  }
  return out;
}

export function mapRegulators(data: unknown): RegulatoryRegulator[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((r: Record<string, string | undefined>) => ({
      name: r["Regulator Name"] ?? "",
      effectiveFrom: isoDate(r["Effective Date"]),
      terminatedOn: isoDate(r["Termination Date"]),
    }))
    .filter((r) => r.name !== "");
}

/** Fields of a requirement that are not its text: the text sits under a key that names its kind. */
const REQUIREMENT_META = new Set([
  "Effective Date",
  "Requirement Reference",
  "Financial Promotions Requirement",
]);

/**
 * The register words each requirement under a different key ("RFB Sub-group", "Report annually
 * to FCA and PRA ..."), so the text is the one string field that is not metadata. Entries without
 * any text are counted, not dropped silently.
 */
export function mapRequirements(data: unknown): {
  items: RegulatoryRequirement[];
  unreadable: number;
} {
  if (!Array.isArray(data)) return { items: [], unreadable: 0 };
  const items: RegulatoryRequirement[] = [];
  for (const r of data as Record<string, unknown>[]) {
    const entry = Object.entries(r ?? {}).find(
      ([k, v]) => !REQUIREMENT_META.has(k) && typeof v === "string" && v.trim() !== "",
    );
    if (!entry) continue;
    const date = r["Effective Date"];
    items.push({
      kind: cut(entry[0]),
      effectiveFrom: isoDate(typeof date === "string" ? date : undefined),
      text: cut(entry[1] as string),
    });
  }
  return { items, unreadable: data.length - items.length };
}
