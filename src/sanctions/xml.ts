import { XMLParser } from "fast-xml-parser";
import { SourceError } from "../core/errors.js";

/**
 * Minimal, safe XML helpers for the sanctions lists.
 *
 * The files are tens of megabytes, so they are split into one chunk per designation and each chunk
 * is parsed on its own (flat memory). Entity processing is OFF: nothing in the file can expand
 * into more text (no XXE or billion-laughs); the five standard entities and numeric references are
 * decoded by `unescapeXml` instead.
 */

export function makeParser(arrayTags: string[]): XMLParser {
  const arrays = new Set(arrayTags);
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
    htmlEntities: false,
    trimValues: true,
    ignoreDeclaration: true,
    isArray: (name) => arrays.has(name),
  });
}

/** Yields each `<open ...> ... </close>` block of `text` in order. */
export function* chunks(text: string, open: string, close: string): Generator<string> {
  let from = 0;
  for (;;) {
    const start = text.indexOf(open, from);
    if (start < 0) return;
    const end = text.indexOf(close, start);
    if (end < 0) return;
    from = end + close.length;
    yield text.slice(start, from);
  }
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) return safeCodePoint(parseInt(body.slice(2), 16), whole);
    if (body.startsWith("#")) return safeCodePoint(parseInt(body.slice(1), 10), whole);
    return NAMED[body] ?? whole;
  });
}

function safeCodePoint(cp: number, fallback: string): string {
  return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : fallback;
}

/** Text of a parsed node: handles plain strings, `{ "#text": ... }`, nil elements and numbers. */
export function txt(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return unescapeXml(node).trim();
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (typeof node === "object") {
    const t = (node as Record<string, unknown>)["#text"];
    return t === undefined ? "" : txt(t);
  }
  return "";
}

/** Attribute value of a parsed node (`attr(node, "wholeName")`). */
export function attr(node: unknown, name: string): string {
  if (node && typeof node === "object") {
    return txt((node as Record<string, unknown>)[`@_${name}`]);
  }
  return "";
}

export function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** Normalises an identifier for comparison: upper case, no spaces or separators. */
export function normaliseId(raw: string): string {
  return raw.replace(/[\s.\-_/]/g, "").toUpperCase();
}

/** "27/07/1992", "1992-07-27", "27.7.92": calendar dates are never registration numbers. */
export function isDateLike(raw: string): boolean {
  const t = raw.trim().replace(/[.,;:]+$/, "");
  return /^\d{4}-\d{1,2}-\d{1,2}$/.test(t) || /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(t);
}

/**
 * Normalises a value from an identifier field and returns it only if it can plausibly be a
 * registration number: 6-30 letters/digits with at least one digit, and not a date. Anything else
 * (dates, free text, contact details) would pollute the index and could cause false matches.
 */
export function acceptIdentifier(raw: string): string | undefined {
  if (isDateLike(raw)) return undefined;
  const id = normaliseId(raw);
  return /^[A-Z0-9]{6,30}$/.test(id) && /[0-9]/.test(id) ? id : undefined;
}

/**
 * Pulls identifier-like tokens (6+ characters containing 4+ digits) out of free text such as
 * "(1) Kazakhstan BIN - 170440031562". Short or purely alphabetic tokens and dates are ignored to
 * keep false matches down.
 */
export function extractIdentifiers(text: string): string[] {
  const out = new Set<string>();
  for (const token of text.split(/[\s,;()]+/)) {
    const id = acceptIdentifier(token);
    if (id && (id.match(/[0-9]/g)?.length ?? 0) >= 4) out.add(id);
  }
  return [...out];
}

/**
 * Throws if the document does not end with its root closing tag. The chunk parser silently stops
 * at the first missing closing tag, so without this a truncated download would parse "fine" into a
 * partial list.
 */
export function assertComplete(xml: string, closingRootTag: string, list: string): void {
  if (!xml.trimEnd().endsWith(closingRootTag)) {
    throw new SourceError(
      `${list} list is incomplete (cut off)`,
      list.toLowerCase(),
      "bad_response",
    );
  }
}

export function cap(text: string | undefined, max = 300): string | undefined {
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
