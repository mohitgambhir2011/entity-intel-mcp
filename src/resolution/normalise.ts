/**
 * Name normalisation for matching. Used for scoring and de-duplication only: the original name is
 * always what we show. Legal-form suffixes are stripped so "Tesco PLC" matches "TESCO P.L.C.".
 */

import { tokenize } from "../core/text.js";

export { tokenize } from "../core/text.js";

const PHRASES: string[][] = [
  ["public", "limited", "company"],
  ["private", "limited", "company"],
  ["limited", "liability", "partnership"],
  ["limited", "liability", "company"],
  ["community", "interest", "company"],
];

const SUFFIXES = new Set([
  // UK / IE
  "ltd",
  "limited",
  "plc",
  "llp",
  "lp",
  "cic",
  "cio",
  "dac",
  "uc",
  "company",
  "co",
  // Common international
  "inc",
  "corp",
  "corporation",
  "llc",
  // DE / AT / CH
  "gmbh",
  "ag",
  "kg",
  "ug",
  "ohg",
  "se",
  "mbh",
  // FR / BE / LU / ES / IT / PT
  "sa",
  "sas",
  "sasu",
  "sarl",
  "sl",
  "srl",
  "spa",
  "snc",
  "scs",
  "sca",
  "lda",
  // NL
  "bv",
  "nv",
  "vof",
  "cv",
  // Nordics
  "oy",
  "oyj",
  "ab",
  "publ",
  "as",
  "asa",
  "aps",
  "ehf",
  "hf",
]);

export interface Normalised {
  /** Tokens without the trailing legal form. */
  tokens: string[];
  /** The legal-form suffix that was removed, if any (tokens, joined). */
  suffix: string;
  /** Space-joined `tokens`. */
  key: string;
}

export function normaliseName(name: string): Normalised {
  let tokens = tokenize(name);
  if (tokens[0] === "the" && tokens.length > 1) tokens = tokens.slice(1);
  const removed: string[] = [];

  let changed = true;
  while (changed && tokens.length > 1) {
    changed = false;
    for (const phrase of PHRASES) {
      const start = tokens.length - phrase.length;
      if (start > 0 && phrase.every((p, i) => tokens[start + i] === p)) {
        removed.unshift(...tokens.slice(start));
        tokens = tokens.slice(0, start);
        changed = true;
      }
    }
    const last = tokens[tokens.length - 1];
    if (!changed && tokens.length > 1 && last !== undefined && SUFFIXES.has(last)) {
      removed.unshift(last);
      tokens = tokens.slice(0, -1);
      changed = true;
    }
  }
  return { tokens, suffix: removed.join(" "), key: tokens.join(" ") };
}
