import { afterEach, describe, expect, it } from "vitest";
import { fixtureText } from "../helpers.js";
import { defaultRoutes, startHarness, type Harness } from "../harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const EQUINOR_LEI = "OW6OFBNCKXC4US5C7523";
const NOKIA_LEI = "549300A0JPRWG1KI7U06";

describe("Norway through the tools", () => {
  it("builds an Equinor profile from the register and GLEIF, with a Norwegian entity id", async () => {
    h = await startHarness({ env: {} });
    const r = await h.call("get_entity", { identifier: "923 609 016", scheme: "NO_ORGNR" });
    expect(r.isError).toBe(false);
    const p = r.json.data;
    expect(p.entityId).toBe("NO:BR:923609016");
    expect(p.aliases).toEqual([`ID:LEI:${EQUINOR_LEI}`]);
    expect(p.identifiers.map((i: any) => `${i.scheme}=${i.value}`).sort()).toEqual([
      `LEI=${EQUINOR_LEI}`,
      "NO_ORGNR=923609016",
    ]);
    expect(p.names[0].name).toBe("EQUINOR ASA");
    expect(p.names[0].provenance.map((x: any) => x.source).sort()).toEqual(["brreg_no", "gleif"]);
    expect(p.status.value).toMatchObject({ normalized: "active", group: "operating" });
    expect(p.legalForm.value.normalized).toBe("public_company");
    expect(p.legalForm.value.code).toBe("IQGE"); // ISO 20275 code comes from GLEIF
    expect(p.conflicts).toEqual([]);
    expect(r.json.meta.sourcesQueried.sort()).toEqual(["brreg_no", "gleif"]);
  });

  it("reaches the same entity from its LEI and from the Norwegian VAT form", async () => {
    h = await startHarness({ env: {} });
    const viaLei = await h.call("get_entity", { identifier: EQUINOR_LEI });
    expect(viaLei.json.data.entityId).toBe("NO:BR:923609016");
    const viaVat = await h.call("get_entity", { identifier: "NO923609016MVA" });
    expect(viaVat.json.data.entityId).toBe("NO:BR:923609016");
    const viaId = await h.call("get_entity", { entity_id: "NO:BR:923609016" });
    expect(viaId.json.data.entityId).toBe("NO:BR:923609016");
  });

  it("resolves a bare number only when told the country", async () => {
    h = await startHarness({ env: {} });
    const bad = await h.call("get_entity", { identifier: "923609016" });
    expect(bad.isError).toBe(true);
    const ok = await h.call("get_entity", { identifier: "923609016", country: "NO" });
    expect(ok.json.data.entityId).toBe("NO:BR:923609016");
    const wrong = await h.call("get_entity", { identifier: "923609017", scheme: "NO_ORGNR" });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("check digit");
  });

  it("searches Norway by name and merges the register hit with GLEIF's record of the same company", async () => {
    h = await startHarness({ env: {} });
    const r = await h.call("search_entities", { query: "Equinor ASA", country: "NO" });
    const first = r.json.data.candidates[0];
    expect(first).toMatchObject({
      entityId: "NO:BR:923609016",
      name: "EQUINOR ASA",
      jurisdiction: "NO",
    });
    expect(first.sources).toContain("brreg_no");
    expect(first.match.band).toBe("high");
    const exact = await h.call("search_entities", { query: "923609016", country: "NO" });
    expect(exact.json.data.candidates[0]).toMatchObject({
      entityId: "NO:BR:923609016",
      match: { band: "certain" },
    });
  });

  it("lists the board, CEO and auditor, with roles normalised and the register's wording kept", async () => {
    h = await startHarness({ env: {} });
    const r = await h.call("get_officers", { identifier: "923609016", country: "NO", limit: 100 });
    const o = r.json.data.officers;
    expect(o.state).toBe("available");
    expect(o.data.registryTotal).toBe(15);
    expect(o.data.matching).toBe(13); // two roles are not current
    const roles = o.data.officers.map((x: any) => x.role);
    expect(roles).toEqual(
      expect.arrayContaining(["ceo", "chair", "board_member", "deputy", "auditor"]),
    );
    expect(o.data.officers.find((x: any) => x.role === "ceo").sourceRole).toBe("DAGL Daglig leder");
    expect(o.data.provenance).toMatchObject({
      source: "brreg_no",
      licence: expect.stringContaining("NLOD"),
    });
    expect(r.json.disclaimer).toContain("personal data");

    const auditors = await h.call("get_officers", {
      identifier: "923609016",
      country: "NO",
      role: "auditor",
    });
    expect(auditors.json.data.officers.data.officers).toEqual([
      expect.objectContaining({ kind: "corporate", name: "ERNST & YOUNG AS" }),
    ]);

    const all = await h.call("get_officers", {
      identifier: "923609016",
      country: "NO",
      active_only: false,
      limit: 100,
    });
    expect(all.json.data.officers.data.officers.some((x: any) => x.deceased)).toBe(true);
  });

  it("says Norway does not publish beneficial owners, instead of 'not yet supported'", async () => {
    h = await startHarness({ env: {} });
    const r = await h.call("get_ownership", { identifier: "923609016", country: "NO" });
    expect(r.json.data.ownership).toMatchObject({
      state: "unavailable",
      reason: "restricted_access",
    });
    expect(r.json.data.ownership.detail).toContain("beneficial owners");
  });

  it("reports a bankrupt company as insolvent (distressed)", async () => {
    h = await startHarness({ env: {} });
    const r = await h.call("get_entity", { identifier: "935567645", country: "NO" });
    expect(r.json.data.status.value).toMatchObject({
      normalized: "insolvent",
      group: "distressed",
    });
    expect(r.json.data.legalForm.value.normalized).toBe("limited_company");
  });

  it("screens a Norwegian company's officers and says owners could not be screened", async () => {
    h = await startHarness({ env: {} });
    const r = await h.call("screen_sanctions", {
      identifier: "923609016",
      country: "NO",
      include: ["officers", "owners"],
    });
    expect(r.isError).toBe(false);
    const rel = r.json.data.related;
    expect(rel.officers).toMatchObject({
      requested: true,
      state: "screened",
      subjects: 13,
      incomplete: false,
    });
    expect(rel.owners).toMatchObject({ state: "unavailable", incomplete: true });
    expect(r.json.data.overall).toBe("incomplete"); // never "clear" with owners unscreened
    expect(r.json.warnings.join(" ")).toContain("NOT a clear result");
  });

  it("works without any key: the Nordic registers need none", async () => {
    h = await startHarness({ env: {} });
    const cov = await h.call("check_coverage", { country: "NO" });
    const no = cov.json.data.adapters.find((a: any) => a.id === "no");
    expect(no).toMatchObject({ enabled: true, requiredEnv: [] });
  });
});

