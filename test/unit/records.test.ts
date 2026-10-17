import { describe, expect, it } from "vitest";
import {
  fetchCharges,
  fetchFilings,
  fetchInsolvency,
  mapCharge,
  mapFiling,
  mapInsolvencyCase,
} from "../../src/adapters/companies-house/records.js";
import { fakeFetch, fixtureText, makeCtx } from "../helpers.js";

const CH = "https://api.company-information.service.gov.uk/company";
const H = { authorization: "Basic x" };
const fx = (p: string) => fixtureText(`companies_house/${p}`);

describe("filing history mapping", () => {
  it("maps a real filing and keeps the registry's category, type and description", () => {
    const body = JSON.parse(fx("filing-history-tesco.json"));
    const f = mapFiling(body.items[0])!;
    expect(f).toMatchObject({
      category: "capital",
      type: "SH03",
      description: "capital-return-purchase-own-shares",
      paperFiled: true,
      pages: 4,
    });
    expect(f.documentUrl).toContain("document-api.company-information.service.gov.uk");
  });

  it("drops entries without an id or date and links that do not point at the registry", () => {
    expect(mapFiling({ date: "2020-01-01" })).toBeUndefined();
    expect(mapFiling({ transaction_id: "x" })).toBeUndefined();
    const f = mapFiling({
      transaction_id: "x",
      date: "2020-01-01",
      links: { document_metadata: "https://evil.example/doc" },
    })!;
    expect(f.documentUrl).toBeUndefined();
    expect(f.category).toBe("unknown");
  });
});

describe("charge mapping", () => {
  it("maps a charge and cuts very long particulars", () => {
    const c = mapCharge({
      charge_number: 3,
      status: "outstanding",
      classification: { description: "Debenture" },
      particulars: { description: "x".repeat(900) },
      persons_entitled: [{ name: "A BANK" }, {}],
    });
    expect(c).toMatchObject({ number: 3, status: "outstanding", classification: "Debenture" });
    expect(c.particulars!.length).toBeLessThan(310);
    expect(c.personsEntitled).toEqual(["A BANK"]);
  });
});

describe("insolvency mapping", () => {
  it("keeps the case number as a string whatever the register sends", () => {
    expect(mapInsolvencyCase({ number: 1, type: "x" }).number).toBe("1");
    expect(mapInsolvencyCase({ number: "2", type: "x" }).number).toBe("2");
    const c = mapInsolvencyCase(JSON.parse(fx("insolvency-case.json")).cases[0]);
    expect(c.type).toBe("compulsory-liquidation");
    expect(c.dates).toEqual([{ type: "wound-up-on", date: "2008-11-20" }]);
    expect(c.practitioners).toHaveLength(3);
  });
});

