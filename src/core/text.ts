// Text folding shared by name matching and fallback entity ids. Kept in core so that low-level
// modules (ids) never depend on higher layers (resolution).

export function stripDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "");
}

/** Letters that NFKD does not decompose into base letter + mark. */
const FOLD: Record<string, string> = {
  ø: "o",
  æ: "ae",
  œ: "oe",
  ß: "ss",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
};

/**
 * Lower-cases, folds diacritics and punctuation, and splits into tokens. Keeps every Unicode
 * letter and digit, so Greek and Cyrillic names (EU scope) survive instead of being erased.
 */
export function tokenize(name: string): string[] {
  return stripDiacritics(name)
    .toLowerCase()
    .replace(/[øæœßłđðþı]/g, (c) => FOLD[c] ?? c)
    .replace(/&/g, " and ")
    .replace(/[.'’`/]/g, "") // "S.A." -> "sa", "A/S" -> "as", "Tesco's" -> "tescos"
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}
