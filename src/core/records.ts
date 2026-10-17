// Filings, charges and insolvency: the record families about a company's history.
import type { Provenance } from "./types.js";

/** One entry in a company's filing history. Text fields are the registry's own (untrusted). */
export interface FilingItem {
  transactionId: string;
  /** Date the filing was made. */
  date: string;
  /** Registry category, e.g. "accounts", "confirmation-statement", "capital". */
  category: string;
  /** Registry form type, e.g. "AA", "SH06". */
  type: string;
  /** The registry's description code, e.g. "capital-cancellation-shares". */
  description: string;
  /** Date the filing is about (for example the accounting period end). */
  actionDate?: string;
  paperFiled: boolean;
  pages?: number;
  /** Where the document's metadata can be fetched from the registry's document API. */
  documentUrl?: string;
}

export interface FilingsResult {
  items: FilingItem[];
  /** Filings matching the category filter on the register. */
  total: number;
  offset: number;
  provenance: Provenance;
}

export interface Charge {
  number?: number;
  status: string;
  createdOn?: string;
  deliveredOn?: string;
  satisfiedOn?: string;
  /** What kind of charge, e.g. "Account security agreement". */
  classification?: string;
  /** Short particulars as filed (long text is cut). */
  particulars?: string;
  personsEntitled: string[];
}

export interface ChargesResult {
  charges: Charge[];
  /** Everything the register holds for the company. */
  total: number;
  outstanding: number;
  satisfied: number;
  partSatisfied: number;
  truncated: boolean;
  provenance: Provenance;
}

export interface InsolvencyCase {
  number?: string;
  /** Registry case type, e.g. "creditors-voluntary-liquidation". */
  type: string;
  dates: { type: string; date: string }[];
  /** Appointed insolvency practitioners (named professionals: personal data). */
  practitioners: {
    name: string;
    role?: string;
    appointedOn?: string;
    ceasedToActOn?: string;
  }[];
}

export interface InsolvencyResult {
  cases: InsolvencyCase[];
  /** The register's insolvency status flags for the company. */
  statusFlags: string[];
  provenance: Provenance;
}
