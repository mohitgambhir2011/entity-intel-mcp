import { fallbackEntityId, makeEntityId, makeIdentifierEntityId } from "../core/ids.js";
import {
  mergeProvenance,
  type Conflict,
  type CoverageReport,
  type EntityProfile,
} from "../core/entity.js";
import type {
  Address,
  EntityName,
  EntityStatus,
  Identifier,
  LegalForm,
  PartialEntity,
  SourceId,
  Sourced,
} from "../core/types.js";
import { sourceRank } from "../core/sources.js";
import { normaliseName } from "../resolution/normalise.js";

type Field =
  | "legalForm"
  | "status"
  | "incorporationDate"
  | "dissolutionDate"
  | "registeredAddress"
  | "headquartersAddress";

/**
 * Picks the highest-priority value for a field, merges provenance from sources that agree, and
 * records a Conflict when another source disagrees (D2). `same` decides what counts as agreement.
 */
function pickField<T>(
  partials: PartialEntity[],
  field: Field,
  same: (a: T, b: T) => boolean,
  conflicts: Conflict[],
  isWeak: (v: T) => boolean = () => false,
): Sourced<T> | undefined {
  const label = field as string;
  const candidates = partials
    .filter((p) => p[field] !== undefined)
    .sort((a, b) => sourceRank(a.source) - sourceRank(b.source))
    .map((p) => p[field] as unknown as Sourced<T>)
    // A weak value (e.g. status "unknown") never outranks a real one from a lower-priority source.
    .sort((a, b) => Number(isWeak(a.value)) - Number(isWeak(b.value)));
  const first = candidates[0];
  if (!first) return undefined;

  let provenance = first.provenance;
  const disagreeing: Sourced<T>[] = [];
  for (const other of candidates.slice(1)) {
    if (!same(first.value, other.value)) disagreeing.push(other);
    // A weak value ("unknown") is compatible with anything but corroborates nothing, so its
    // source must not be credited as supporting the chosen value.
    else if (!isWeak(other.value)) provenance = mergeProvenance(provenance, other.provenance);
  }
  if (disagreeing.length > 0) {
    conflicts.push({ field: label, values: [first, ...disagreeing] });
  }
  return { value: first.value, provenance };
}

const postcode = (a: Address): string | undefined =>
  a.postalCode?.replace(/\s+/g, "").toUpperCase() || undefined;

function mergeIdentifiers(partials: PartialEntity[]): Identifier[] {
  const map = new Map<string, Identifier>();
  for (const p of partials) {
    for (const id of p.identifiers) {
      const k = `${id.scheme}:${id.value}`;
      const prev = map.get(k);
      if (!prev) {
        map.set(k, { ...id, provenance: [...id.provenance] });
      } else {
        prev.validated = prev.validated || id.validated;
        if ((!prev.status || prev.status === "unknown") && id.status) prev.status = id.status;
        prev.country ??= id.country;
        prev.provenance = mergeProvenance(prev.provenance, id.provenance);
      }
    }
  }
  return [...map.values()];
}

function mergeNames(partials: PartialEntity[]): EntityName[] {
  const map = new Map<string, EntityName>();
  for (const p of [...partials].sort((a, b) => sourceRank(a.source) - sourceRank(b.source))) {
    for (const n of p.names) {
      const k = `${n.kind}|${n.name.trim().toLowerCase()}`;
      const prev = map.get(k);
      if (!prev) map.set(k, { ...n, provenance: [...n.provenance] });
      else prev.provenance = mergeProvenance(prev.provenance, n.provenance);
    }
  }
  const order = { legal: 0, former: 1, trading: 2, other: 3 } as const;
  return [...map.values()].sort((a, b) => order[a.kind] - order[b.kind]);
}

/** Identifier schemes that are a home-registry number, with the country and registry of their entity id. */
export const REGISTRY_IDS: [string, string, string][] = [
  ["GB_CRN", "GB", "CH"],
  ["NO_ORGNR", "NO", "BR"],
  ["FI_YTUNNUS", "FI", "PRH"],
];

