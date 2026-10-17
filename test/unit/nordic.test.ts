import { describe, expect, it } from "vitest";
import { finlandAdapter } from "../../src/adapters/fi-prh/index.js";
import { gleifAdapter } from "../../src/adapters/gleif/index.js";
import { ownEntry } from "../../src/core/tables.js";
import { SCREENED_SCHEMES } from "../../src/sanctions/types.js";
import { resolveRef } from "../../src/services/entityRef.js";
import {
  describe as prhDescribe,
  mapFiAddress,
  mapFiEntity,
  mapFiLegalForm,
  mapFiNames,
  mapFiStatus,
  type PrhCompany,
} from "../../src/adapters/fi-prh/map.js";
import { norwayAdapter } from "../../src/adapters/no-brreg/index.js";
import {
  mapNoEntity,
  mapNoLegalForm,
  mapNoRole,
  mapNoRoles,
  mapNoStatus,
} from "../../src/adapters/no-brreg/map.js";
import {
  detectIdentifier,
  finnishVatFromBusinessId,
  formatNoOrgnr,
  normalizeFiBusinessId,
  normalizeNoOrgnr,
} from "../../src/core/identifiers.js";
import type { Identifier, Provenance } from "../../src/core/types.js";
import { fakeFetch, fixtureText, makeCtx } from "../helpers.js";

const prov: Provenance = {
  source: "brreg_no",
  sourceRecordId: "x",
  retrievedAt: "2026-01-01T00:00:00Z",
  fromCache: false,
};
const fx = (path: string) => JSON.parse(fixtureText(path));
const id = (scheme: Identifier["scheme"], value: string): Identifier => ({
  scheme,
  value,
  validated: false,
  provenance: [],
});
const BR = "https://data.brreg.no/enhetsregisteret/api";
const PRH = "https://avoindata.prh.fi/opendata-ytj-api/v3/companies";

describe("Norwegian organisation numbers", () => {
  it("validates the mod-11 check digit and accepts the usual spellings", () => {
    expect(normalizeNoOrgnr("923609016")).toBe("923609016");
    expect(normalizeNoOrgnr("923 609 016")).toBe("923609016");
    expect(normalizeNoOrgnr("NO923609016MVA")).toBe("923609016");
    expect(normalizeNoOrgnr("923609017")).toBeUndefined(); // wrong check digit
    expect(normalizeNoOrgnr("12345")).toBeUndefined();
    expect(normalizeNoOrgnr("92360901A")).toBeUndefined();
    expect(formatNoOrgnr("923609016")).toBe("923 609 016");
  });
});

describe("Finnish business IDs", () => {
  it("validates the check digit and canonicalises the hyphen", () => {
    expect(normalizeFiBusinessId("0112038-9")).toBe("0112038-9");
    expect(normalizeFiBusinessId("01120389")).toBe("0112038-9");
    expect(normalizeFiBusinessId("FI01120389")).toBe("0112038-9");
    expect(normalizeFiBusinessId("0112038-8")).toBeUndefined();
    expect(normalizeFiBusinessId("1001000-0")).toBeUndefined(); // remainder 1 is never valid
    expect(normalizeFiBusinessId("abc")).toBeUndefined();
    expect(finnishVatFromBusinessId("0112038-9")).toBe("FI01120389");
  });
});

describe("detectIdentifier for the Nordics", () => {
  it("recognises Norwegian VAT form, Finnish IDs with hyphen, and bare numbers only with a country", () => {
    expect(detectIdentifier("NO923609016MVA")).toMatchObject({
      scheme: "NO_ORGNR",
      value: "923609016",
    });
    expect(detectIdentifier("0112038-9")).toMatchObject({
      scheme: "FI_YTUNNUS",
      value: "0112038-9",
    });
    expect(detectIdentifier("923609016")).toBeUndefined();
    expect(detectIdentifier("923 609 016", "NO")).toMatchObject({ scheme: "NO_ORGNR" });
    expect(detectIdentifier("01120389", "FI")).toMatchObject({
      scheme: "FI_YTUNNUS",
      value: "0112038-9",
    });
    // The Finnish VAT number stays a VAT number (VIES validates it); the adapter crosswalks it.
    expect(detectIdentifier("FI01120389")).toMatchObject({ scheme: "VAT" });
    expect(detectIdentifier("NO923609017MVA")).toBeUndefined();
  });
});

