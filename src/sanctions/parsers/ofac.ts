import { SourceError } from "../../core/errors.js";
import type { SanctionEntry, SubjectType } from "../types.js";
import { acceptIdentifier, asArray, assertComplete, cap, chunks, makeParser, txt } from "../xml.js";

const parser = makeParser(["aka", "id", "program", "address"]);

type Node = Record<string, unknown>;

const SUBJECT: Record<string, SubjectType> = {
  Individual: "person",
  Entity: "entity",
  Vessel: "vessel",
  Aircraft: "other",
};

/**
 * ID types worth indexing: registration-style numbers of entities and vessels. Contact details,
 * free-text notes and personal documents are excluded (we only match entities' own identifiers).
 */
const WANTED_ID_TYPE =
  /registration (number|id|identification)|business registration|company number|commercial registry|legal entity number|swift|\bbic\b|tax id|v\.a\.t|unified social credit|folio mercantil|trade license|r\.f\.c|nit #|ruc #|\bimo\b|mmsi|economic register|identification number|government gazette/i;
// Checked first: generic words such as "organization" or "date" appear in types we must skip
// ("Organization Established Date", "Organization Type:").
const UNWANTED_ID_TYPE =
  /passport|national id|driver|birth|cedula|ssn|social security|website|email|phone|fax|url|secondary|sanction|executive order|designation|date|type:|digital currency/i;

const fullName = (n: Node): string =>
  [txt(n.firstName), txt(n.lastName)].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

/** OFAC Specially Designated Nationals list (SDN.XML). Version date is Publish_Date (MM/DD/YYYY). */
export function parseOfac(xml: string): { entries: SanctionEntry[]; versionDate?: string } {
  if (!xml.includes("<sdnList")) {
    throw new SourceError("OFAC SDN list has an unexpected format", "ofac", "bad_response");
  }
  assertComplete(xml, "</sdnList>", "OFAC_SDN");
  const head = xml.slice(0, 3000);
  const m = /<Publish_Date>(\d{2})\/(\d{2})\/(\d{4})<\/Publish_Date>/.exec(head);
  const versionDate = m ? `${m[3]}-${m[1]}-${m[2]}` : undefined;
  const declaredCount = Number(/<Record_Count>(\d+)<\/Record_Count>/.exec(head)?.[1]);
  const entries: SanctionEntry[] = [];
  let seen = 0;

  for (const chunk of chunks(xml, "<sdnEntry>", "</sdnEntry>")) {
    seen++;
    const e = (parser.parse(chunk) as { sdnEntry?: Node }).sdnEntry;
    if (!e) continue;

    const names: SanctionEntry["names"] = [];
    const primary = fullName(e);
    if (primary) names.push({ name: primary, primary: true, strong: true });
    const akaList = e.akaList as { aka?: Node | Node[] } | undefined;
    for (const aka of asArray(akaList?.aka)) {
      const name = fullName(aka);
      if (!name || names.some((n) => n.name === name)) continue;
      names.push({ name, primary: false, strong: txt(aka.category).toLowerCase() !== "weak" });
    }
    if (names.length === 0) continue;

    const identifiers = new Set<string>();
    const subject = SUBJECT[txt(e.sdnType)] ?? "other";
    const idList = e.idList as { id?: Node | Node[] } | undefined;
    for (const id of subject === "person" ? [] : asArray(idList?.id)) {
      const type = txt(id.idType);
      if (UNWANTED_ID_TYPE.test(type) || !WANTED_ID_TYPE.test(type)) continue;
      const accepted = acceptIdentifier(txt(id.idNumber));
      if (accepted) identifiers.add(accepted);
    }

    const countries = new Set<string>();
    const addressList = e.addressList as { address?: Node | Node[] } | undefined;
    for (const a of asArray(addressList?.address)) {
      const c = txt(a.country);
      if (c) countries.add(c);
    }

    const programList = e.programList as { program?: unknown } | undefined;
    entries.push({
      list: "OFAC_SDN",
      entryId: txt(e.uid),
      subjectType: subject,
      names,
      identifiers: [...identifiers],
      programmes: asArray(programList?.program).map(txt).filter(Boolean),
      countries: [...countries],
      remarks: cap(txt(e.remarks)),
    });
  }
  // The file states how many records it holds; fewer parsed means it is cut off or malformed.
  if (Number.isFinite(declaredCount) && seen !== declaredCount) {
    throw new SourceError(
      `OFAC_SDN list is incomplete (${seen} of ${declaredCount} records)`,
      "ofac_sdn",
      "bad_response",
    );
  }
  return { entries, versionDate };
}