describe("Companies House records: fetching", () => {
  it("fetches one page of filings, filtered by category, and caches it per query", async () => {
    const f = fakeFetch({
      [`${CH}/00445790/filing-history`]: { body: fx("filing-history-tesco-accounts.json") },
    });
    const ctx = makeCtx(f);
    const q = { category: "accounts", limit: 2, offset: 0 };
    const r = (await fetchFilings(ctx, H, "00445790", q))!;
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.total).toBeGreaterThan(r.items.length);
    expect(f.calls[0]!.url).toContain("items_per_page=2&start_index=0&category=accounts");
    expect(r.provenance).toMatchObject({ source: "companies_house", licence: expect.any(String) });
    expect((await fetchFilings(ctx, H, "00445790", q))!.provenance.fromCache).toBe(true);
    expect(f.calls).toHaveLength(1);
    await fetchFilings(ctx, H, "00445790", { ...q, offset: 2 }); // another page is another request
    expect(f.calls).toHaveLength(2);
  });

  it("returns undefined for 404 and rejects a malformed body without caching it", async () => {
    const gone = fakeFetch({ [`${CH}/1`]: { status: 404, body: "" } });
    expect(await fetchFilings(makeCtx(gone), H, "1", { limit: 5, offset: 0 })).toBeUndefined();
    const bad = fakeFetch({ [`${CH}/00445790`]: { body: JSON.stringify({ oops: 1 }) } });
    const ctx = makeCtx(bad);
    const q = { limit: 5, offset: 0 };
    await expect(fetchFilings(ctx, H, "00445790", q)).rejects.toMatchObject({
      kind: "bad_response",
    });
    await expect(fetchFilings(ctx, H, "00445790", q)).rejects.toThrow();
    expect(bad.calls).toHaveLength(2);
  });

  it("counts outstanding charges from the register's totals", async () => {
    // The register is asked for a second page, which is empty: 3 of the 9 charges are in the sample.
    const f = fakeFetch({
      [`${CH}/00445790/charges`]: [
        { body: fx("charges-tesco.json") },
        { body: JSON.stringify({ items: [] }) },
      ],
    });
    const r = (await fetchCharges(makeCtx(f), H, "00445790"))!;
    expect(r).toMatchObject({ total: 9, satisfied: 7, outstanding: 2, truncated: true });
    expect(r.charges).toHaveLength(3); // the fixture holds a sample of the 9
  });

  it("counts a part-satisfied charge as outstanding", async () => {
    const body = JSON.stringify({
      items: [
        { status: "outstanding" },
        { status: "part-satisfied" },
        { status: "fully-satisfied" },
      ],
      total_count: 3,
      satisfied_count: 1,
      part_satisfied_count: 1,
    });
    const f = fakeFetch({ [`${CH}/1/charges`]: { body } });
    expect(await fetchCharges(makeCtx(f), H, "1")).toMatchObject({
      total: 3,
      satisfied: 1,
      partSatisfied: 1,
      outstanding: 2,
      truncated: false,
    });
  });

  it("does not read a 404 on charges as 'none registered', and flags a failure as an error", async () => {
    const gone = fakeFetch({ [`${CH}/NI017460/charges`]: { status: 404, body: "" } });
    expect(await fetchCharges(makeCtx(gone), H, "NI017460")).toBeUndefined();
    const empty = fakeFetch({
      [`${CH}/NI017460/charges`]: { body: JSON.stringify({ items: [], total_count: 0 }) },
    });
    expect(await fetchCharges(makeCtx(empty), H, "NI017460")).toMatchObject({
      total: 0,
      charges: [],
      truncated: false,
    });
    const down = fakeFetch({ [`${CH}/NI017460/charges`]: { status: 500, body: "" } });
    await expect(fetchCharges(makeCtx(down), H, "NI017460")).rejects.toThrow();
  });

  it("ignores a filing total that is not a number", async () => {
    const body = JSON.stringify({
      items: [{ transaction_id: "a", date: "2020-01-01" }],
      total_count: "8372",
    });
    const f = fakeFetch({ [`${CH}/1/filing-history`]: { body } });
    const r = (await fetchFilings(makeCtx(f), H, "1", { limit: 5, offset: 0 }))!;
    expect(r.total).toBe(1);
  });

  it("reads insolvency cases, treats 404 as no case, and rejects odd bodies", async () => {
    const f = fakeFetch({ [`${CH}/NI017460/insolvency`]: { body: fx("insolvency-case.json") } });
    const r = await fetchInsolvency(makeCtx(f), H, "NI017460");
    expect(r.cases).toHaveLength(1);
    expect(r.statusFlags).toEqual(["liquidation"]);
    const none = fakeFetch({ [`${CH}/1/insolvency`]: { status: 404, body: "" } });
    expect((await fetchInsolvency(makeCtx(none), H, "1")).cases).toEqual([]);
    const bad = fakeFetch({ [`${CH}/1/insolvency`]: { body: JSON.stringify({ cases: "x" }) } });
    await expect(fetchInsolvency(makeCtx(bad), H, "1")).rejects.toMatchObject({
      kind: "bad_response",
    });
  });
});