describe("Norway: mapping", () => {
  it("maps Equinor with legal form, address and former names", () => {
    const p = mapNoEntity(fx("brreg_no/equinor.json"), prov)!;
    expect(p.names[0]).toMatchObject({ name: "EQUINOR ASA", kind: "legal" });
    expect(p.names.filter((n) => n.kind === "former").map((n) => n.name)).toContain("STATOIL ASA");
    expect(p.identifiers[0]).toMatchObject({
      scheme: "NO_ORGNR",
      value: "923609016",
      validated: true,
    });
    expect(p.legalForm!.value).toMatchObject({
      localName: "Allmennaksjeselskap",
      normalized: "public_company",
    });
    expect(p.status!.value).toMatchObject({ normalized: "active", group: "operating" });
    expect(p.registeredAddress!.value).toMatchObject({
      postalCode: "4035",
      country: "NO",
      locality: "STAVANGER",
    });
    expect(p.incorporationDate!.value).toBe("1972-09-18");
    expect(p.jurisdiction).toBe("NO");
  });

  it("reads bankruptcy, winding-up and deletion as statuses and never guesses", () => {
    expect(mapNoStatus(fx("brreg_no/konkurs.json"))).toMatchObject({
      normalized: "insolvent",
      group: "distressed",
    });
    expect(mapNoStatus({ underAvvikling: true })).toMatchObject({
      normalized: "liquidation_voluntary",
    });
    expect(mapNoStatus({ underTvangsavviklingEllerTvangsopplosning: true })).toMatchObject({
      normalized: "liquidation_compulsory",
    });
    expect(mapNoStatus({ deleted: true })).toMatchObject({
      normalized: "dissolved",
      group: "ended",
    });
    expect(mapNoStatus({ slettedato: "2020-05-05" }).sourceText).toContain("2020-05-05");
  });

  it("maps legal forms by code and keeps the register's wording", () => {
    expect(mapNoLegalForm({ kode: "AS", beskrivelse: "Aksjeselskap" })?.normalized).toBe(
      "limited_company",
    );
    expect(mapNoLegalForm({ kode: "ENK", beskrivelse: "Enkeltpersonforetak" })?.normalized).toBe(
      "sole_proprietor",
    );
    expect(mapNoLegalForm({ kode: "STI", beskrivelse: "Stiftelse" })).toMatchObject({
      normalized: "other",
      localName: "Stiftelse",
    });
  });

  it("rejects entries without a valid number or name", () => {
    expect(mapNoEntity({ organisasjonsnummer: "923609017", navn: "X" }, prov)).toBeUndefined();
    expect(mapNoEntity({ organisasjonsnummer: "923609016" }, prov)).toBeUndefined();
  });

  it("maps roles: CEO, chair, members, deputies, auditor; flags resigned and deceased", () => {
    const { officers, unreadable } = mapNoRoles(fx("brreg_no/equinor-roller.json"));
    expect(unreadable).toBe(0);
    const byRole = (r: string) => officers.filter((o) => o.role === r);
    expect(byRole("ceo")).toHaveLength(1);
    expect(byRole("chair")).toHaveLength(1);
    expect(byRole("board_member").length).toBeGreaterThanOrEqual(2);
    expect(byRole("deputy").length).toBeGreaterThanOrEqual(1);
    const auditor = byRole("auditor")[0]!;
    expect(auditor).toMatchObject({ kind: "corporate", name: "ERNST & YOUNG AS" });
    expect(auditor.corporateIdentifier).toMatchObject({ scheme: "NO_ORGNR", value: "976389387" });
    // one role is deregistered (avregistrert), one resigned (fratraadt)
    expect(officers.filter((o) => !o.active)).toHaveLength(2);
    expect(officers.filter((o) => o.deceased)).toHaveLength(1);
    const ceo = byRole("ceo")[0]!;
    expect(ceo.sourceRole).toBe("DAGL Daglig leder");
    expect(ceo.birth).toMatchObject({
      year: expect.any(Number),
      month: expect.any(Number),
      day: expect.any(Number),
    }); // as published
    expect(ceo.displayName).toBe(ceo.name); // already in natural order
  });

  it("skips roles it can not read, and keeps unknown role codes as 'other'", () => {
    expect(mapNoRole({ type: { kode: "DAGL" } })).toBeUndefined();
    expect(
      mapNoRole({
        type: { kode: "XYZ", beskrivelse: "Ny rolle" },
        person: { navn: { fornavn: "A", etternavn: "B" } },
      }),
    ).toMatchObject({
      role: "other",
      sourceRole: "XYZ Ny rolle",
    });
  });
});

