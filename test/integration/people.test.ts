import { afterEach, describe, expect, it } from "vitest";
import { defaultRoutes, startHarness, type Harness } from "../harness.js";
import { fixtureText } from "../helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const CH = "https://api.company-information.service.gov.uk";

/** Minimal Companies House profile for an invented company number. */
const profile = (number: string, name: string) => ({
  body: JSON.stringify({
    company_name: name,
    company_number: number,
    company_status: "active",
    type: "ltd",
    date_of_creation: "2010-01-01",
  }),
});
const pscList = (items: unknown[]) => ({
  body: JSON.stringify({
    items,
    total_results: items.length,
    active_count: items.filter((i: any) => !i.ceased).length,
    ceased_count: items.filter((i: any) => i.ceased).length,
  }),
});
const corporatePsc = (name: string, number: string, over: Record<string, unknown> = {}) => ({
  kind: "corporate-entity-person-with-significant-control",
  name,
  ceased: false,
  natures_of_control: ["ownership-of-shares-75-to-100-percent"],
  identification: {
    registration_number: number,
    place_registered: "Companies House",
    legal_authority: "United Kingdom (England)",
  },
  ...over,
});

/** Routes for an invented UK company: its profile, no officers, and the given PSC items. */
function company(
  routes: ReturnType<typeof defaultRoutes>,
  number: string,
  name: string,
  psc: unknown[],
) {
  routes[`${CH}/company/${number}/persons-with-significant-control-statements`] = {
    status: 404,
    body: "",
  };
  routes[`${CH}/company/${number}/persons-with-significant-control`] = pscList(psc);
  routes[`${CH}/company/${number}`] = profile(number, name);
}

describe("get_officers", () => {
  it("lists current officers, most recently appointed first, with provenance", async () => {
    h = await startHarness();
    const r = await h.call("get_officers", { identifier: "00445790", country: "GB" });
    expect(r.isError).toBe(false);
    const o = r.json.data.officers;
    expect(o.state).toBe("available");
    expect(o.data.officers).toHaveLength(3);
    expect(o.data.officers.every((x: any) => x.active)).toBe(true);
    expect(o.data).toMatchObject({
      matching: 3,
      registryTotal: 6,
      activeCount: 3,
      resignedCount: 3,
    });
    expect(o.data.officers[0]).toMatchObject({
      displayName: expect.any(String),
      role: expect.any(String),
    });
    expect(o.data.provenance).toMatchObject({ source: "companies_house", fromCache: false });
    expect(r.json.meta.entityId).toBe("GB:CH:00445790");
    expect(r.json.disclaimer).toContain("personal data");
    expect(r.json.summary).not.toMatch(/EXAMPLE|SAMPLE|TESTER/); // registry text stays out of the summary
  });

  it("filters by role and active flag, and pages", async () => {
    h = await startHarness();
    const all = await h.call("get_officers", {
      identifier: "00445790",
      country: "GB",
      active_only: false,
    });
    expect(all.json.data.officers.data.officers).toHaveLength(6);
    const secretaries = await h.call("get_officers", {
      identifier: "00445790",
      country: "GB",
      active_only: false,
      role: "secretary",
    });
    expect(
      secretaries.json.data.officers.data.officers.every((x: any) => x.role === "secretary"),
    ).toBe(true);
    const page2 = await h.call("get_officers", {
      identifier: "00445790",
      country: "GB",
      limit: 2,
      offset: 2,
    });
    expect(page2.json.data.officers.data.officers).toHaveLength(1);
    expect(page2.json.meta.page).toEqual({ total: 3, limit: 2, offset: 2 });
  });

  it("says 'not yet supported' for companies outside Companies House, never an empty list", async () => {
    h = await startHarness();
    const r = await h.call("get_officers", { identifier: "IE6388047V" });
    expect(r.json.data.officers.state).toBe("not_yet_supported");
    expect(r.json.data.officers.detail).toContain("Companies House");
  });

  it("says why when Companies House is not configured", async () => {
    h = await startHarness({ env: {} });
    const r = await h.call("get_officers", { identifier: "00445790", country: "GB" });
    expect(r.isError).toBe(false);
    expect(r.json.data.officers).toMatchObject({
      state: "unavailable",
      reason: "requires_credentials",
    });
    expect(r.json.data.officers.detail).toContain("COMPANIES_HOUSE_API_KEY");
  });

  it("reports a registry failure as an error state with a warning", async () => {
    const routes = defaultRoutes();
    routes[`${CH}/company/00445790/officers`] = { status: 500, body: "" };
    h = await startHarness({ routes });
    const r = await h.call("get_officers", { identifier: "00445790", country: "GB" });
    expect(r.json.data.officers.state).toBe("error");
    expect(r.json.warnings.join(" ")).toContain("unavailable");
  });

  it("keeps officers' names out of the audit log", async () => {
    h = await startHarness();
    await h.call("get_officers", { identifier: "00445790", country: "GB" });
    const rows = JSON.stringify(h.rt.storage.listAudit(5));
    expect(rows).toContain("GB_CRN:00445790");
    expect(rows).not.toMatch(/EXAMPLE|SAMPLE|TESTER/);
  });
});

