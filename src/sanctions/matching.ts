import { distance } from "fastest-levenshtein";
import { normaliseName } from "../resolution/normalise.js";
import type {
  MatchBasis,
  SanctionEntry,
  SanctionsHit,
  SanctionsListId,
  SubjectType,
} from "./types.js";
import { normaliseId } from "./xml.js";

export interface Thresholds {
  /** Score at or above which a hit is a "match". */
  match: number;
  /** Score at or above which a hit is reported as a "possible match". */
  possible: number;
}

/** What is being screened: one subject, with all the names and identifiers it is known by. */
export interface ScreenSubject {
  names: string[];
  /** LEI, company number, VAT number etc. (any format; normalised here). */
  identifiers: string[];
  /** "entity" skips designated individuals (and vice versa); "any" screens everything. */
  kind: "person" | "entity" | "any";
}

interface Prepared {
  raw: string;
  key: string;
  sorted: string;
  tokens: string[];
}

function prepare(raw: string): Prepared {
  const { tokens, key } = normaliseName(raw);
  return { raw, key, sorted: [...tokens].sort().join(" "), tokens };
}

interface IndexedName {
  entry: SanctionEntry;
  name: SanctionEntry["names"][number];
  p: Prepared;
}

/**
 * Fuzzy matching needs a reasonably long name: one wrong letter in a 5-letter name already scores
 * 0.80 (live check: "Tesco" matched FESCO and TEACO), which is noise rather than evidence.
 */
const MIN_FUZZY_LENGTH = 8;
/** Aliases the list itself marks as low quality can never produce a "match" on their own. */
const WEAK_ALIAS_CAP = 0.94;

/**
 * Highest score a low-quality alias may reach: just under the match threshold, whatever it is
 * configured to be, but never below the reporting threshold.
 */
function weakCap(t: Thresholds): number {
  return Math.max(t.possible, Math.min(WEAK_ALIAS_CAP, t.match - 0.01));
}

function levenshteinRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - distance(a, b) / max;
}

interface NameScore {
  score: number;
  exact: boolean;
}

/**
 * Compares two prepared names. 1.0 = identical after normalisation; 0.98 = same words in a
 * different order (surname-first lists); a fuzzy edit-distance score otherwise; 0.85 when all words
 * of a distinctive multi-word name appear in the other. Single common words never match on their own.
 */
function compare(q: Prepared, c: Prepared, floor: number): NameScore | undefined {
  if (!q.key || !c.key) return undefined;
  if (q.key === c.key) return { score: 1, exact: true };
  if (q.sorted === c.sorted) return { score: 0.98, exact: true };

  const longest = Math.max(q.sorted.length, c.sorted.length);
  const shortest = Math.min(q.sorted.length, c.sorted.length);
  if (shortest < MIN_FUZZY_LENGTH) return undefined;

  let best = 0;
  // Cheap bound: edit distance can't beat the length difference.
  if (1 - (longest - shortest) / longest >= floor) best = levenshteinRatio(q.sorted, c.sorted);

  const [small, large] = q.tokens.length <= c.tokens.length ? [q, c] : [c, q];
  if (
    small.tokens.length >= 2 &&
    small.tokens.join("").length >= 8 &&
    small.tokens.every((t) => large.tokens.includes(t))
  ) {
    best = Math.max(best, 0.85);
  }
  return best >= floor ? { score: Math.min(best, 0.97), exact: false } : undefined;
}

function idVariants(id: string): string[] {
  const norm = normaliseId(id);
  // 8+ characters: shorter numbers (7-digit IMO numbers, short ids) collide across countries.
  if (norm.length < 8) return [];
  const noZeros = /^[0-9]+$/.test(norm) ? norm.replace(/^0+/, "") : norm;
  return noZeros.length >= 6 && noZeros !== norm ? [norm, noZeros] : [norm];
}

const TYPE_ALLOWED: Record<ScreenSubject["kind"], SubjectType[]> = {
  person: ["person"],
  entity: ["entity", "vessel", "other"],
  any: ["person", "entity", "vessel", "other"],
};

/** An in-memory index over one list, built from a cached snapshot. */
export class ListIndex {
  private readonly names: IndexedName[] = [];
  private readonly byId = new Map<string, SanctionEntry[]>();

  constructor(
    readonly list: SanctionsListId,
    readonly entries: SanctionEntry[],
  ) {
    for (const entry of entries) {
      for (const name of entry.names) this.names.push({ entry, name, p: prepare(name.name) });
      for (const id of entry.identifiers) {
        for (const v of idVariants(id)) {
          const bucket = this.byId.get(v);
          if (bucket) bucket.push(entry);
          else this.byId.set(v, [entry]);
        }
      }
    }
  }

  get size(): number {
    return this.entries.length;
  }

  /** Best hit per designation at or above `thresholds.possible`, highest score first. */
  screen(subject: ScreenSubject, thresholds: Thresholds): SanctionsHit[] {
    const allowed = new Set(TYPE_ALLOWED[subject.kind]);
    const best = new Map<SanctionEntry, SanctionsHit>();
    const offer = (hit: SanctionsHit, entry: SanctionEntry): void => {
      const prev = best.get(entry);
      if (!prev || hit.score > prev.score) best.set(entry, hit);
    };

    // 1. Identifiers: an exact registration number is the strongest evidence there is.
    for (const raw of subject.identifiers) {
      for (const v of idVariants(raw)) {
        for (const entry of this.byId.get(v) ?? []) {
          offer(this.hit(entry, entry.names[0]!, raw, 1, "exact_identifier"), entry);
        }
      }
    }

    // 2. Names.
    const queries = subject.names.map(prepare).filter((q) => q.key);
    if (queries.length > 0) {
      for (const item of this.names) {
        if (!allowed.has(item.entry.subjectType)) continue;
        for (const q of queries) {
          const r = compare(q, item.p, thresholds.possible);
          if (!r) continue;
          const weak = !item.name.primary && !item.name.strong;
          const score = weak ? Math.min(r.score, weakCap(thresholds)) : r.score;
          if (score < thresholds.possible) continue;
          const basis: MatchBasis = r.exact
            ? item.name.primary
              ? "exact_name"
              : "alias"
            : "fuzzy_name";
          offer(this.hit(item.entry, item.name, q.raw, score, basis, weak), item.entry);
        }
      }
    }
    return [...best.values()].sort(
      (a, b) => b.score - a.score || a.entryId.localeCompare(b.entryId),
    );
  }

  private hit(
    entry: SanctionEntry,
    name: SanctionEntry["names"][number],
    matchedName: string,
    score: number,
    basis: MatchBasis,
    weakAlias = false,
  ): SanctionsHit {
    return {
      list: this.list,
      entryId: entry.entryId,
      entryName: name.name,
      matchedName,
      score: Math.round(score * 100) / 100,
      basis,
      subjectType: entry.subjectType,
      programmes: entry.programmes,
      listedOn: entry.listedOn,
      countries: entry.countries,
      weakAlias: weakAlias || undefined,
      remarks: entry.remarks,
    };
  }
}
