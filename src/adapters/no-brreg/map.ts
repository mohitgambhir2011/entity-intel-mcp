import { displayPersonName, type Officer, type OfficerRole } from "../../core/people.js";
import { normalizeNoOrgnr } from "../../core/identifiers.js";
import { ownEntry } from "../../core/tables.js";
import { makeStatus } from "../../core/types.js";
import type {
  Address,
  EntityStatus,
  Identifier,
  LegalForm,
  PartialEntity,
  Provenance,
} from "../../core/types.js";

export const LICENCE = "Norwegian Licence for Open Government Data (NLOD 2.0)";
export const BASE = "https://data.brreg.no/enhetsregisteret/api";

// ---------------------------------------------------------------- raw shapes (only what we read)

export interface BrAddress {
  adresse?: string[];
  postnummer?: string;
  poststed?: string;
  kommune?: string;
  landkode?: string;
  land?: string;
}

export interface BrEntity {
  organisasjonsnummer?: string;
  navn?: string;
  organisasjonsform?: { kode?: string; beskrivelse?: string };
  stiftelsesdato?: string;
  forretningsadresse?: BrAddress;
  postadresse?: BrAddress;
  konkurs?: boolean;
  konkursdato?: string;
  underAvvikling?: boolean;
  underAvviklingDato?: string;
  underTvangsavviklingEllerTvangsopplosning?: boolean;
  underTvangsavviklingEllerTvangsopplosningDato?: string;
  slettedato?: string;
  /** Set by the adapter when the register answers 410 Gone (the unit was deleted). */
  deleted?: boolean;
  historiskeNavn?: { navn?: string; fraDato?: string; tilDato?: string }[];
}

export interface BrRole {
  type?: { kode?: string; beskrivelse?: string };
  person?: {
    erDoed?: boolean;
    fodselsdato?: string;
    navn?: { fornavn?: string; mellomnavn?: string; etternavn?: string };
  };
  enhet?: { organisasjonsnummer?: string; navn?: string[] };
  fratraadt?: boolean;
  avregistrert?: boolean;
}

export interface BrRoles {
  rollegrupper?: { type?: { kode?: string }; roller?: BrRole[] }[];
}

// ---------------------------------------------------------------- mapping

/** Legal forms by Enhetsregisteret code; anything else is "other" with the register's wording. */
const FORMS: Record<string, LegalForm["normalized"]> = {
  AS: "limited_company",
  ASA: "public_company",
  ENK: "sole_proprietor",
  NUF: "branch",
  ANS: "partnership",
  DA: "partnership",
  KS: "partnership",
  SA: "cooperative",
  BRL: "cooperative",
};

export function mapNoLegalForm(f: BrEntity["organisasjonsform"]): LegalForm | undefined {
  if (!f?.kode && !f?.beskrivelse) return undefined;
  return {
    localName: f.beskrivelse ?? f.kode ?? "",
    normalized: ownEntry(FORMS, f.kode) ?? "other",
  };
}

/**
 * Enhetsregisteret states bankruptcy, voluntary and compulsory winding-up as flags and a deleted
 * unit as `slettedato`. Everything else is an operating entity as far as the register says.
 */
export function mapNoStatus(e: BrEntity): EntityStatus {
  if (e.deleted || e.slettedato) {
    return makeStatus(
      "dissolved",
      e.slettedato ? `deleted ${e.slettedato}` : "deleted from the register",
    );
  }
  if (e.konkurs) return makeStatus("insolvent", "konkurs (bankrupt)");
  if (e.underTvangsavviklingEllerTvangsopplosning) {
    return makeStatus("liquidation_compulsory", "under tvangsavvikling eller tvangsoppløsning");
  }
  if (e.underAvvikling) return makeStatus("liquidation_voluntary", "under avvikling");
  return makeStatus("active", "registered");
}

export function mapNoAddress(a: BrAddress | undefined): Address | undefined {
  if (!a) return undefined;
  const lines = (a.adresse ?? []).filter(Boolean);
  const parts = [...lines, [a.postnummer, a.poststed].filter(Boolean).join(" "), a.land].filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
  if (parts.length === 0) return undefined;
  return {
    lines,
    locality: a.poststed,
    region: a.kommune,
    postalCode: a.postnummer,
    country: a.landkode,
    formatted: parts.join(", "),
  };
}

/** Enhetsregisteret timestamps look like "2001-05-11 08:32:09": keep the date. */
const day = (v: string | undefined): string | undefined => (v ? v.slice(0, 10) : undefined);
const isDay = (v: string | undefined): v is string =>
  v !== undefined && /^\d{4}-\d{2}-\d{2}/.test(v);