describe("Norway: review regressions", () => {
  const person = { navn: { fornavn: "A", etternavn: "B" } };

  it("counts the roles it could not read instead of dropping them silently", () => {
    const body = {
      rollegrupper: [
        { roller: [{ type: { kode: "NEST" }, person }, { type: { kode: "DAGL" } }, { type: {} }] },
      ],
    };
    const { officers, unreadable } = mapNoRoles(body);
    expect(officers).toHaveLength(1);
    expect(unreadable).toBe(2);
  });

  it("flags an officer list that lost roles as truncated, with the registry's full count", async () => {
    const full = fx("brreg_no/equinor-roller.json");
    full.rollegrupper[0].roller.push({ type: { kode: "NEST" } }); // no person, no unit
    const f = fakeFetch({
      [`${BR}/enheter/923609016/roller`]: { body: JSON.stringify(full) },
    });
    const r = (await norwayAdapter.officers!(id("NO_ORGNR", "923609016"), makeCtx(f)))!;
    expect(r.total).toBe(16);
    expect(r.officers).toHaveLength(15);
    expect(r.truncated).toBe(true);
  });

  it("does not let registry codes reach Object.prototype", () => {
    for (const kode of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(mapNoRole({ type: { kode }, person })!.role).toBe("other");
      expect(mapNoLegalForm({ kode, beskrivelse: "x" })!.normalized).toBe("other");
    }
  });

  it("refuses an answer about a different unit than the one asked for", async () => {
    const f = fakeFetch({
      [`${BR}/enheter/987654325`]: { body: fixtureText("brreg_no/equinor.json") },
    });
    const ctx = makeCtx(f);
    await expect(norwayAdapter.lookup(id("NO_ORGNR", "987654325"), ctx)).rejects.toMatchObject({
      kind: "bad_response",
    });
    await expect(norwayAdapter.lookup(id("NO_ORGNR", "987654325"), ctx)).rejects.toThrow();
    expect(f.calls).toHaveLength(2); // not cached
  });

  it("does not present the register-entry date as the incorporation date", () => {
    const e = {
      organisasjonsnummer: "923609016",
      navn: "X",
      registreringsdatoEnhetsregisteret: "1995-03-12",
    };
    expect(mapNoEntity(e, prov)!.incorporationDate).toBeUndefined();
    expect(
      mapNoEntity({ ...e, stiftelsesdato: "1972-09-18" }, prov)!.incorporationDate!.value,
    ).toBe("1972-09-18");
    expect(
      mapNoEntity({ ...e, stiftelsesdato: "not a date" }, prov)!.incorporationDate,
    ).toBeUndefined();
  });

  it("keeps a deleted unit without a name nameless instead of inventing one", async () => {
    const f = fakeFetch({ [`${BR}/enheter/923609016`]: { status: 410, body: "" } });
    const p = (await norwayAdapter.lookup(id("NO_ORGNR", "923609016"), makeCtx(f)))!;
    expect(p.names).toEqual([]);
    expect(p.status!.value.normalized).toBe("dissolved");
  });

  it("describes search hits with the same address as the profile, or none", async () => {
    const hit = (extra: object) =>
      JSON.stringify({
        page: {},
        _embedded: { enheter: [{ organisasjonsnummer: "923609016", navn: "X AS", ...extra }] },
      });
    const postal = fakeFetch({
      [`${BR}/enheter?navn=`]: {
        body: hit({
          postadresse: {
            adresse: ["Postboks 1"],
            postnummer: "0001",
            poststed: "OSLO",
            land: "Norge",
          },
        }),
      },
    });
    const [h1] = await norwayAdapter.search!("x as", makeCtx(postal));
    expect(h1!.address).toBe("Postboks 1, 0001 OSLO, Norge");
    const none = fakeFetch({ [`${BR}/enheter?navn=`]: { body: hit({}) } });
    const [h2] = await norwayAdapter.search!("x as", makeCtx(none));
    expect(h2!.address).toBeUndefined();
  });
});

