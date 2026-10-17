import { describe, expect, it } from "vitest";
import { irelandAdapter } from "../../src/adapters/ie-cro/index.js";
import {
  mapCroEntity,
  mapCroLegalForm,
  mapCroStatus,
  searchTerms,
  type CroRecord,
} from "../../src/adapters/ie-cro/map.js";
import { detectIdentifier, normalizeIeCro } from "../../src/core/identifiers.js";
import type { Identifier, Provenance } from "../../src/core/types.js";
import { fakeFetch, fixtureText, makeCtx } from "../helpers.js";

const C = "https://opendata.cro.ie/api/3/action";
const R = "3fef41bc-b8f4-4b10-8434-ce51c29b1bba";
const fx = (p: string) => fixtureText(`cro_ie/${p}`);
const rec = (p: string): CroRecord => JSON.parse(fx(p)).result.records[0];
const prov: Provenance = {
  source: "cro_ie",
  sourceRecordId: "x",
  retrievedAt: "2026-01-01T00:00:00Z",
  fromCache: false,
};
const id = (value: string): Identifier => ({
  scheme: "IE_CRO",
  value,
  validated: false,
  provenance: [],
});
const by = (_n: number) => `${C}/datastore_search?resource_id=${R}&filters=`;
const routes = () => ({
  [`${C}/package_show`]: { body: fx("package.json") },
  [`${by(1)}${encodeURIComponent(JSON.stringify({ company_num: 249885 }))}`]: {
    body: fx("ryanair-holdings.json"),
  },
  [by(1)]: { body: fx("empty.json") },
  [`${C}/datastore_search?resource_id=${R}&q=`]: { body: fx("search-ryanair.json") },
});

describe("Irish company numbers", () => {
  it("accepts digits, drops leading zeros, and needs a country to be recognised", () => {
    expect(normalizeIeCro("249885")).toBe("249885");
    expect(normalizeIeCro("0249885")).toBe("249885");
    expect(normalizeIeCro("IE249885")).toBeUndefined();
    expect(normalizeIeCro("12345678")).toBeUndefined();
    expect(normalizeIeCro("0")).toBeUndefined();
    expect(detectIdentifier("249885", "IE")).toMatchObject({ scheme: "IE_CRO", value: "249885" });
    expect(detectIdentifier("249885")).toBeUndefined();
    // An Irish VAT number stays a VAT number.
    expect(detectIdentifier("IE6388047V")).toMatchObject({ scheme: "VAT" });
  });
});

describe("Ireland: mapping", () => {
  it("maps Ryanair Holdings with form, status, dates and address", () => {
    const p = mapCroEntity(rec("ryanair-holdings.json"), "249885", prov)!;
    expect(p.names[0]).toMatchObject({ name: "RYANAIR HOLDINGS PUBLIC LIMITED COMPANY" });
    expect(p.legalForm!.value).toMatchObject({ normalized: "public_company" });
    expect(p.status!.value).toMatchObject({
      normalized: "active",
      group: "operating",
      sourceText: "Normal",
    });
    expect(p.incorporationDate!.value).toBe("1996-06-05");
    expect(p.dissolutionDate).toBeUndefined();
    expect(p.registeredAddress!.value.formatted).toContain("AIRSIDE BUSINESS PARK");
    expect(p.registeredAddress!.value.country).toBe("IE");
    expect(p.jurisdiction).toBe("IE");
  });

  it("reads dissolved, liquidation and strike-off notices without guessing", () => {
    const dis = mapCroEntity(rec("dissolved.json"), "279457", prov)!;
    expect(dis.status!.value).toMatchObject({ normalized: "dissolved", group: "ended" });
    expect(dis.dissolutionDate!.value).toBe("2000-06-30");
    expect(mapCroStatus(rec("liquidation.json"))).toMatchObject({
      normalized: "in_liquidation",
      group: "distressed",
    });
    const listed = mapCroEntity(rec("strike-off.json"), "581002", prov)!;
    expect(listed.status!.value).toMatchObject({
      normalized: "unknown",
      sourceText: "Strike Off Listed",
    });
    expect(listed.notes.join(" ")).toContain("strike-off");
    expect(mapCroStatus({ company_status: "Struck Off" }).normalized).toBe("struck_off");
    expect(mapCroStatus({ company_status: "Examinership" }).normalized).toBe("in_administration");
    expect(mapCroStatus({ company_status: "Dissolved PostMerger" }).normalized).toBe(
      "merged_or_converted",
    );
    expect(mapCroStatus({ company_status: "something new" }).normalized).toBe("unknown");
    // Registry text must not reach Object.prototype.
    expect(mapCroStatus({ company_status: "constructor" }).normalized).toBe("unknown");
  });

  it("maps company types by wording and keeps the wording", () => {
    const form = (t: string) => mapCroLegalForm({ company_type: t });
    expect(form("LTD - Private Company Limited by Shares")!.normalized).toBe("limited_company");
    expect(form("DAC - Designated Activity Company (limited by shares)")!.normalized).toBe(
      "limited_company",
    );
    expect(form("CLG - Company Limited by Guarantee")!.normalized).toBe("limited_company");
    expect(form("PLC - Public Limited Company")!.normalized).toBe("public_company");
    expect(form("External company")!.normalized).toBe("branch");
    expect(form("ULC - Private Unlimited Company")).toMatchObject({ normalized: "other" });
    expect(form("U.C.I.T")).toMatchObject({ normalized: "other", localName: "U.C.I.T" });
    expect(mapCroLegalForm({})).toBeUndefined();
  });

  it("turns a typed name into the words the register can match", () => {
    expect(searchTerms("O'Brien (Ireland) Ltd")).toBe("O Brien Ireland");
    expect(searchTerms("Marks & Spencer Limited")).toBe("Marks Spencer");
    expect(searchTerms("Ltd")).toBe("Ltd");
    expect(searchTerms("Ryanair DAC")).toBe("Ryanair");
    expect(searchTerms("Siemens Energie GmbH")).toBe("Siemens Energie GmbH");
    expect(searchTerms("!!")).toBe("");
  });

  it("rejects a row without a name", () => {
    expect(mapCroEntity({ company_num: 1 }, "1", prov)).toBeUndefined();
  });
});