export function mapNoEntity(e: BrEntity, prov: Provenance): PartialEntity | undefined {
  const orgnr = e.organisasjonsnummer ? normalizeNoOrgnr(e.organisasjonsnummer) : undefined;
  const name = e.navn?.trim();
  // A deleted unit may come back without a name. That is still a fact worth reporting (D28), so it
  // is kept nameless rather than given a made-up name that would be shown and screened as real.
  if (!orgnr || (!name && !e.deleted)) return undefined;
  const identifier: Identifier = {
    scheme: "NO_ORGNR",
    value: orgnr,
    country: "NO",
    status: e.deleted || e.slettedato ? "retired" : "active",
    validated: true,
    provenance: [prov],
  };
  const names: PartialEntity["names"] = name ? [{ name, kind: "legal", provenance: [prov] }] : [];
  for (const h of e.historiskeNavn ?? []) {
    if (h.navn && h.navn !== name) {
      names.push({
        name: h.navn,
        kind: "former",
        validFrom: day(h.fraDato),
        validTo: day(h.tilDato),
        provenance: [prov],
      });
    }
  }
  const registered = mapNoAddress(e.forretningsadresse) ?? mapNoAddress(e.postadresse);
  const legalForm = mapNoLegalForm(e.organisasjonsform);
  return {
    source: "brreg_no",
    names,
    identifiers: [identifier],
    jurisdiction: "NO",
    legalForm: legalForm ? { value: legalForm, provenance: [prov] } : undefined,
    status: { value: mapNoStatus(e), provenance: [prov] },
    // Only the founding date. The date the unit entered the register (registreringsdato...) is a
    // different event, often decades later, and must not be shown as incorporation.
    incorporationDate: isDay(e.stiftelsesdato)
      ? { value: day(e.stiftelsesdato)!, provenance: [prov] }
      : undefined,
    dissolutionDate: isDay(e.slettedato)
      ? { value: day(e.slettedato)!, provenance: [prov] }
      : undefined,
    registeredAddress: registered ? { value: registered, provenance: [prov] } : undefined,
    notes: [],
  };
}

// ---------------------------------------------------------------- roles

/** Enhetsregisteret role codes -> normalised roles. The register's own wording is kept as sourceRole. */
const ROLES: Record<string, OfficerRole> = {
  DAGL: "ceo",
  LEDE: "chair",
  NEST: "board_member",
  MEDL: "board_member",
  VARA: "deputy",
  REVI: "auditor",
  REGN: "accountant",
  SIGN: "authorised_signatory",
  PROK: "authorised_signatory",
  INNH: "manager",
  FFØR: "manager",
};

export function mapNoRole(r: BrRole): Officer | undefined {
  const code = r.type?.kode ?? "";
  const sourceRole = [code, r.type?.beskrivelse].filter(Boolean).join(" ");
  const active = !r.fratraadt && !r.avregistrert;
  const role = ownEntry(ROLES, code) ?? "other";

  if (r.person?.navn) {
    const n = r.person.navn;
    const name = [n.fornavn, n.mellomnavn, n.etternavn].filter(Boolean).join(" ").trim();
    if (!name) return undefined;
    const born = /^(\d{4})-(\d{2})-(\d{2})/.exec(r.person.fodselsdato ?? "");
    return {
      kind: "person",
      name,
      displayName: displayPersonName(name),
      role,
      sourceRole,
      active,
      deceased: r.person.erDoed ? true : undefined,
      // Published in full by the register (D23: shown as published).
      birth: born
        ? { year: Number(born[1]), month: Number(born[2]), day: Number(born[3]) }
        : undefined,
    };
  }
  if (r.enhet) {
    const name = r.enhet.navn?.[0]?.trim();
    if (!name) return undefined;
    const orgnr = r.enhet.organisasjonsnummer
      ? normalizeNoOrgnr(r.enhet.organisasjonsnummer)
      : undefined;
    return {
      kind: "corporate",
      name,
      displayName: name,
      role,
      sourceRole,
      active,
      corporateIdentifier: orgnr
        ? { scheme: "NO_ORGNR", value: orgnr, country: "NO", validated: true, provenance: [] }
        : undefined,
    };
  }
  return undefined;
}

/**
 * Every role the register lists, as officers, plus how many it listed but we could not read (no
 * usable name). The count matters: an officer list that silently lost entries must not be
 * screened or reported as complete.
 */
export function mapNoRoles(roles: BrRoles): { officers: Officer[]; unreadable: number } {
  const listed = (roles.rollegrupper ?? []).flatMap((g) => g.roller ?? []);
  const officers = listed.map(mapNoRole).filter((o): o is Officer => o !== undefined);
  return { officers, unreadable: listed.length - officers.length };
}
