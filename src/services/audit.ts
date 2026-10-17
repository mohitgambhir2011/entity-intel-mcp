import { createHash } from "node:crypto";
import { detectIdentifier } from "../core/identifiers.js";

/**
 * What goes in the audit log for a search (D14: metadata only). Identifiers are logged as typed;
 * free-text names are logged as a short hash plus length, so the log can show that a query was
 * made (and detect repeats) without becoming a store of people's and companies' names.
 */
export function auditSubject(query: string): string {
  const q = query.trim();
  const id = detectIdentifier(q);
  if (id) return `${id.scheme}:${id.value}`;
  const hash = createHash("sha256").update(q.toLowerCase()).digest("hex").slice(0, 12);
  return `name#${hash} (${q.length} chars)`;
}
