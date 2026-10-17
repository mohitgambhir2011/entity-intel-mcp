import { SourceError } from "../../core/errors.js";
import type { SanctionEntry } from "../types.js";
import {
  acceptIdentifier,
  asArray,
  assertComplete,
  attr,
  cap,
  chunks,
  makeParser,
  txt,
} from "../xml.js";

const parser = makeParser([
  "nameAlias",
  "regulation",
  "citizenship",
  "birthdate",
  "identification",
  "address",
  "remark",
]);

type Node = Record<string, unknown>;

/**
 * EU consolidated financial sanctions list (FSF XML 1.1). Every entity in the file is currently
 * designated (delisted ones are removed). The version date is the file's generationDate.
 */
export function parseEu(xml: string): { entries: SanctionEntry[]; versionDate?: string } {
  const header = xml.slice(0, 2000);
  if (!header.includes("<export")) {
    throw new SourceError("EU sanctions list has an unexpected format", "eu", "bad_response");
  }
  assertComplete(xml, "</export>", "EU");
  const versionDate = /generationDate="(\d{4}-\d{2}-\d{2})/.exec(header)?.[1];
  const entries: SanctionEntry[] = [];

  for (const chunk of chunks(xml, "<sanctionEntity", "</sanctionEntity>")) {
    const e = (parser.parse(chunk) as { sanctionEntity?: Node }).sanctionEntity;
    if (!e) continue;

    const names: SanctionEntry["names"] = [];
    for (const alias of asArray(e.nameAlias as Node | Node[] | undefined)) {
      const whole =
        attr(alias, "wholeName") ||
        [attr(alias, "firstName"), attr(alias, "middleName"), attr(alias, "lastName")]
          .filter(Boolean)
          .join(" ");
      const name = whole.replace(/\s+/g, " ").trim();
      if (!name || names.some((n) => n.name === name)) continue;
      names.push({ name, primary: names.length === 0, strong: attr(alias, "strong") !== "false" });
    }
    if (names.length === 0) continue;

    const subject = attr(e.subjectType, "code");
    // Only enterprises' registration numbers are indexed; personal documents (passports, national
    // ids) are deliberately left out.
    const identifiers = new Set<string>();
    for (const id of subject === "person"
      ? []
      : asArray(e.identification as Node | Node[] | undefined)) {
      for (const v of [attr(id, "number"), attr(id, "latinNumber")]) {
        const id = acceptIdentifier(v);
        if (id) identifiers.add(id);
      }
    }

    const programmes = new Set<string>();
    for (const r of asArray(e.regulation as Node | Node[] | undefined)) {
      const p = attr(r, "programme");
      if (p) programmes.add(p);
    }

    const countries = new Set<string>();
    for (const c of asArray(e.citizenship as Node | Node[] | undefined)) {
      const d = attr(c, "countryDescription");
      if (d) countries.add(d);
    }
    for (const a of asArray(e.address as Node | Node[] | undefined)) {
      const d = attr(a, "countryDescription");
      if (d) countries.add(d);
    }

    const remark = asArray(e.remark as unknown[] | undefined)
      .map(txt)
      .filter(Boolean)
      .join(" | ");

    entries.push({
      list: "EU",
      entryId: attr(e, "euReferenceNumber") || attr(e, "logicalId"),
      subjectType: subject === "person" ? "person" : subject === "enterprise" ? "entity" : "other",
      names,
      identifiers: [...identifiers],
      programmes: [...programmes],
      listedOn: attr(e, "designationDate") || undefined,
      countries: [...countries],
      remarks: cap(remark),
    });
  }
  return { entries, versionDate };
}