describe("Ireland: adapter", () => {
  it("looks a company up through the dataset's resource and caches it", async () => {
    const f = fakeFetch(routes());
    const ctx = makeCtx(f);
    const p = (await irelandAdapter.lookup(id("249885"), ctx))!;
    expect(p.identifiers[0]).toMatchObject({ scheme: "IE_CRO", value: "249885" });
    expect(p.names[0]!.provenance[0]).toMatchObject({
      source: "cro_ie",
      licence: expect.stringContaining("Creative Commons"),
    });
    expect(f.calls).toHaveLength(2); // package_show, then the row
    await irelandAdapter.lookup(id("0249885"), ctx);
    expect(f.calls).toHaveLength(2);
  });

  it("returns undefined for an unknown number and never requests an invalid one", async () => {
    const f = fakeFetch(routes());
    const ctx = makeCtx(f);
    expect(await irelandAdapter.lookup(id("9999999"), ctx)).toBeUndefined();
    const n = f.calls.length;
    expect(await irelandAdapter.lookup(id("abc"), ctx)).toBeUndefined();
    expect(f.calls.length).toBe(n);
  });

  it("refuses errors, wrong rows and odd dataset descriptions without caching them", async () => {
    const down = JSON.stringify({ success: false, error: { message: "x" } });
    const f1 = fakeFetch({ [`${C}/package_show`]: { body: down } });
    const ctx1 = makeCtx(f1);
    await expect(irelandAdapter.lookup(id("249885"), ctx1)).rejects.toMatchObject({
      kind: "bad_response",
    });
    await expect(irelandAdapter.lookup(id("249885"), ctx1)).rejects.toThrow();
    expect(f1.calls).toHaveLength(2);

    // Specific routes come first: the first matching prefix wins.
    const r = {
      [`${by(1)}${encodeURIComponent(JSON.stringify({ company_num: 123456 }))}`]: {
        body: fx("ryanair-holdings.json"),
      }, // answers for 249885
      ...routes(),
    };
    await expect(irelandAdapter.lookup(id("123456"), makeCtx(fakeFetch(r)))).rejects.toMatchObject({
      kind: "bad_response",
    });

    const evil = JSON.stringify({
      success: true,
      result: { resources: [{ id: "x/../../admin", datastore_active: true }] },
    });
    const f3 = fakeFetch({ [`${C}/package_show`]: { body: evil } });
    await expect(irelandAdapter.lookup(id("249885"), makeCtx(f3))).rejects.toMatchObject({
      kind: "bad_response",
    });
  });

  it("searches by company name only and returns status and address", async () => {
    const f = fakeFetch(routes());
    const hits = await irelandAdapter.search!("Ryanair Ltd", makeCtx(f), 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ jurisdiction: "IE", identifier: { scheme: "IE_CRO" } });
    expect(hits[0]!.status).toBeDefined();
    const url = decodeURIComponent(f.calls.at(-1)!.url);
    expect(url).toContain('q={"company_name":"Ryanair"}');
    expect(await irelandAdapter.search!("a", makeCtx(f))).toEqual([]);
  });

  it("declares that beneficial owners are not public", () => {
    expect(irelandAdapter.restrictions?.controllers?.reason).toBe("restricted_access");
  });
});