export function chooseEntityId(
  identifiers: Identifier[],
  legalName: string | undefined,
  jurisdiction: string | undefined,
): string {
  // Home-registry numbers first (D20): <country>:<registry>:<number>.
  for (const [scheme, country, registry] of REGISTRY_IDS) {
    const found = identifiers.find((i) => i.scheme === scheme);
    if (found) return makeEntityId(country, registry, found.value);
  }
  const lei = identifiers.find((i) => i.scheme === "LEI");
  if (lei) return makeIdentifierEntityId("LEI", lei.value);
  const vat = identifiers.find((i) => i.scheme === "VAT");
  if (vat) return makeIdentifierEntityId("VAT", vat.value);
  if (legalName && jurisdiction) return fallbackEntityId(legalName, jurisdiction);
  return "unknown";
}

export function mergePartials(partials: PartialEntity[], sourcesTried: SourceId[]): EntityProfile {
  const conflicts: Conflict[] = [];

  const names = mergeNames(partials);
  const legalNames = partials
    .flatMap((p) => p.names.filter((n) => n.kind === "legal").map((n) => ({ p, n })))
    .sort((a, b) => sourceRank(a.p.source) - sourceRank(b.p.source));
  const firstLegal = legalNames[0];
  if (firstLegal) {
    const key = normaliseName(firstLegal.n.name).key;
    const differing = legalNames.filter((x) => normaliseName(x.n.name).key !== key);
    if (differing.length > 0) {
      conflicts.push({
        field: "legalName",
        values: [firstLegal, ...differing].map((x) => ({
          value: x.n.name,
          provenance: x.n.provenance,
        })),
      });
    }
  }

  const status = pickField<EntityStatus>(
    partials,
    "status",
    (a, b) =>
      a.normalized === b.normalized || a.normalized === "unknown" || b.normalized === "unknown",
    conflicts,
    (v) => v.normalized === "unknown",
  );
  const legalForm = pickField<LegalForm>(partials, "legalForm", () => true, conflicts);
  if (legalForm && !legalForm.value.code) {
    const code = partials.map((p) => p.legalForm?.value.code).find(Boolean);
    if (code) legalForm.value = { ...legalForm.value, code };
  }
  const incorporationDate = pickField<string>(
    partials,
    "incorporationDate",
    (a, b) => a === b,
    conflicts,
  );
  const dissolutionDate = pickField<string>(
    partials,
    "dissolutionDate",
    (a, b) => a === b,
    conflicts,
  );
  const registeredAddress = pickField<Address>(
    partials,
    "registeredAddress",
    (a, b) => !postcode(a) || !postcode(b) || postcode(a) === postcode(b),
    conflicts,
  );
  const headquartersAddress = pickField<Address>(
    partials,
    "headquartersAddress",
    (a, b) => !postcode(a) || !postcode(b) || postcode(a) === postcode(b),
    conflicts,
  );

  const identifiers = mergeIdentifiers(partials);
  const jurisdiction = [...partials]
    .sort((a, b) => sourceRank(a.source) - sourceRank(b.source))
    .map((p) => p.jurisdiction)
    .find(Boolean);

  const legalName = names.find((n) => n.kind === "legal")?.name;
  const entityId = chooseEntityId(identifiers, legalName, jurisdiction);
  const lei = identifiers.find((i) => i.scheme === "LEI");
  const aliases =
    entityId.startsWith("ID:LEI:") || !lei ? [] : [makeIdentifierEntityId("LEI", lei.value)];

  const sources = [...new Set(partials.map((p) => p.source))];
  const coverage: CoverageReport = {
    jurisdiction,
    families: {
      identity: { state: partials.length > 0 ? "available" : "unavailable", sourcesTried },
      // officers, ownership, filings and insolvency depend on which sources are enabled: buildProfile fills them in.
      regulatory: { state: "not_yet_supported", sourcesTried: [] },
      sanctions: {
        state: "available",
        sourcesTried: [],
        note: "Call screen_sanctions with this entity_id (UK, EU, OFAC SDN)",
      },
    },
  };

  return {
    entityId,
    aliases,
    names,
    identifiers,
    jurisdiction,
    legalForm,
    status,
    incorporationDate,
    dissolutionDate,
    registeredAddress,
    headquartersAddress,
    conflicts,
    coverage,
    sources,
  };
}