describe("get_ownership", () => {
  it("follows the real Tesco chain up to a listed, PSC-exempt parent", async () => {
    h = await startHarness();
    const r = await h.call("get_ownership", { identifier: "00519500", country: "GB" });
    expect(r.isError).toBe(false);
    const g = r.json.data.ownership.data;
    expect(g.nodes.map((n: any) => n.nodeId)).toEqual([
      "GB:CH:00519500",
      "GB:CH:00243011",
      "GB:CH:00445790",
    ]);
    expect(g.edges).toHaveLength(2);
    expect(g.edges[0]).toMatchObject({
      from: "GB:CH:00243011",
      to: "GB:CH:00519500",
      active: true,
      natures: { sharesMin: 75, sharesMax: 100, appointsDirectors: true },
    });
    expect(g.ultimateOwners).toEqual([
      expect.objectContaining({ nodeId: "GB:CH:00445790", terminal: "exempt" }),
    ]);
    const top = g.nodes.find((n: any) => n.nodeId === "GB:CH:00445790");
    expect(top.terminalDetail).toContain("regulated market");
    expect(g).toMatchObject({ depthReached: 2, companiesExpanded: 3, truncated: false, cutBy: [] });
    expect(g.provenance.length).toBe(3);
    expect(r.json.disclaimer).toContain("personal data");
  });

  it("stops at the requested depth and says so", async () => {
    h = await startHarness();
    const r = await h.call("get_ownership", { identifier: "00519500", country: "GB", depth: 1 });
    const g = r.json.data.ownership.data;
    expect(g.nodes.map((n: any) => n.nodeId)).toEqual(["GB:CH:00519500", "GB:CH:00243011"]);
    expect(g.nodes[1]).toMatchObject({ terminal: "depth_limit" });
    expect(g).toMatchObject({ truncated: true, cutBy: ["depth"] });
    expect(r.json.warnings.join(" ")).toContain("terminal reason");
  });

  it("ends a chain at a controller registered outside Companies House", async () => {
    h = await startHarness();
    const r = await h.call("get_ownership", { identifier: "01074897", country: "GB" });
    const g = r.json.data.ownership.data;
    const foreign = g.nodes.find((n: any) => n.terminal === "not_followable");
    expect(foreign).toMatchObject({ kind: "entity", name: "Banco Central De Cuba" });
    expect(foreign.terminalDetail).toContain("outside Companies House");
    expect(g.ultimateOwners.map((u: any) => u.nodeId)).toContain(foreign.nodeId);
  });

  it("returns individuals, honours include_ceased and include_persons, and hashes person node ids", async () => {
    const routes = defaultRoutes();
    company(
      routes,
      "10000001",
      "ACME HOLDINGS LIMITED",
      JSON.parse(fixtureText("companies_house/psc-individual.json")).items,
    );
    h = await startHarness({ routes });

    const active = await h.call("get_ownership", { identifier: "10000001", scheme: "GB_CRN" });
    const g = active.json.data.ownership.data;
    const persons = g.nodes.filter((n: any) => n.kind === "person");
    expect(persons).toHaveLength(1);
    expect(persons[0]).toMatchObject({ name: "Jane Alice Example", terminal: "natural_person" });
    expect(persons[0].nodeId).toMatch(/^person:[0-9a-f]{12}$/); // no personal data in ids

    const withCeased = await h.call("get_ownership", {
      identifier: "10000001",
      scheme: "GB_CRN",
      include_ceased: true,
    });
    expect(
      withCeased.json.data.ownership.data.nodes.filter((n: any) => n.kind === "person"),
    ).toHaveLength(2);

    const hidden = await h.call("get_ownership", {
      identifier: "10000001",
      scheme: "GB_CRN",
      include_persons: false,
    });
    expect(
      hidden.json.data.ownership.data.nodes.filter((n: any) => n.kind === "person"),
    ).toHaveLength(0);
    expect(hidden.json.data.ownership.data.personsOmitted).toBe(1);
    expect(hidden.json.warnings.join(" ")).toContain("omitted");
  });

  it("explains a company with no controllers by its statement", async () => {
    const routes = defaultRoutes();
    routes[`${CH}/company/10000002/persons-with-significant-control-statements`] = {
      body: fixtureText("companies_house/psc-statements-none.json"),
    };
    routes[`${CH}/company/10000002/persons-with-significant-control`] = pscList([]);
    routes[`${CH}/company/10000002`] = profile("10000002", "NOBODY LIMITED");
    h = await startHarness({ routes });
    const r = await h.call("get_ownership", { identifier: "10000002", scheme: "GB_CRN" });
    const root = r.json.data.ownership.data.nodes[0];
    expect(root).toMatchObject({ terminal: "statement" });
    expect(root.terminalDetail).toContain("no person or entity");
  });

  it("survives circular ownership", async () => {
    const routes = defaultRoutes();
    company(routes, "10000003", "LOOP A LIMITED", [corporatePsc("Loop B Limited", "10000004")]);
    company(routes, "10000004", "LOOP B LIMITED", [corporatePsc("Loop A Limited", "10000003")]);
    h = await startHarness({ routes });
    const r = await h.call("get_ownership", {
      identifier: "10000003",
      scheme: "GB_CRN",
      depth: 10,
    });
    const g = r.json.data.ownership.data;
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(2);
  });

  it("stops at the request budget and reports it as lossy", async () => {
    const routes = defaultRoutes();
    for (let i = 0; i < 40; i++) {
      const n = String(20000000 + i);
      const next = String(20000000 + i + 1);
      company(routes, n, `CHAIN ${i} LIMITED`, [corporatePsc(`Chain ${i + 1} Limited`, next)]);
    }
    h = await startHarness({ routes });
    const r = await h.call("get_ownership", {
      identifier: "20000000",
      scheme: "GB_CRN",
      depth: 10,
    });
    const g = r.json.data.ownership.data;
    expect(g.depthReached).toBe(10);
    expect(g.cutBy).toContain("depth");
    expect(g.companiesExpanded).toBeLessThanOrEqual(30);
  });

  it("reports a registry failure partway up the chain without losing the rest", async () => {
    const routes = defaultRoutes();
    routes[`${CH}/company/00243011/persons-with-significant-control`] = { status: 500, body: "" };
    h = await startHarness({ routes });
    const r = await h.call("get_ownership", { identifier: "00519500", country: "GB" });
    const g = r.json.data.ownership.data;
    expect(g.nodes.find((n: any) => n.nodeId === "GB:CH:00243011")).toMatchObject({
      terminal: "error",
    });
    expect(g.cutBy).toContain("error");
    expect(r.json.warnings.join(" ")).toContain("unavailable");
  });

  it("is 'not yet supported' outside Companies House and 'unavailable' without a key", async () => {
    h = await startHarness();
    const ie = await h.call("get_ownership", { identifier: "IE6388047V" });
    expect(ie.json.data.ownership.state).toBe("not_yet_supported");
    await h.close();
    h = await startHarness({ env: {} });
    const nokey = await h.call("get_ownership", { identifier: "00445790", country: "GB" });
    expect(nokey.json.data.ownership).toMatchObject({
      state: "unavailable",
      reason: "requires_credentials",
    });
  });

  it("flags protected controllers, whose identity the registry withholds", async () => {
    const routes = defaultRoutes();
    company(routes, "10000005", "SECRET OWNER LIMITED", [
      {
        kind: "super-secure-person-with-significant-control",
        ceased: false,
        natures_of_control: ["ownership-of-shares-25-to-50-percent"],
      },
    ]);
    h = await startHarness({ routes });
    const r = await h.call("get_ownership", { identifier: "10000005", scheme: "GB_CRN" });
    expect(r.json.data.ownership.data.nodes.some((n: any) => n.terminal === "redacted")).toBe(true);
  });
});