describe("Finland through the tools", () => {
  it("builds a Nokia profile from PRH, GLEIF and VIES, linking the VAT number to the business ID", async () => {
    h = await startHarness({ env: {} });
    const r = await h.call("get_entity", { identifier: "0112038-9" });
    expect(r.isError).toBe(false);
    const p = r.json.data;
    expect(p.entityId).toBe("FI:PRH:0112038-9");
    expect(p.identifiers.map((i: any) => `${i.scheme}=${i.value}`).sort()).toEqual([
      "FI_YTUNNUS=0112038-9",
      `LEI=${NOKIA_LEI}`,
      "VAT=FI01120389",
    ]);
    expect(p.identifiers.find((i: any) => i.scheme === "VAT").validated).toBe(true); // VIES confirmed it
    expect(p.names[0].name).toBe("Nokia Oyj");
    expect(p.status.value).toMatchObject({
      normalized: "active",
      sourceText: "trade register: Registered",
    });
    expect(p.legalForm.value.normalized).toBe("public_company");
    expect(p.registeredAddress.value.postalCode).toBe("02610");
    expect(r.json.meta.sourcesQueried.sort()).toEqual(["gleif", "prh_fi", "vies"]);
  });

  it("reaches the same entity from the Finnish VAT number and from the LEI", async () => {
    h = await startHarness({ env: {} });
    const viaVat = await h.call("get_entity", { identifier: "FI01120389" });
    expect(viaVat.json.data.entityId).toBe("FI:PRH:0112038-9");
    const viaLei = await h.call("get_entity", { identifier: NOKIA_LEI });
    expect(viaLei.json.data.entityId).toBe("FI:PRH:0112038-9");
    const viaCountry = await h.call("get_entity", { identifier: "01120389", country: "FI" });
    expect(viaCountry.json.data.entityId).toBe("FI:PRH:0112038-9");
  });

  it("distinguishes ceased, bankrupt, liquidating and housing companies", async () => {
    h = await startHarness({ env: {} });
    const cases: [string, string, string][] = [
      ["0100002-9", "dissolved", "ended"],
      ["0104057-3", "insolvent", "distressed"],
      ["0100723-9", "in_liquidation", "distressed"],
      ["0100024-8", "active", "operating"],
    ];
    for (const [id, status, group] of cases) {
      const r = await h.call("get_entity", { identifier: id });
      expect(r.json.data.status.value, id).toMatchObject({ normalized: status, group });
    }
  });

  it("explains why Finland has no officers or owners instead of returning empty lists", async () => {
    h = await startHarness({ env: {} });
    const officers = await h.call("get_officers", { identifier: "0112038-9" });
    expect(officers.json.data.officers).toMatchObject({
      state: "unavailable",
      reason: "not_published_by_source",
    });
    const owners = await h.call("get_ownership", { identifier: "0112038-9" });
    expect(owners.json.data.ownership).toMatchObject({
      state: "unavailable",
      reason: "restricted_access",
    });
  });

  it("rejects a Finnish ID with a bad check digit before any request", async () => {
    h = await startHarness({ env: {} });
    const before = h.fetch.calls.length;
    const r = await h.call("get_entity", { identifier: "0112038-8", scheme: "FI_YTUNNUS" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("business ID");
    expect(h.fetch.calls.length).toBe(before);
  });

  it("returns 'no entity' for a valid but unknown Finnish ID", async () => {
    h = await startHarness({ env: {} });
    const r = await h.call("get_entity", { identifier: "0000001-9", scheme: "FI_YTUNNUS" });
    // 0000001-9 has a valid check digit but is not in the register.
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No entity found");
  });
});

const BR = "https://data.brreg.no/enhetsregisteret/api";
const PRH = "https://avoindata.prh.fi/opendata-ytj-api/v3/companies";

describe("review regressions: what each country's profile says it can provide", () => {
  it("states per company whether officers and ownership can be had, and why not", async () => {
    h = await startHarness();
    const fam = async (identifier: string, country?: string) =>
      (await h!.call("get_entity", { identifier, country })).json.data.coverage.families;

    const uk = await fam("00445790", "GB");
    expect(uk.officers.state).toBe("available");
    expect(uk.ownership.state).toBe("available");

    const no = await fam("923609016", "NO");
    expect(no.officers).toMatchObject({ state: "available", note: "Call get_officers" });
    expect(no.ownership.state).toBe("unavailable");
    expect(no.ownership.note).toContain("beneficial owners");

    const fi = await fam("0112038-9");
    expect(fi.officers.state).toBe("unavailable");
    expect(fi.officers.note).toContain("board members");
    expect(fi.ownership.state).toBe("unavailable");
  });

  it("lists the officer and ownership countries from the enabled adapters", async () => {
    h = await startHarness();
    const full = await h.call("check_coverage", {});
    expect(full.json.data.familiesSupported).toEqual(
      expect.arrayContaining(["officers (GB, NO: get_officers)", "ownership (GB: get_ownership)"]),
    );
    await h.close();
    h = await startHarness({ env: {} });
    const keyless = await h.call("check_coverage", {});
    expect(keyless.json.data.familiesSupported).toEqual(
      expect.arrayContaining([
        "officers (NO: get_officers)",
        "ownership (none enabled: get_ownership)",
      ]),
    );
  });
});

describe("review regressions: name search stays in the requested country", () => {
  it("asks only that country's register (plus GLEIF), not every register", async () => {
    h = await startHarness();
    const no = await h.call("search_entities", { query: "Equinor ASA", country: "NO" });
    expect(no.json.meta.sourcesQueried.sort()).toEqual(["brreg_no", "gleif"]);
    const fi = await h.call("search_entities", { query: "Nokia", country: "FI" });
    expect(fi.json.meta.sourcesQueried.sort()).toEqual(["gleif", "prh_fi"]);
    const before = h.fetch.calls.length;
    const de = await h.call("search_entities", { query: "Siemens", country: "DE" });
    expect(de.json.meta.sourcesQueried).toEqual(["gleif"]);
    const urls = h.fetch.calls.slice(before).map((c) => c.url);
    expect(urls.some((u) => /brreg|prh\.fi|company-information/.test(u))).toBe(false);
    // Without a country every register is asked.
    const any = await h.call("search_entities", { query: "Equinor ASA" });
    expect(any.json.meta.sourcesQueried).toEqual(
      expect.arrayContaining(["brreg_no", "prh_fi", "companies_house", "gleif"]),
    );
  });

  it("hints at the country for a bare number", async () => {
    h = await startHarness();
    const r = await h.call("search_entities", { query: "923609016" });
    expect(r.json.warnings.join(" ")).toContain("country=NO");
  });
});

describe("review regressions: Finnish companies that have ceased", () => {
  it("still have a legal name, are found by name search, and show when they ended", async () => {
    const ceased = JSON.parse(fixtureText("prh_fi/0100002-9.json")).companies[0];
    h = await startHarness({
      routes: {
        [`${PRH}?name=Artj`]: { body: JSON.stringify({ totalResults: 1, companies: [ceased] }) },
        ...defaultRoutes(),
      },
    });
    const found = await h.call("search_entities", { query: "Artjärven Metalli", country: "FI" });
    expect(found.json.data.candidates[0]).toMatchObject({
      entityId: "FI:PRH:0100002-9",
      name: "Artjärven Metalli Oy",
      status: { normalized: "dissolved" },
    });
    const profile = (await h.call("get_entity", { identifier: "0100002-9" })).json.data;
    expect(profile.names[0]).toMatchObject({ name: "Artjärven Metalli Oy", kind: "legal" });
  });
});

describe("review regressions: failures are never read as 'nothing there'", () => {
  for (const status of [500, 429]) {
    it(`falls back to the other sources, with a warning, when the register answers ${status}`, async () => {
      h = await startHarness({
        env: {},
        // Overrides come after the defaults: an existing key keeps its place in the match order.
        routes: {
          ...defaultRoutes(),
          [`${BR}/enheter/923609016`]: { status, body: "", headers: { "retry-after": "1" } },
        },
      });
      const r = await h.call("get_entity", { identifier: "923609016", country: "NO" });
      expect(r.isError).toBe(false);
      expect(r.json.data.entityId).toBe("NO:BR:923609016");
      expect(r.json.data.names[0].provenance.map((p: any) => p.source)).toEqual(["gleif"]);
      expect(r.json.warnings.join(" ")).toContain("brreg_no");
    });
  }

  it("reports a roles outage as an error and refuses to call the screen clear", async () => {
    h = await startHarness({
      env: {},
      routes: {
        ...defaultRoutes(),
        [`${BR}/enheter/923609016/roller`]: { status: 500, body: "" },
      },
    });
    const o = await h.call("get_officers", { identifier: "923609016", country: "NO" });
    expect(o.json.data.officers.state).toBe("error");
    const s = await h.call("screen_sanctions", {
      identifier: "923609016",
      country: "NO",
      include: ["officers"],
    });
    expect(s.json.data.related.officers).toMatchObject({ state: "error", incomplete: true });
    expect(s.json.data.overall).toBe("incomplete");
  });

  it("flags an officer list in which a role could not be read, and does not screen it as complete", async () => {
    const roles = JSON.parse(fixtureText("brreg_no/equinor-roller.json"));
    roles.rollegrupper[0].roller.push({ type: { kode: "NEST" } }); // no person, no unit
    h = await startHarness({
      env: {},
      routes: {
        ...defaultRoutes(),
        [`${BR}/enheter/923609016/roller`]: { body: JSON.stringify(roles) },
      },
    });
    const o = await h.call("get_officers", { identifier: "923609016", country: "NO", limit: 100 });
    expect(o.json.data.officers.data.truncated).toBe(true);
    expect(o.json.data.officers.data.registryTotal).toBe(16);
    expect(o.json.warnings.join(" ")).toContain("could be read");
    const s = await h.call("screen_sanctions", {
      identifier: "923609016",
      country: "NO",
      include: ["officers"],
    });
    expect(s.json.data.related.officers.incomplete).toBe(true);
    expect(s.json.data.overall).toBe("incomplete");
  });
});

describe("review regressions: registration numbers on the lists", () => {
  it("screens a Norwegian or Finnish company by name and LEI/VAT, not by bare registry number", async () => {
    h = await startHarness({ env: {} });
    const no = await h.call("screen_sanctions", { identifier: "923609016", country: "NO" });
    expect(no.json.data.screened.identifiers).toEqual([EQUINOR_LEI]);
    const fi = await h.call("screen_sanctions", { identifier: "0112038-9" });
    expect(fi.json.data.screened.identifiers.sort()).toEqual([NOKIA_LEI, "FI01120389"].sort());
  });
});

describe("the Nordic adapters in the catalogue", () => {
  it("can be switched off with EIM_ADAPTERS, and then say so", async () => {
    h = await startHarness({ env: { EIM_ADAPTERS: "gleif,vies" }, routes: defaultRoutes() });
    const r = await h.call("get_officers", { identifier: EQUINOR_LEI });
    expect(r.json.data.officers).toMatchObject({ state: "unavailable", reason: "not_enabled" });
    expect(r.json.data.officers.detail).toContain("allow-list");
  });
});
