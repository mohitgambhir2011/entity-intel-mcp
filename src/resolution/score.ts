import { distance } from "fastest-levenshtein";
import { normaliseName } from "./normalise.js";

export type ConfidenceBand = "certain" | "high" | "medium" | "low";

export interface NameMatch {
  score: number;
  band: ConfidenceBand;
  reasons: string[];
  warnings: string[];
}

export function bandFor(score: number): ConfidenceBand {
  if (score >= 0.9) return "high";
  if (score >= 0.7) return "medium";
  return "low";
}

function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - distance(a, b) / max;
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function isTokenPrefix(query: string[], name: string[]): boolean {
  return query.length > 0 && query.length < name.length && query.every((t, i) => name[i] === t);
}

/**
 * Scores how well a candidate name matches the query (0-1). Never returns "certain": that band is
 * reserved for exact identifier matches (D26).
 */
export function scoreName(query: string, candidate: string): NameMatch {
  const q = normaliseName(query);
  const c = normaliseName(candidate);
  const reasons: string[] = [];
  const warnings: string[] = [];
  let score: number;

  if (q.key === c.key) {
    score = 0.97;
    reasons.push("names are identical after normalisation");
    if (query.trim().toLowerCase() === candidate.trim().toLowerCase()) {
      score = 1;
      reasons[0] = "names are identical";
    } else if (q.suffix && c.suffix && q.suffix !== c.suffix) {
      warnings.push(`different legal form suffix ("${q.suffix}" vs "${c.suffix}")`);
      score = 0.9;
    }
  } else {
    const lev = levenshteinRatio(q.key, c.key);
    const jac = jaccard(q.tokens, c.tokens);
    const prefix = isTokenPrefix(q.tokens, c.tokens) ? 0.75 : 0;
    score = Math.max(lev, jac, prefix);
    if (prefix && prefix >= Math.max(lev, jac)) {
      reasons.push("query matches the start of the name");
    } else if (lev >= jac) {
      reasons.push(`name similarity ${lev.toFixed(2)} after normalisation`);
    } else {
      reasons.push(`shared words ${jac.toFixed(2)} after normalisation`);
    }
    score = Math.min(score, 0.89); // anything not identical stays below "high"
  }

  return {
    score: Math.round(score * 100) / 100,
    band: bandFor(score),
    reasons,
    warnings,
  };
}
