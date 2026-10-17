import { describe, expect, it } from "vitest";
import {
  describeExemption,
  describeStatement,
  fetchControllers,
  fetchOfficers,
  mapController,
  mapOfficer,
  officerRole,
  parseNatures,
} from "../../src/adapters/companies-house/people.js";
import { displayPersonName } from "../../src/core/people.js";
import { fakeFetch, fixtureText, makeCtx } from "../helpers.js";

const CH = "https://api.company-information.service.gov.uk";
const fx = (n: string) => JSON.parse(fixtureText(`companies_house/${n}.json`));

describe("officers: mapping", () => {
  it("normalises roles and keeps the registry wording", () => {
    expect(officerRole("director")).toBe("director");
    expect(officerRole("corporate-director")).toBe("director");
    expect(officerRole("nominee-secretary")).toBe("secretary");
    expect(officerRole("llp-designated-member")).toBe("llp_member");
    expect(officerRole("cic-manager")).toBe("manager");
    expect(officerRole("judicial-factor")).toBe("other");
  });

  it("turns 'SURNAME, Forenames' into a display name and keeps the published one", () => {
    expect(displayPersonName("EXAMPLE, Jane Alice")).toBe("Jane Alice EXAMPLE");
    expect(displayPersonName("Plain Name")).toBe("Plain Name");
    expect(displayPersonName("Dr. Jane Q Public")).toBe("Jane Q Public");
    expect(displayPersonName("PUBLIC, Dr Jane")).toBe("Jane PUBLIC");
    expect(displayPersonName("Mister")).toBe("Mister"); // a lone word is never stripped
    const o = mapOfficer({ name: "EXAMPLE, Jane Alice", officer_role: "director" });
    expect(o).toMatchObject({
      kind: "person",
      name: "EXAMPLE, Jane Alice",
      displayName: "Jane Alice EXAMPLE",
      role: "director",
      sourceRole: "director",
      active: true,
    });
  });

  it("marks resigned officers inactive and keeps partial birth dates as published", () => {
    const o = mapOfficer({
      name: "X, Y",
      officer_role: "secretary",
      resigned_on: "2020-01-01",
      date_of_birth: { month: 5, year: 1970 },
    });
    expect(o.active).toBe(false);
    expect(o.birth).toEqual({ month: 5, year: 1970, day: undefined });
  });

  it("treats corporate officers as entities and follows UK registrations only", () => {
    const uk = mapOfficer({
      name: "HARMER SLATER LIMITED",
      officer_role: "corporate-secretary",
      identification: {
        registration_number: "3071456",
        place_registered: "Companies House",
        legal_authority: "United Kingdom (England)",
        identification_type: "uk-limited-company",
      },
    });
    expect(uk.kind).toBe("corporate");
    expect(uk.displayName).toBe("HARMER SLATER LIMITED"); // never reordered
    expect(uk.corporateIdentifier).toMatchObject({ scheme: "GB_CRN", value: "03071456" });

    const foreign = mapOfficer({
      name: "ACME SA",
      officer_role: "corporate-director",
      identification: {
        registration_number: "123456789",
        place_registered: "Luxembourg",
        legal_authority: "Luxembourg law",
      },
    });
    expect(foreign.corporateIdentifier).toBeUndefined();

    // A corporate role without identification details is still an entity, not a person.
    expect(
      mapOfficer({ name: "UK COMPANY SECRETARY LTD", officer_role: "corporate-secretary" }).kind,
    ).toBe("corporate");
  });
});

describe("controllers (PSC): mapping", () => {
  it("parses published percentage bands and control flags", () => {
    expect(
      parseNatures([
        "ownership-of-shares-25-to-50-percent",
        "voting-rights-50-to-75-percent",
        "right-to-appoint-and-remove-directors",
        "significant-influence-or-control",
      ]),
    ).toMatchObject({
      sharesMin: 25,
      sharesMax: 50,
      votingMin: 50,
      votingMax: 75,
      appointsDirectors: true,
      significantInfluence: true,
    });
    expect(
      parseNatures(["ownership-of-shares-more-than-25-percent-registered-overseas-entity"]),
    ).toMatchObject({
      sharesMin: 25,
      sharesMax: 100,
    });
    expect(parseNatures(["something-new"]).codes).toEqual(["something-new"]);
  });

  it("maps individuals, corporates and protected controllers", () => {
    const person = mapController(fx("psc-individual").items[0]);
    expect(person).toMatchObject({
      kind: "person",
      displayName: "Jane Alice Example", // title dropped, structured name used
      active: true,
      birth: { month: 5, year: 1975 },
    });
    expect(person.natures.sharesMin).toBe(25);

    const ceased = mapController(fx("psc-individual").items[1]);
    expect(ceased).toMatchObject({ active: false, ceasedOn: "2020-02-01" });

    const corp = mapController(fx("stores-psc").items[0]);
    expect(corp).toMatchObject({ kind: "corporate", name: "Tesco Holdings Limited" });
    expect(corp.corporateIdentifier).toMatchObject({ scheme: "GB_CRN", value: "00243011" });
    expect(corp.natures).toMatchObject({ sharesMin: 75, sharesMax: 100, appointsDirectors: true });

    const foreign = mapController(fx("havin-psc").items[0]);
    expect(foreign.kind).toBe("corporate");
    expect(foreign.corporateIdentifier).toBeUndefined();
    expect(foreign.registration?.countryRegistered).toBeTruthy();

    const hidden = mapController({
      kind: "super-secure-person-with-significant-control",
      ceased: false,
    });
    expect(hidden).toMatchObject({ redacted: true, name: undefined });
  });

  it("explains exemptions and statements in words", () => {
    expect(describeExemption("psc_exempt_as_trading_on_uk_regulated_market")).toContain(
      "regulated market",
    );
    expect(describeStatement("no-individual-or-entity-with-signficant-control")).toContain(
      "no person or entity",
    );
    expect(describeStatement("brand-new-code")).toContain("brand-new-code");
  });
});

