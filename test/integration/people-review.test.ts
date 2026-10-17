// One test per defect found in the third xhigh review (officers / ownership / related screening).
import { afterEach, describe, expect, it } from "vitest";
import { currentPscExemption, parseNatures } from "../../src/adapters/companies-house/people.js";
import { defaultRoutes, startHarness, type Harness } from "../harness.js";
import { fakeFetch, fixtureText, type FakeRoute } from "../helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const CH = "https://api.company-information.service.gov.uk";
type Routes = Record<string, FakeRoute | FakeRoute[]>;

const profile = (number: string, name: string): FakeRoute => ({
  body: JSON.stringify({
    company_name: name,
    company_number: number,
    company_status: "active",
    type: "ltd",
    date_of_creation: "2010-01-01",
  }),
});
const pscList = (items: unknown[]): FakeRoute => ({
  body: JSON.stringify({
    items,
    total_results: items.length,
    active_count: items.filter((i: any) => !i.ceased).length,
    ceased_count: items.filter((i: any) => i.ceased).length,
  }),
});
const corporate = (
  name: string,
  number: string,
  natures = ["ownership-of-shares-75-to-100-percent"],
) => ({
  kind: "corporate-entity-person-with-significant-control",
  name,
  ceased: false,
  natures_of_control: natures,
  identification: {
    registration_number: number,
    place_registered: "Companies House",
    legal_authority: "United Kingdom (England)",
  },
});
const individual = (forename: string, surname: string, natures: string[], extra = {}) => ({
  kind: "individual-person-with-significant-control",
  name: `Mr ${forename} ${surname}`,
  name_elements: { title: "Mr", forename, surname },
  ceased: false,
  nationality: "British",
  country_of_residence: "England",
  date_of_birth: { month: 3, year: 1970 },
  natures_of_control: natures,
  ...extra,
});
/** Adds a company: sub-resources first, then the plain URL they share a prefix with. */
function company(routes: Routes, number: string, name: string, psc: unknown[]): void {
  routes[`${CH}/company/${number}/persons-with-significant-control-statements`] = {
    status: 404,
    body: "",
  };
  routes[`${CH}/company/${number}/persons-with-significant-control`] = pscList(psc);
  routes[`${CH}/company/${number}`] = profile(number, name);
}