describe("screen_sanctions with officers and owners", () => {
  /** A company whose owner is on the OFAC list (by name), whose director is on the UK list, and
   * whose other controller carries Havin Bank's registration number under another name. */
  function sanctionedGroup() {
    const routes = defaultRoutes();
    // The officers URL must be registered before the company URL it extends (prefix matching).
    routes[`${CH}/company/10000010/officers`] = {
      body: JSON.stringify({
        items: [
          { name: "ABBAS, Abu", officer_role: "director", appointed_on: "2020-01-01" },
          { name: "TESTER, Maria", officer_role: "director", appointed_on: "2019-01-01" },
          { name: "OLD, Resigned", officer_role: "director", resigned_on: "2018-01-01" },
        ],
        total_results: 3,
        active_count: 2,
        resigned_count: 1,
      }),
    };
    company(routes, "10000010", "GROUP HOLDINGS LIMITED", [
      corporatePsc("HAVIN BANK LIMITED", "55555555"),
      corporatePsc("Innocent Parent Limited", "01074897"),
    ]);
    company(routes, "55555555", "HAVIN BANK LIMITED", []);
    company(routes, "01074897", "INNOCENT PARENT LIMITED", []);
    return routes;
  }

  it("screens owners and officers and reports the worst result overall", async () => {
    h = await startHarness({ routes: sanctionedGroup() });
    const r = await h.call("screen_sanctions", {
      identifier: "10000010",
      scheme: "GB_CRN",
      include: ["officers", "owners"],
    });
    expect(r.isError).toBe(false);
    expect(r.json.data.screening.result).toBe("no_match"); // the company itself is clean
    expect(r.json.data.overall).toBe("match");
    const rel = r.json.data.related;
    const byName = Object.fromEntries(rel.hits.map((x: any) => [x.name, x]));
    expect(byName["HAVIN BANK LIMITED"]).toMatchObject({ result: "match" });
    expect(byName["HAVIN BANK LIMITED"].description).toContain("owner");
    expect(byName["Abu ABBAS"]).toMatchObject({ result: "match" }); // "ABBAS, Abu" is reordered
    expect(byName["Abu ABBAS"].description).toContain("officer");
    // The registration number alone is enough, whatever the registered name says.
    expect(byName["Innocent Parent Limited"].hits[0].basis).toBe("exact_identifier");
    // Resigned officers are not screened; clean ones are listed as screened, not as hits.
    expect(rel.screened.officers).toEqual(expect.arrayContaining(["Abu ABBAS", "Maria TESTER"]));
    expect(rel.screened.officers).not.toContain("Resigned OLD");
    expect(rel.hits.some((x: any) => x.name === "Maria TESTER")).toBe(false);
    expect(r.json.disclaimer).toContain("personal data");
    expect(r.json.warnings.join(" ")).toContain("Individuals are matched by name only");
    expect(r.json.summary).not.toMatch(/HAVIN|ABBAS/);
  });

  it("is clean only when everyone requested was screened and nothing matched", async () => {
    h = await startHarness();
    const r = await h.call("screen_sanctions", {
      identifier: "00519500",
      country: "GB",
      include: ["owners"],
    });
    // Tesco Stores <- Tesco Holdings <- Tesco PLC (exempt): all screened, nothing listed.
    expect(r.json.data.related.owners).toMatchObject({
      requested: true,
      state: "screened",
      incomplete: false,
    });
    expect(r.json.data.related.owners.subjects).toBe(2);
    expect(r.json.data.overall).toBe("no_match");
  });

  it("is incomplete when the requested officers cannot be retrieved", async () => {
    const routes = defaultRoutes();
    routes[`${CH}/company/00445790/officers`] = { status: 500, body: "" };
    h = await startHarness({ routes });
    const r = await h.call("screen_sanctions", {
      identifier: "00445790",
      country: "GB",
      include: ["officers"],
    });
    expect(r.json.data.related.officers).toMatchObject({ state: "error", incomplete: true });
    expect(r.json.data.overall).toBe("incomplete");
    expect(r.json.warnings.join(" ")).toContain("NOT a clear result");
  });

  it("is incomplete for a company outside Companies House: it can not claim to have screened its officers", async () => {
    h = await startHarness();
    const r = await h.call("screen_sanctions", {
      identifier: "IE6388047V",
      include: ["officers", "owners"],
    });
    expect(r.json.data.related.officers.state).toBe("not_yet_supported");
    expect(r.json.data.related.owners.state).toBe("not_yet_supported");
    expect(r.json.data.overall).toBe("incomplete");
  });

  it("is incomplete when a controller's identity is withheld", async () => {
    const routes = defaultRoutes();
    company(routes, "10000011", "HIDDEN LIMITED", [
      {
        kind: "super-secure-person-with-significant-control",
        ceased: false,
        natures_of_control: ["ownership-of-shares-25-to-50-percent"],
      },
    ]);
    h = await startHarness({ routes });
    const r = await h.call("screen_sanctions", {
      identifier: "10000011",
      scheme: "GB_CRN",
      include: ["owners"],
    });
    expect(r.json.data.related.owners.notScreenable).toBe(1);
    expect(r.json.data.overall).toBe("incomplete");
    expect(r.json.warnings.join(" ")).toContain("protected identities");
  });

  it("is incomplete when the ownership chain was lost to an error", async () => {
    const routes = defaultRoutes();
    routes[`${CH}/company/00243011/persons-with-significant-control`] = { status: 500, body: "" };
    h = await startHarness({ routes });
    const r = await h.call("screen_sanctions", {
      identifier: "00519500",
      country: "GB",
      include: ["owners"],
    });
    expect(r.json.data.related.owners.incomplete).toBe(true);
    expect(r.json.data.overall).toBe("incomplete");
  });

  it("needs an entity for include, not a name", async () => {
    h = await startHarness();
    const r = await h.call("screen_sanctions", { name: "Acme Ltd", include: ["officers"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("needs an entity");
  });

  it("does not touch the officers or ownership registries unless asked", async () => {
    h = await startHarness();
    await h.call("screen_sanctions", { identifier: "00445790", country: "GB" });
    expect(h.fetch.calls.some((c) => /officers|persons-with-significant-control/.test(c.url))).toBe(
      false,
    );
  });
});