describe("Companies House people: fetching", () => {
  const headers = { authorization: "Basic x" };

  it("fetches officers with record-level provenance and caches them as personal data", async () => {
    const f = fakeFetch({
      [`${CH}/company/00445790/officers`]: {
        body: fixtureText("companies_house/officers-tesco.json"),
      },
    });
    const ctx = makeCtx(f);
    const first = await fetchOfficers(ctx, headers, "00445790");
    expect(first!.officers).toHaveLength(6);
    expect(first!.activeCount).toBe(3);
    expect(first!.truncated).toBe(false);
    expect(first!.provenance).toMatchObject({
      source: "companies_house",
      fromCache: false,
      licence: expect.stringContaining("Open Government"),
    });
    const second = await fetchOfficers(ctx, headers, "00445790");
    expect(second!.provenance.fromCache).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  it("pages through long officer lists and flags what it could not fetch", async () => {
    const mk = (n: number, start: number) => ({
      items: Array.from({ length: n }, (_, i) => ({
        name: `P${start + i}, X`,
        officer_role: "director",
      })),
      total_results: 650,
      active_count: 650,
      resigned_count: 0,
    });
    const f = fakeFetch({
      [`${CH}/company/00000001/officers`]: Array.from({ length: 6 }, () => ({
        body: JSON.stringify(mk(100, 0)),
      })),
    });
    const r = await fetchOfficers(makeCtx(f), headers, "00000001");
    expect(f.calls).toHaveLength(5); // hard stop at 5 pages
    expect(r!.officers).toHaveLength(500);
    expect(r!.total).toBe(650);
    expect(r!.truncated).toBe(true);
  });

  it("returns undefined for an unknown company and rejects malformed bodies without caching them", async () => {
    const notFound = fakeFetch({ [`${CH}/company/99999999/officers`]: { status: 404, body: "" } });
    expect(await fetchOfficers(makeCtx(notFound), headers, "99999999")).toBeUndefined();

    const bad = fakeFetch({
      [`${CH}/company/00000002/officers`]: { body: JSON.stringify({ oops: true }) },
    });
    const ctx = makeCtx(bad);
    await expect(fetchOfficers(ctx, headers, "00000002")).rejects.toMatchObject({
      kind: "bad_response",
    });
    await expect(fetchOfficers(ctx, headers, "00000002")).rejects.toMatchObject({
      kind: "bad_response",
    });
    expect(bad.calls).toHaveLength(2);
  });

  it("explains why a company has no controllers: exemption, then statements, then nothing", async () => {
    const exempt = fakeFetch({
      [`${CH}/company/00445790/persons-with-significant-control`]: {
        body: fixtureText("companies_house/tesco-psc.json"),
      },
      [`${CH}/company/00445790/exemptions`]: {
        body: fixtureText("companies_house/tesco-exemptions.json"),
      },
    });
    const a = await fetchControllers(makeCtx(exempt), headers, "00445790");
    expect(a!.controllers).toEqual([]);
    expect(a!.exemption).toMatchObject({ code: "psc_exempt_as_trading_on_uk_regulated_market" });

    const stated = fakeFetch({
      [`${CH}/company/00000003/persons-with-significant-control-statements`]: {
        body: fixtureText("companies_house/psc-statements-none.json"),
      },
      [`${CH}/company/00000003/persons-with-significant-control`]: {
        body: JSON.stringify({ items: [], total_results: 0, active_count: 0, ceased_count: 0 }),
      },
    });
    const b = await fetchControllers(makeCtx(stated), headers, "00000003");
    expect(b!.exemption).toBeUndefined();
    expect(b!.statements[0]!.description).toContain("no person or entity");

    const nothing = fakeFetch({
      [`${CH}/company/00000004/persons-with-significant-control-statements`]: {
        status: 404,
        body: "",
      },
      [`${CH}/company/00000004/persons-with-significant-control`]: {
        body: JSON.stringify({ items: [], total_results: 0, active_count: 0, ceased_count: 0 }),
      },
    });
    const c = await fetchControllers(makeCtx(nothing), headers, "00000004");
    expect(c).toMatchObject({ controllers: [], statements: [] });
    expect(c!.exemption).toBeUndefined();
  });
});