describe("Norway: adapter", () => {
  it("looks a company up, caching it, and returns undefined for unknown or invalid numbers", async () => {
    const f = fakeFetch({
      [`${BR}/enheter/923609016`]: { body: fixtureText("brreg_no/equinor.json") },
      [`${BR}/enheter/987654325`]: { status: 404, body: "" },
    });
    const ctx = makeCtx(f);
    const first = await norwayAdapter.lookup(id("NO_ORGNR", "923609016"), ctx);
    expect(first!.identifiers[0]!.provenance[0]).toMatchObject({
      source: "brreg_no",
      licence: expect.stringContaining("NLOD"),
    });
    await norwayAdapter.lookup(id("NO_ORGNR", "923609016"), ctx);
    expect(f.calls).toHaveLength(1);
    expect(await norwayAdapter.lookup(id("NO_ORGNR", "987654325"), ctx)).toBeUndefined();
    expect(await norwayAdapter.lookup(id("NO_ORGNR", "12345"), ctx)).toBeUndefined();
    expect(f.calls).toHaveLength(2); // the invalid number never reached the network
  });

  it("treats 410 Gone as a deleted unit, not as an active one", async () => {
    const f = fakeFetch({
      [`${BR}/enheter/923609016`]: {
        status: 410,
        body: JSON.stringify({ navn: "GAMMEL AS", slettedato: "2020-05-05" }),
      },
    });
    const p = await norwayAdapter.lookup(id("NO_ORGNR", "923609016"), makeCtx(f));
    expect(p!.status!.value).toMatchObject({ normalized: "dissolved", group: "ended" });
    expect(p!.dissolutionDate!.value).toBe("2020-05-05");
    const noBody = fakeFetch({ [`${BR}/enheter/923609016`]: { status: 410, body: "" } });
    const q = await norwayAdapter.lookup(id("NO_ORGNR", "923609016"), makeCtx(noBody));
    expect(q!.status!.value.normalized).toBe("dissolved");
    expect(q!.dissolutionDate).toBeUndefined(); // no invented date
  });

  it("rejects malformed bodies without caching them", async () => {
    const f = fakeFetch({ [`${BR}/enheter/923609016`]: { body: JSON.stringify({ oops: true }) } });
    const ctx = makeCtx(f);
    await expect(norwayAdapter.lookup(id("NO_ORGNR", "923609016"), ctx)).rejects.toMatchObject({
      kind: "bad_response",
    });
    await expect(norwayAdapter.lookup(id("NO_ORGNR", "923609016"), ctx)).rejects.toMatchObject({
      kind: "bad_response",
    });
    expect(f.calls).toHaveLength(2);
  });

  it("searches by name and tolerates an empty result", async () => {
    const f = fakeFetch({
      [`${BR}/enheter?navn=`]: { body: fixtureText("brreg_no/search-equinor.json") },
    });
    const hits = await norwayAdapter.search!("equinor", makeCtx(f), 3);
    expect(hits.map((h) => h.identifier.value)).toEqual(["923609016", "959733600", "983908179"]);
    expect(hits[0]).toMatchObject({ name: "EQUINOR ASA", jurisdiction: "NO" });
    const none = fakeFetch({
      [`${BR}/enheter?navn=`]: { body: JSON.stringify({ page: { totalElements: 0 }, _links: {} }) },
    });
    expect(await norwayAdapter.search!("zzzzzz", makeCtx(none), 3)).toEqual([]);
    const bad = fakeFetch({
      [`${BR}/enheter?navn=`]: { body: JSON.stringify({ feilmelding: "x" }) },
    });
    await expect(norwayAdapter.search!("zzzzzz", makeCtx(bad), 3)).rejects.toMatchObject({
      kind: "bad_response",
    });
  });

  it("fetches roles as cached personal data with provenance", async () => {
    const f = fakeFetch({
      [`${BR}/enheter/923609016/roller`]: { body: fixtureText("brreg_no/equinor-roller.json") },
    });
    const ctx = makeCtx(f);
    const r = (await norwayAdapter.officers!(id("NO_ORGNR", "923609016"), ctx))!;
    expect(r.total).toBe(15);
    expect(r.activeCount).toBe(13);
    expect(r.resignedCount).toBe(2);
    expect(r.provenance).toMatchObject({
      source: "brreg_no",
      sourceUrl: expect.stringContaining("/roller"),
    });
    expect(
      (await norwayAdapter.officers!(id("NO_ORGNR", "923609016"), ctx))!.provenance.fromCache,
    ).toBe(true);
    const gone = fakeFetch({ [`${BR}/enheter/923609016/roller`]: { status: 404, body: "" } });
    expect(
      await norwayAdapter.officers!(id("NO_ORGNR", "923609016"), makeCtx(gone)),
    ).toBeUndefined();
  });

  it("declares that beneficial owners are not public", () => {
    expect(norwayAdapter.restrictions?.controllers?.reason).toBe("restricted_access");
  });
});

