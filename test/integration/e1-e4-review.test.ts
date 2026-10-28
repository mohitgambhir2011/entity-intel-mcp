import { afterEach, describe, expect, it } from "vitest";
import { defaultRoutes, startHarness, type Harness } from "../harness.js";
import { fixtureText } from "../helpers.js";

// Regression tests for the review of E1 and E4 (2026-10-28).

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const CH = "https://api.company-information.service.gov.uk";
const GLEIF = "https://api.gleif.org/api/v1/lei-records";
const HOLDINGS = "213800JBW23QIB8OWZ72";
const NOT_FOUND = { status: 404, body: "{}" };
const fx = (p: string) => ({ body: fixtureText(`gleif/${p}`) });

describe("E4: edge ids are unique within a graph", () => {
  it("REGRESSION: two identical PSC listings (same person, date, natures) get distinct ids", async () => {
    const routes = defaultRoutes();
    const same = {
      kind: "individual-person-with-significant-control",
      name: "Pat Example",
      name_elements: { forename: "Pat", surname: "Example" },
      ceased: false,
      notified_on: "2020-01-01",
      date_of_birth: { month: 3, year: 1970 },
      nationality: "British",
      country_of_residence: "England",
      natures_of_control: ["ownership-of-shares-25-to-50-percent"],
    };
    routes[`${CH}/company/10000009/persons-with-significant-control-statements`] = {
      status: 404,
      body: "",
    };
    routes[`${CH}/company/10000009/persons-with-significant-control`] = {
      body: JSON.stringify({
        items: [same, same],
        total_results: 2,
        active_count: 2,
        ceased_count: 0,
      }),
    };
    routes[`${CH}/company/10000009`] = {
      body: JSON.stringify({
        company_name: "TWICE LIMITED",
        company_number: "10000009",
        company_status: "active",
        type: "ltd",
        date_of_creation: "2010-01-01",
      }),
    };
    h = await startHarness({ routes });
    const r = await h.call("get_ownership", { identifier: "10000009", scheme: "GB_CRN" });
    const edges = r.json.data.ownership.data.edges;
    expect(edges).toHaveLength(2);
    const ids = edges.map((e: any) => e.edgeId);
    expect(new Set(ids).size).toBe(2);
    expect(ids[1]).toBe(`${ids[0]}#2`); // deterministic suffix
  });
});

describe("E1: the side of a relationship is checked", () => {
  const withHoldings = (over: Record<string, { status?: number; body: string }>) => ({
    [`${GLEIF}/${HOLDINGS}/direct-parent-relationship`]: fx("l2-holdings-direct-parent-rel.json"),
    [`${GLEIF}/${HOLDINGS}/ultimate-parent-relationship`]: fx(
      "l2-holdings-ultimate-parent-rel.json",
    ),
    [`${GLEIF}/${HOLDINGS}/direct-parent-reporting-exception`]: NOT_FOUND,
    [`${GLEIF}/${HOLDINGS}/ultimate-parent-reporting-exception`]: NOT_FOUND,
    [`${GLEIF}/${HOLDINGS}/direct-parent`]: fx("lei-tesco.json"),
    [`${GLEIF}/${HOLDINGS}/ultimate-parent`]: fx("lei-tesco.json"),
    [`${GLEIF}/${HOLDINGS}/direct-children`]: {
      body: JSON.stringify({ meta: { pagination: { total: 0 } }, data: [] }),
    },
    [`${GLEIF}/${HOLDINGS}/ultimate-children`]: {
      body: JSON.stringify({ meta: { pagination: { total: 0 } }, data: [] }),
    },
    [`${GLEIF}/${HOLDINGS}`]: fx("l2-holdings-lei.json"),
    // overrides replace the value above but keep its position (routes match by first prefix)
    ...over,
    ...defaultRoutes(),
  });

  it("REGRESSION: an ultimate relationship served at the direct endpoint is not accepted as the direct parent", async () => {
    h = await startHarness({
      routes: withHoldings({
        [`${GLEIF}/${HOLDINGS}/direct-parent-relationship`]: fx(
          "l2-holdings-ultimate-parent-rel.json",
        ),
      }),
    });
    const g = (await h.call("get_group_structure", { identifier: HOLDINGS })).json.data
      .groupStructure.data;
    expect(g.directParent.state).toBe("error");
    expect(g.ultimateParent.state).toBe("reported"); // the other side is unaffected
  });

  it("REGRESSION: a direct-parent exception served for the ultimate side is rejected", async () => {
    const ex = fx("l2-tesco-direct-parent-exception.json"); // category DIRECT_...
    h = await startHarness({
      routes: withHoldings({
        [`${GLEIF}/${HOLDINGS}/ultimate-parent-relationship`]: NOT_FOUND,
        [`${GLEIF}/${HOLDINGS}/ultimate-parent-reporting-exception`]: ex,
      }),
    });
    const g = (await h.call("get_group_structure", { identifier: HOLDINGS })).json.data
      .groupStructure.data;
    expect(g.ultimateParent.state).toBe("error");
  });
});

describe("E1: how current the data is", () => {
  it("returns the date of the GLEIF golden copy the answer comes from", async () => {
    const lei = JSON.parse(fixtureText("gleif/l2-holdings-lei.json"));
    const published = lei.meta?.goldenCopy?.publishDate;
    expect(typeof published).toBe("string"); // the recorded response carries it
    h = await startHarness({
      routes: {
        [`${GLEIF}/${HOLDINGS}/direct-parent-relationship`]: NOT_FOUND,
        [`${GLEIF}/${HOLDINGS}/ultimate-parent-relationship`]: NOT_FOUND,
        [`${GLEIF}/${HOLDINGS}/direct-parent-reporting-exception`]: NOT_FOUND,
        [`${GLEIF}/${HOLDINGS}/ultimate-parent-reporting-exception`]: NOT_FOUND,
        [`${GLEIF}/${HOLDINGS}`]: fx("l2-holdings-lei.json"),
        ...defaultRoutes(),
      },
    });
    const g = (await h.call("get_group_structure", { identifier: HOLDINGS, direction: "parents" }))
      .json.data.groupStructure.data;
    expect(g.goldenCopyPublishedAt).toBe(published);
  });
});

describe("check_coverage lists the group structure family", () => {
  it("names get_group_structure", async () => {
    h = await startHarness();
    const r = await h.call("check_coverage", {});
    expect(r.json.data.familiesSupported.join(" ")).toContain("get_group_structure");
  });
});
