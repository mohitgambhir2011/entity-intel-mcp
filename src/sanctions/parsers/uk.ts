import { SourceError } from "../../core/errors.js";
import type { SanctionEntry, SubjectType } from "../types.js";
import {
  acceptIdentifier,
  asArray,
  assertComplete,
  cap,
  chunks,
  extractIdentifiers,
  makeParser,
  txt,
} from "../xml.js";

const parser = makeParser([
  "Name",
  "NonLatinName",
  "Address",
  "BusinessRegistrationNumber",
  "IMONumber",
  "Nationality",
]);

type Node = Record<string, unknown>;

const SUBJECT: Record<string, SubjectType> = {
  Individual: "person",
  Entity: "entity",
  Ship: "vessel",
};

/** "29/06/2012" -> "2012-06-29". */
function isoDate(ddmmyyyy: string): string | undefined {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
}

/**
 * The UK Sanctions List (FCDO), the single source of UK sanctions designations since the OFSI
 * Consolidated List closed on 2026-01-28. One <Designation> per person, entity or ship, with all
 * its names. The version date is <DateGenerated>.
 *
 * Deliberately not read: dates of birth, passports, national ids and other personal documents
 * (matching here is by name and by entities' registration numbers).
 */
export function parseUk(xml: string): { entries: SanctionEntry[]; versionDate?: string } {
  if (!xml.includes("<Designations")) {
    throw new SourceError("UK Sanctions List has an unexpected format", "uk", "bad_response");
  }
  assertComplete(xml, "</Designations>", "UK");
  const versionDate = isoDate(
    /<DateGenerated>([^<]*)<\/DateGenerated>/.exec(xml.slice(0, 2000))?.[1] ?? "",
  );
  const entries: SanctionEntry[] = [];

  for (const chunk of chunks(xml, "<Designation>", "</Designation>")) {
    const d = (parser.parse(chunk) as { Designation?: Node }).Designation;
    if (!d) continue;

    const names: SanctionEntry["names"] = [];
    const namesNode = d.Names as { Name?: Node | Node[] } | undefined;
    for (const n of asArray(namesNode?.Name)) {
      // Given names Name1..Name5 then the surname (or the whole name, for entities) in Name6.
      const name = [n.Name1, n.Name2, n.Name3, n.Name4, n.Name5, n.Name6]
        .map(txt)
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!name || names.some((x) => x.name === name)) continue;
      const primary = txt(n.NameType).toLowerCase().startsWith("primary");
      names.push({ name, primary, strong: !/low/i.test(txt(n.AliasStrength)) });
    }
    const nonLatin = d.NonLatinNames as { NonLatinName?: Node | Node[] } | undefined;
    for (const n of asArray(nonLatin?.NonLatinName)) {
      const name = txt(n.NameNonLatinScript);
      if (name && !names.some((x) => x.name === name))
        names.push({ name, primary: false, strong: true });
    }
    if (names.length === 0) continue;
    if (!names.some((n) => n.primary)) names[0]!.primary = true;

    const subjectType = SUBJECT[txt(d.IndividualEntityShip)] ?? "other";

    const identifiers = new Set<string>();
    const entity = (d.EntityDetails as { Entity?: Node } | undefined)?.Entity;
    const regs = entity?.BusinessRegistrationNumbers as
      { BusinessRegistrationNumber?: unknown } | undefined;
    for (const text of asArray(regs?.BusinessRegistrationNumber)) {
      for (const id of extractIdentifiers(txt(text))) identifiers.add(id);
    }
    const ship = (d.ShipDetails as { Ship?: Node } | undefined)?.Ship;
    const imos = ship?.IMONumbers as { IMONumber?: unknown } | undefined;
    for (const imo of asArray(imos?.IMONumber)) {
      const id = acceptIdentifier(txt(imo));
      if (id) identifiers.add(id);
    }

    const countries = new Set<string>();
    const addresses = d.Addresses as { Address?: Node | Node[] } | undefined;
    for (const a of asArray(addresses?.Address)) {
      const c = txt(a.AddressCountry);
      if (c) countries.add(c);
    }

    entries.push({
      list: "UK",
      entryId: txt(d.UniqueID) || txt(d.OFSIGroupID),
      subjectType,
      names,
      identifiers: [...identifiers],
      programmes: [txt(d.RegimeName)].filter(Boolean),
      listedOn: isoDate(txt(d.DateDesignated)),
      countries: [...countries],
      remarks: cap(txt(d.OtherInformation)),
    });
  }
  return { entries, versionDate };
}