describe("Finland: mapping", () => {
  const nokia = fx("prh_fi/nokia.json").companies[0] as PrhCompany;

  it("maps Nokia: current official name first, former names marked, form, address", () => {
    const p = mapFiEntity(nokia, { ...prov, source: "prh_fi" })!;
    expect(p.names[0]).toMatchObject({ name: "Nokia Oyj", kind: "legal" });
    expect(p.names.find((n) => n.name === "Oy Nokia Ab")).toMatchObject({
      kind: "former",
      validTo: "1997-08-31",
    });
    expect(p.identifiers[0]).toMatchObject({ scheme: "FI_YTUNNUS", value: "0112038-9" });
    expect(p.legalForm!.value).toMatchObject({
      localName: "Public limited company",
      normalized: "public_company",
    });
    expect(p.registeredAddress!.value).toMatchObject({
      postalCode: "02610",
      locality: "ESPOO",
      country: "FI",
    });
    expect(p.registeredAddress!.value.formatted).toBe("Karakaari 7, 02610 ESPOO, Finland");
    expect(p.incorporationDate!.value).toBe("1896-12-19");
  });

  it("reads status from the trade register and company situations, never from the useless status field", () => {
    expect(mapFiStatus(nokia)).toMatchObject({
      normalized: "active",
      sourceText: "trade register: Registered",
    });
    const ceased = fx("prh_fi/0100002-9.json").companies[0];
    expect(mapFiStatus(ceased)).toMatchObject({
      normalized: "dissolved",
      group: "ended",
      sourceText: "trade register: Ceased",
    });
    expect(mapFiStatus(fx("prh_fi/0104057-3.json").companies[0])).toMatchObject({
      normalized: "insolvent",
      group: "distressed",
    });
    expect(mapFiStatus(fx("prh_fi/0100723-9.json").companies[0])).toMatchObject({
      normalized: "in_liquidation",
    });
    expect(mapFiStatus(fx("prh_fi/0100024-8.json").companies[0]).normalized).toBe("active");
  });

  it("does not hide an unknown situation or a missing trade register behind 'registered'", () => {
    const odd: PrhCompany = { ...nokia, companySituations: [{ type: "SANE" }] };
    expect(mapFiStatus(odd)).toMatchObject({
      normalized: "unknown",
      sourceText: "company situation SANE",
    });
    expect(mapFiStatus({ registeredEntries: [] })).toMatchObject({
      normalized: "unknown",
      sourceText: "not in the trade register",
    });
    const unregistered: PrhCompany = {
      registeredEntries: [
        {
          register: "1",
          registrationDate: "2020-01-01",
          descriptions: [{ languageCode: "3", description: "Unregistered" }],
        },
      ],
    };
    expect(mapFiStatus(unregistered).normalized).toBe("unknown");
    // A ended situation no longer counts.
    const over: PrhCompany = {
      ...nokia,
      companySituations: [{ type: "KONK", endDate: "2020-01-01" }],
    };
    expect(mapFiStatus(over).normalized).toBe("active");
  });

  it("maps forms by English wording and falls back to the local wording", () => {
    expect(mapFiLegalForm(fx("prh_fi/0100002-9.json").companies[0])?.normalized).toBe(
      "limited_company",
    );
    expect(mapFiLegalForm(fx("prh_fi/0104057-3.json").companies[0])?.normalized).toBe(
      "partnership",
    );
    expect(mapFiLegalForm(fx("prh_fi/0100024-8.json").companies[0])).toMatchObject({
      localName: "Housing corporation",
      normalized: "other",
    });
    expect(prhDescribe({ descriptions: [{ languageCode: "1", description: "Osakeyhtiö" }] })).toBe(
      "Osakeyhtiö",
    );
    expect(mapFiLegalForm({ companyForms: [] })).toBeUndefined();
  });

  it("formats addresses with c/o and PO box, and ignores ended ones", () => {
    const c: PrhCompany = {
      addresses: [
        {
          type: 1,
          street: "Old Street",
          buildingNumber: "1",
          postCode: "00100",
          postOffices: [{ city: "HELSINKI", languageCode: "1" }],
          endDate: "2010-01-01",
        },
        {
          type: 1,
          co: "Acme Oy",
          street: "Main",
          buildingNumber: "5",
          entrance: "B",
          apartmentNumber: "12",
          postCode: "00200",
          postOffices: [
            { city: "HELSINGFORS", languageCode: "2" },
            { city: "HELSINKI", languageCode: "1" },
          ],
        },
      ],
    };
    expect(mapFiAddress(c)!.formatted).toBe("c/o Acme Oy, Main 5 B 12, 00200 HELSINKI, Finland");
    expect(
      mapFiAddress({
        addresses: [
          {
            type: 2,
            postOfficeBox: "99",
            postCode: "00101",
            postOffices: [{ city: "HELSINKI", languageCode: "1" }],
          },
        ],
      })!.formatted,
    ).toBe("PL 99, 00101 HELSINKI, Finland");
    expect(mapFiAddress({ addresses: [] })).toBeUndefined();
  });

  it("separates official, auxiliary and former names", () => {
    const names = mapFiNames(
      {
        names: [
          { name: "Old Name Oy", type: "1", registrationDate: "1990-01-01", endDate: "2000-01-01" },
          { name: "New Name Oy", type: "1", registrationDate: "2000-01-01" },
          { name: "Brand", type: "3", registrationDate: "2005-01-01" },
        ],
      },
      prov,
    );
    expect(names.map((n) => [n.name, n.kind])).toEqual([
      ["New Name Oy", "legal"],
      ["Brand", "trading"],
      ["Old Name Oy", "former"],
    ]);
  });
});