describe("review: a failing related-parties lookup can not crash the server", () => {
  it("surfaces an unexpected error as a tool error while the lists are still loading", async () => {
    const routes = defaultRoutes();
    // A malformed officer entry makes the mapper throw a TypeError (not a SourceError).
    routes[`${CH}/company/00445790/officers`] = {
      body: JSON.stringify({ items: [null], total_results: 1, active_count: 1, resigned_count: 0 }),
    };
    const inner = fakeFetch(routes);
    // Slow only the list downloads, so the rejection happens while they are still in flight.
    const slow = Object.assign(
      async (url: string, init?: RequestInit) => {
        if (/sanctionslist|webgate|treasury|amazonaws/.test(url)) {
          await new Promise((r) => setTimeout(r, 60));
        }
        return inner(url, init);
      },
      { calls: inner.calls },
    );
    h = await startHarness({ fetchImpl: slow });
    const r = await h.call("screen_sanctions", {
      identifier: "00445790",
      country: "GB",
      include: ["officers"],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Internal error");
    // Reaching here at all means the process survived: an unhandled rejection fails the test run.
    await new Promise((res) => setTimeout(res, 100));
  });
});

describe("review: PSC exemptions must be in force", () => {
  const body = (items: { exempt_from?: string; exempt_to?: string }[]) => ({
    exemptions: { psc_exempt_as_trading_on_uk_regulated_market: { items } },
  });
  it("ignores an expired or not-yet-started exemption", () => {
    expect(currentPscExemption(body([{ exempt_from: "2018-06-18" }]), "2026-10-17")).toBe(
      "psc_exempt_as_trading_on_uk_regulated_market",
    );
    expect(
      currentPscExemption(
        body([{ exempt_from: "2018-06-18", exempt_to: "2023-02-02" }]),
        "2026-10-17",
      ),
    ).toBeUndefined();
    expect(
      currentPscExemption(body([{ exempt_from: "2030-01-01" }]), "2026-10-17"),
    ).toBeUndefined();
    expect(
      currentPscExemption(
        body([
          { exempt_from: "2018-01-01", exempt_to: "2019-01-01" },
          { exempt_from: "2024-01-01" },
        ]),
        "2026-10-17",
      ),
    ).toBeDefined();
    expect(
      currentPscExemption(
        {
          exemptions: {
            disclosure_transparency_rules_chapter_five_applies: {
              items: [{ exempt_from: "2017-01-01" }],
            },
          },
        },
        "2026-10-17",
      ),
    ).toBeUndefined();
    expect(currentPscExemption(undefined, "2026-10-17")).toBeUndefined();
  });

  it("does not call a delisted company exempt: the chain is not reported as finished", async () => {
    const routes: Routes = defaultRoutes();
    const expired = fixtureText("companies_house/tesco-exemptions.json").replace(
      '"exempt_from": "2018-06-18"',
      '"exempt_from": "2018-06-18", "exempt_to": "2023-02-02"',
    );
    routes[`${CH}/company/00445790/exemptions`] = { body: expired };
    h = await startHarness({ routes });
    const r = await h.call("get_ownership", { identifier: "00445790", country: "GB" });
    const root = r.json.data.ownership.data.nodes[0];
    expect(root.terminal).not.toBe("exempt");
  });
});

describe("review: control bands are never understated", () => {
  it("keeps the widest range when a controller holds several natures of one kind", () => {
    expect(
      parseNatures([
        "ownership-of-shares-25-to-50-percent",
        "ownership-of-shares-50-to-75-percent-as-trust",
        "voting-rights-25-to-50-percent",
      ]),
    ).toMatchObject({ sharesMin: 25, sharesMax: 75, votingMin: 25, votingMax: 50 });
  });
});

describe("review: ownership walker", () => {
  it("reports an error, not an empty graph, when the company itself can not be read", async () => {
    const routes: Routes = defaultRoutes();
    routes[`${CH}/company/00519500/persons-with-significant-control`] = { status: 503, body: "" };
    h = await startHarness({ routes });
    const r = await h.call("get_ownership", { identifier: "00519500", country: "GB" });
    expect(r.json.data.ownership.state).toBe("error");
    expect(r.json.summary).toContain("in error");
  });

  it("says when every controller has ceased instead of claiming there are none", async () => {
    const routes: Routes = defaultRoutes();
    company(routes, "30000001", "WAS OWNED LIMITED", [
      individual("Jane", "Example", ["ownership-of-shares-75-to-100-percent"], {
        ceased: true,
        ceased_on: "2020-01-01",
      }),
    ]);
    h = await startHarness({ routes });
    const r = await h.call("get_ownership", { identifier: "30000001", scheme: "GB_CRN" });
    const root = r.json.data.ownership.data.nodes[0];
    expect(root.terminal).toBe("all_ceased");
    expect(root.terminalDetail).toContain("have ceased");
  });

  it("is one node for one person who controls several companies in the chain", async () => {
    const routes: Routes = defaultRoutes();
    const p = (natures: string[]) => individual("Abu", "Abbas", natures);
    company(routes, "30000010", "TOP CO LIMITED", [
      corporate("Mid Co Limited", "30000011", ["ownership-of-shares-50-to-75-percent"]),
      p(["ownership-of-shares-25-to-50-percent"]),
    ]);
    company(routes, "30000011", "MID CO LIMITED", [p(["ownership-of-shares-75-to-100-percent"])]);
    h = await startHarness({ routes });
    const own = await h.call("get_ownership", { identifier: "30000010", scheme: "GB_CRN" });
    const g = own.json.data.ownership.data;
    const people = g.nodes.filter((n: any) => n.kind === "person");
    expect(people).toHaveLength(1);
    expect(g.edges.filter((e: any) => e.from === people[0].nodeId)).toHaveLength(2);
    expect(g.ultimateOwners.filter((u: any) => u.kind === "person")).toHaveLength(1);

    // ...and the screening description carries both kinds of control, not one arbitrary edge.
    const s = await h.call("screen_sanctions", {
      identifier: "30000010",
      scheme: "GB_CRN",
      include: ["owners"],
    });
    const hit = s.json.data.related.hits.find((x: any) => x.name === "Abu Abbas");
    expect(hit.relations).toEqual(["owner"]);
    expect(hit.description).toContain("ownership-of-shares-25-to-50-percent");
    expect(hit.description).toContain("ownership-of-shares-75-to-100-percent");
  });

  it("fetches the companies of one level side by side, within the concurrency limit", async () => {
    const routes: Routes = defaultRoutes();
    const kids = Array.from({ length: 8 }, (_, i) => `4000000${i + 1}`);
    company(
      routes,
      "40000000",
      "PARENT LIMITED",
      kids.map((n, i) => corporate(`Kid ${i} Limited`, n)),
    );
    for (const [i, n] of kids.entries()) company(routes, n, `KID ${i} LIMITED`, []);
    let inFlight = 0;
    let max = 0;
    const inner = fakeFetch(routes);
    const probe = Object.assign(
      async (url: string, init?: RequestInit) => {
        const isPsc =
          url.includes("/persons-with-significant-control") && !url.includes("40000000");
        if (isPsc) {
          inFlight++;
          max = Math.max(max, inFlight);
          await new Promise((r) => setTimeout(r, 20));
        }
        try {
          return await inner(url, init);
        } finally {
          if (isPsc) inFlight--;
        }
      },
      { calls: inner.calls },
    );
    h = await startHarness({ fetchImpl: probe });
    const r = await h.call("get_ownership", { identifier: "40000000", scheme: "GB_CRN", depth: 2 });
    expect(r.json.data.ownership.data.companiesExpanded).toBe(9);
    expect(max).toBeGreaterThanOrEqual(2);
    expect(max).toBeLessThanOrEqual(5);
  });
});

describe("review: related-party screening", () => {
  it("returns at most 25 related parties with hits, but the overall result counts them all", async () => {
    const routes: Routes = defaultRoutes();
    const owners = Array.from({ length: 40 }, (_, i) =>
      corporate(`HAVIN BANK LIMITED ${i + 1}`, String(50000001 + i)),
    );
    company(routes, "50000000", "BIG GROUP LIMITED", owners);
    h = await startHarness({ routes });
    const r = await h.call("screen_sanctions", {
      identifier: "50000000",
      scheme: "GB_CRN",
      include: ["owners"],
      owners_depth: 1,
    });
    const rel = r.json.data.related;
    expect(rel.hits).toHaveLength(25);
    expect(rel.hits.every((x: any) => x.hits.length <= 3 && !("remarks" in x.hits[0]))).toBe(true);
    expect(r.json.data.overall).toBe("possible_match");
    expect(r.json.warnings.join(" ")).toContain("25 highest-scoring of 40");
  });

  it("resolves the company once and runs officers and owners together", async () => {
    h = await startHarness();
    await h.call("screen_sanctions", {
      identifier: "00445790",
      country: "GB",
      include: ["officers", "owners"],
      fresh: true,
    });
    const profileFetches = h.fetch.calls.filter((c) => /\/company\/00445790$/.test(c.url)).length;
    expect(profileFetches).toBe(1);
  });

  it("keeps the reasons behind an incomplete related group visible", async () => {
    const routes: Routes = defaultRoutes();
    const page = (start: number) => ({
      body: JSON.stringify({
        items: Array.from({ length: 100 }, (_, i) => ({
          name: `P${start + i}, X`,
          officer_role: "director",
        })),
        total_results: 650,
        active_count: 650,
        resigned_count: 0,
      }),
    });
    routes[`${CH}/company/00445790/officers`] = [
      page(0),
      page(100),
      page(200),
      page(300),
      page(400),
    ];
    h = await startHarness({ routes });
    const r = await h.call("screen_sanctions", {
      identifier: "00445790",
      country: "GB",
      include: ["officers"],
    });
    const w = r.json.warnings.join(" ");
    expect(w).toContain("registry lists 650 officers");
    expect(w).toContain("Only 100 of 500 current officers could be screened");
    expect(r.json.data.overall).toBe("incomplete");
  });

  it("names who was screened in each group by their relations", async () => {
    const routes: Routes = defaultRoutes();
    routes[`${CH}/company/30000020/officers`] = {
      body: JSON.stringify({
        items: [{ name: "ABBAS, Abu", officer_role: "director" }],
        total_results: 1,
        active_count: 1,
        resigned_count: 0,
      }),
    };
    company(routes, "30000020", "BOTH LIMITED", [
      individual("Abu", "Abbas", ["ownership-of-shares-25-to-50-percent"]),
    ]);
    h = await startHarness({ routes });
    const r = await h.call("screen_sanctions", {
      identifier: "30000020",
      scheme: "GB_CRN",
      include: ["officers", "owners"],
    });
    const rel = r.json.data.related;
    expect(rel.screened.officers).toEqual(["Abu ABBAS"]);
    // The same person as officer and owner is screened once, with both relations kept.
    expect(rel.screened.owners).toEqual(["Abu ABBAS"]);
    expect(rel.hits).toHaveLength(1);
    expect(rel.hits[0].relations).toEqual(["officer", "owner"]);
    expect(rel.hits[0].description).toContain("officer: director");
    expect(rel.hits[0].description).toContain("owner: ownership-of-shares-25-to-50-percent");
  });
});
