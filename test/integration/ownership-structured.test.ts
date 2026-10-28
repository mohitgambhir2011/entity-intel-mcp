import { afterEach, describe, expect, it } from "vitest";
import { structureEdge, isNoControllerStatement } from "../../src/services/ownership.js";
import { defaultRoutes, startHarness, type Harness } from "../harness.js";
import { fixtureText } from "../helpers.js";

// E4: get_ownership returns machine-friendly, stable edges and says whether a "statement" end of
// chain is a real answer (noController). Everything here is additive to the existing shape.

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const CH = "https://api.company-information.service.gov.uk";
const profile = (number: string, name: string) => ({
  body: JSON.stringify({
    company_name: name,
    company_number: number,
    company_status: "active",
    type: "ltd",
    date_of_creation: "2010-01-01",
  }),
});
const statements = (...codes: string[]) => ({
  body: JSON.stringify({
    items: codes.map((statement, i) => ({ etag: `e${i}`, kind: "x", statement })),
    total_results: codes.length,
  }),
});
const pscList = (items: unknown[]) => ({
  body: JSON.stringify({
    items,
    total_results: items.length,
    active_count: items.length,
    ceased_count: 0,
  }),
});

describe("structureEdge (pure)", () => {
  const natures = (over: Record<string, unknown>) => ({ codes: ["a"], ...over });
  const edge = (n: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    structureEdge(
      { natures: natures(n) as any, notifiedOn: "2020-01-01", active: true, ...extra },
      "A",
      "B",
      "companies_house:B",
    );

  it("maps a share band, voting band and control rights to interest types", () => {
    const e = edge({
      codes: ["ownership-of-shares-50-to-75-percent", "right-to-appoint-and-remove-directors"],
      sharesMin: 50,
      sharesMax: 75,
      votingMin: 25,
      votingMax: 50,
      appointsDirectors: true,
    });
    expect(e.interestTypes).toEqual(["shareholding", "votingRights", "appointmentOfBoard"]);
    expect(e.share).toEqual({ min: 50, max: 75 });
    expect(e.votes).toEqual({ min: 25, max: 50 });
    expect(e.control).toEqual({
      appointsBoard: true,
      significantInfluence: false,
      votingOver25: true,
    });
    expect(e.evidenceRef).toBe("companies_house:B");
  });

  it("REGRESSION honesty: a controller with no stated share has NO share (unknown), not 0", () => {
    const e = edge({ codes: ["significant-influence-or-control"], significantInfluence: true });
    expect(e.share).toBeUndefined();
    expect(e.votes).toBeUndefined();
    expect(e.interestTypes).toEqual(["otherInfluenceOrControl"]);
    expect(e.control.votingOver25).toBe(false);
  });

  it("an open-ended band keeps its upper bound at 100", () => {
    expect(edge({ sharesMin: 25 }).share).toEqual({ min: 25, max: 100 });
  });

  it("the id is stable when the controller ceases, and changes when the band changes", () => {
    const base = { codes: ["ownership-of-shares-25-to-50-percent"], sharesMin: 25, sharesMax: 50 };
    const live = edge(base);
    const ceased = edge(base, { ceasedOn: "2024-01-01", active: false });
    expect(ceased.edgeId).toBe(live.edgeId);
    const moved = edge({
      codes: ["ownership-of-shares-50-to-75-percent"],
      sharesMin: 50,
      sharesMax: 75,
    });
    expect(moved.edgeId).not.toBe(live.edgeId);
    expect(live.edgeId).toMatch(/^psc:[0-9a-f]{16}$/);
  });

  it("the id does not depend on the order of the register's nature codes", () => {
    const a = edge({ codes: ["x", "y"] });
    const b = edge({ codes: ["y", "x"] });
    expect(a.edgeId).toBe(b.edgeId);
  });
});

describe("noController", () => {
  it("is true only when every statement says nobody has significant control", () => {
    expect(isNoControllerStatement([])).toBe(false);
    expect(
      isNoControllerStatement([{ code: "no-individual-or-entity-with-signficant-control" }]),
    ).toBe(true);
    expect(
      isNoControllerStatement([{ code: "no-individual-or-entity-with-significant-control" }]),
    ).toBe(true);
    expect(isNoControllerStatement([{ code: "psc-details-not-confirmed" }])).toBe(false);
    expect(
      isNoControllerStatement([
        { code: "no-individual-or-entity-with-signficant-control" },
        { code: "steps-to-find-psc-not-yet-completed" },
      ]),
    ).toBe(false);
  });

  it("through the tool: the real 'no person or entity' statement is an answer", async () => {
    const routes = defaultRoutes();
    routes[`${CH}/company/10000002/persons-with-significant-control-statements`] = {
      body: fixtureText("companies_house/psc-statements-none.json"),
    };
    routes[`${CH}/company/10000002/persons-with-significant-control`] = pscList([]);
    routes[`${CH}/company/10000002`] = profile("10000002", "NOBODY LIMITED");
    h = await startHarness({ routes });
    const r = await h.call("get_ownership", { identifier: "10000002", scheme: "GB_CRN" });
    expect(r.json.data.ownership.data.nodes[0]).toMatchObject({
      terminal: "statement",
      noController: true,
    });
  });

  it("REGRESSION honesty: 'details not confirmed' and 'steps not completed' are NOT answers", async () => {
    const routes = defaultRoutes();
    routes[`${CH}/company/10000005/persons-with-significant-control-statements`] = statements(
      "psc-details-not-confirmed",
    );
    routes[`${CH}/company/10000005/persons-with-significant-control`] = pscList([]);
    routes[`${CH}/company/10000005`] = profile("10000005", "VAGUE LIMITED");
    h = await startHarness({ routes });
    const r = await h.call("get_ownership", { identifier: "10000005", scheme: "GB_CRN" });
    const root = r.json.data.ownership.data.nodes[0];
    expect(root.terminal).toBe("statement");
    expect(root.noController).toBe(false);
  });
});

describe("get_ownership edges (E4), real Tesco chain", () => {
  it("carries a stable id, interest types, bands, control flags and an evidence reference", async () => {
    h = await startHarness();
    const run = () => h!.call("get_ownership", { identifier: "00519500", country: "GB" });
    const g = (await run()).json.data.ownership.data;
    const e = g.edges[0];
    expect(e).toMatchObject({
      from: "GB:CH:00243011",
      to: "GB:CH:00519500",
      interestTypes: expect.arrayContaining(["shareholding", "appointmentOfBoard"]),
      share: { min: 75, max: 100 },
      control: { appointsBoard: true },
      evidenceRef: "companies_house:00519500",
    });
    expect(e.edgeId).toMatch(/^psc:[0-9a-f]{16}$/);
    // The reference points at a read that is really in provenance.
    const refs = g.provenance.map((p: any) => `${p.source}:${p.sourceRecordId}`);
    for (const edge of g.edges) expect(refs).toContain(edge.evidenceRef);
    // Same data, same ids (a second call, with the cache cleared by fresh).
    const again = (
      await h.call("get_ownership", { identifier: "00519500", country: "GB", fresh: true })
    ).json.data.ownership.data;
    expect(again.edges.map((x: any) => x.edgeId)).toEqual(g.edges.map((x: any) => x.edgeId));
    // The old shape is untouched.
    expect(e.natures).toMatchObject({ sharesMin: 75, sharesMax: 100, appointsDirectors: true });
  });

  it("every edge id in a graph is unique", async () => {
    h = await startHarness();
    const g = (await h.call("get_ownership", { identifier: "00519500", country: "GB" })).json.data
      .ownership.data;
    const ids = g.edges.map((x: any) => x.edgeId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