describe("Finland: review regressions", () => {
  const ceased = fx("prh_fi/0100002-9.json").companies[0] as PrhCompany;

  it("gives a ceased company the name it carried to the end as its legal name", () => {
    const names = mapFiNames(ceased, prov);
    expect(names[0]).toMatchObject({
      name: "Artjärven Metalli Oy",
      kind: "legal",
      validTo: "2005-12-19",
    });
    expect(mapFiEntity(ceased, prov)!.names.some((n) => n.kind === "legal")).toBe(true);
  });

  it("keeps ceased companies in name search results", async () => {
    const body = JSON.stringify({ totalResults: 1, companies: [ceased] });
    const f = fakeFetch({ [`${PRH}?name=`]: { body } });
    const hits = await finlandAdapter.search!("artjärven", makeCtx(f));
    expect(hits.map((h) => h.name)).toEqual(["Artjärven Metalli Oy"]);
    expect(hits[0]!.status).toMatchObject({ normalized: "dissolved" });
  });

  it("does not mistake a renamed company's old name for its legal name", () => {
    const names = mapFiNames(
      {
        names: [
          { name: "Old Oy", type: "1", registrationDate: "1990-01-01", endDate: "2000-01-01" },
          { name: "New Oy", type: "1", registrationDate: "2000-01-01" },
        ],
      },
      prov,
    );
    expect(names.filter((n) => n.kind === "legal").map((n) => n.name)).toEqual(["New Oy"]);
  });

  it("does not let registry codes reach Object.prototype", () => {
    for (const type of ["constructor", "toString", "__proto__"]) {
      expect(mapFiStatus({ companySituations: [{ type }] })).toMatchObject({
        normalized: "unknown",
        sourceText: `company situation ${type}`,
      });
    }
    const form = (d: string): PrhCompany => ({
      companyForms: [{ descriptions: [{ languageCode: "3", description: d }] }],
    });
    for (const d of ["constructor", "toString", "__proto__"]) {
      expect(mapFiLegalForm(form(d))).toMatchObject({ localName: d, normalized: "other" });
    }
  });

  it("refuses a list that does not contain the company asked for", async () => {
    const f = fakeFetch({ [`${PRH}?businessId=`]: { body: fixtureText("prh_fi/nokia.json") } });
    const ctx = makeCtx(f);
    // Nokia's record answers a request for another company: not 'found', not 'not found'.
    await expect(finlandAdapter.lookup(id("FI_YTUNNUS", "0100002-9"), ctx)).rejects.toMatchObject({
      kind: "bad_response",
    });
    await expect(finlandAdapter.lookup(id("FI_YTUNNUS", "0100002-9"), ctx)).rejects.toThrow();
    expect(f.calls).toHaveLength(2); // not cached
  });

  it("accepts a business ID written without its leading zero", () => {
    expect(normalizeFiBusinessId("112038-9")).toBe("0112038-9");
    expect(normalizeFiBusinessId("1120389")).toBe("0112038-9");
    expect(normalizeFiBusinessId("112038-8")).toBeUndefined();
    expect(normalizeFiBusinessId("12345-6")).toBeUndefined(); // too short even for padding
    expect(detectIdentifier("112038-9")).toMatchObject({
      scheme: "FI_YTUNNUS",
      value: "0112038-9",
    });
  });
});

describe("Shared code: review regressions", () => {
  const GL = "https://api.gleif.org/api/v1/lei-records?filter[entity.registeredAs]=";
  const toLei = gleifAdapter.crosswalks!.find((c) => c.from === "NO_ORGNR")!;
  const equinorLei = { scheme: "LEI", value: "OW6OFBNCKXC4US5C7523" };

  it("finds the LEI from the spelling GLEIF uses even when the other spelling's request fails", async () => {
    const f = fakeFetch({
      [`${GL}923%20609%20016`]: { body: fixtureText("gleif/by-registration-equinor.json") },
      [`${GL}923609016`]: { status: 500, body: "" },
    });
    expect(await toLei.find(id("NO_ORGNR", "923609016"), makeCtx(f))).toMatchObject(equinorLei);
    expect(f.calls.length).toBeGreaterThanOrEqual(2); // both spellings were asked
  });

  it("does not conclude 'no LEI' when a spelling could not be checked", async () => {
    const empty = { body: JSON.stringify({ data: [] }) };
    const failing = fakeFetch({
      [`${GL}923%20609%20016`]: empty,
      [`${GL}923609016`]: { status: 500, body: "" },
    });
    await expect(toLei.find(id("NO_ORGNR", "923609016"), makeCtx(failing))).rejects.toThrow();
    const both = fakeFetch({ [`${GL}923%20609%20016`]: empty, [`${GL}923609016`]: empty });
    expect(await toLei.find(id("NO_ORGNR", "923609016"), makeCtx(both))).toBeUndefined();
    expect(both.calls).toHaveLength(2);
  });

  it("reads a Norwegian VAT number given with scheme VAT as the organisation number", () => {
    expect(resolveRef({ identifier: "NO923609016MVA", scheme: "VAT" })).toMatchObject({
      scheme: "NO_ORGNR",
      value: "923609016",
    });
    expect(() => resolveRef({ identifier: "NO923609017MVA", scheme: "VAT" })).toThrow(/NO_ORGNR/);
  });

  it("tells the user about every supported scheme and country when it can not tell what an identifier is", () => {
    expect(() => resolveRef({ identifier: "@@@@" })).toThrow(/FI_YTUNNUS/);
    expect(() => resolveRef({ identifier: "@@@@" })).toThrow(/GB, NO or FI/);
  });

  it("leaves Norwegian and Finnish numbers out of identifier matching against the lists", () => {
    // Bare 8-9 digit numbers could equal unrelated passport or tax numbers; identifier hits score 1.
    for (const scheme of ["NO_ORGNR", "FI_YTUNNUS"])
      expect(SCREENED_SCHEMES.has(scheme)).toBe(false);
    for (const scheme of ["LEI", "GB_CRN", "VAT"]) expect(SCREENED_SCHEMES.has(scheme)).toBe(true);
  });

  it("looks tables up by their own keys only", () => {
    const table = { a: 1 };
    expect(ownEntry(table, "a")).toBe(1);
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", undefined]) {
      expect(ownEntry(table, key)).toBeUndefined();
    }
  });
});

describe("Finland: adapter", () => {
  it("looks a company up by business ID in any spelling, and returns undefined for unknown ones", async () => {
    const f = fakeFetch({
      [`${PRH}?businessId=0112038-9`]: { body: fixtureText("prh_fi/nokia.json") },
      [`${PRH}?businessId=`]: { body: fixtureText("prh_fi/empty.json") },
    });
    const ctx = makeCtx(f);
    expect((await finlandAdapter.lookup(id("FI_YTUNNUS", "01120389"), ctx))!.names[0]!.name).toBe(
      "Nokia Oyj",
    );
    expect(await finlandAdapter.lookup(id("FI_YTUNNUS", "0112038-8"), ctx)).toBeUndefined(); // bad check digit, no request
    expect(f.calls).toHaveLength(1);
    const none = fakeFetch({ [`${PRH}?businessId=`]: { body: fixtureText("prh_fi/empty.json") } });
    expect(
      await finlandAdapter.lookup(id("FI_YTUNNUS", "0000001-9"), makeCtx(none)),
    ).toBeUndefined();
  });

  it("rejects an unexpected response and does not cache it", async () => {
    const f = fakeFetch({ [`${PRH}?businessId=`]: { body: JSON.stringify({ error: "x" }) } });
    const ctx = makeCtx(f);
    await expect(finlandAdapter.lookup(id("FI_YTUNNUS", "0112038-9"), ctx)).rejects.toMatchObject({
      kind: "bad_response",
    });
    await expect(finlandAdapter.lookup(id("FI_YTUNNUS", "0112038-9"), ctx)).rejects.toMatchObject({
      kind: "bad_response",
    });
    expect(f.calls).toHaveLength(2);
  });

  it("searches by name", async () => {
    const f = fakeFetch({ [`${PRH}?name=`]: { body: fixtureText("prh_fi/search-nokia.json") } });
    const hits = await finlandAdapter.search!("nokia", makeCtx(f), 3);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ name: "Nokia Oyj", jurisdiction: "FI" });
    expect(hits[0]!.identifier).toMatchObject({ scheme: "FI_YTUNNUS", value: "0112038-9" });
    expect(hits[0]!.status).toBeDefined();
  });

  it("translates between the Finnish VAT number and the business ID without any request", async () => {
    const [toId, toVat] = finlandAdapter.crosswalks!;
    const ctx = makeCtx(fakeFetch({}));
    expect(await toId!.find(id("VAT", "FI01120389"), ctx)).toMatchObject({
      scheme: "FI_YTUNNUS",
      value: "0112038-9",
    });
    expect(await toId!.find(id("VAT", "DE811128135"), ctx)).toBeUndefined();
    expect(await toVat!.find(id("FI_YTUNNUS", "0112038-9"), ctx)).toMatchObject({
      scheme: "VAT",
      value: "FI01120389",
    });
  });

  it("declares what Finland does not publish", () => {
    expect(finlandAdapter.restrictions?.officers?.reason).toBe("not_published_by_source");
    expect(finlandAdapter.restrictions?.controllers?.reason).toBe("restricted_access");
  });
});
