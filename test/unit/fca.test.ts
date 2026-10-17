import { describe, expect, it } from "vitest";
import { createFcaAdapter } from "../../src/adapters/fca/index.js";
import {
  isoDate,
  mapPermissions,
  mapRegulators,
  mapRequirements,
  outcomeOf,
} from "../../src/adapters/fca/map.js";
import { normalizeFrn } from "../../src/core/identifiers.js";
import type { Identifier } from "../../src/core/types.js";
import { fakeFetch, fixtureText, makeCtx } from "../helpers.js";

const F = "https://register.fca.org.uk/services/V0.1";
const fx = (p: string) => fixtureText(`fca/${p}`);
const id = (scheme: Identifier["scheme"], value: string): Identifier => ({
  scheme,
  value,
  validated: false,
  provenance: [],
});
const adapter = createFcaAdapter("a@b.test", "k");
const routes = (): Record<string, { body: string }> => ({
  [`${F}/Firm/759676/Permissions?pgnp=2`]: { body: fx("permissions-p2.json") },
  [`${F}/Firm/759676/Permissions`]: { body: fx("permissions-p1.json") },
  [`${F}/Firm/759676/Regulators`]: { body: fx("regulators.json") },
  [`${F}/Firm/759676/Requirements`]: { body: fx("requirements.json") },
  [`${F}/Firm/759676`]: { body: fx("firm-759676.json") },
  [`${F}/Search?q=759676`]: { body: fx("search-frn.json") },
  [`${F}/Search?q=Barclays`]: { body: fx("search-barclays.json") },
});

describe("FCA response envelope", () => {
  it("tells answers, 'nothing found' and errors apart (every reply is HTTP 200)", () => {
    expect(outcomeOf({ Status: "FSR-API-02-01-00", Message: "Ok. Firm Found" })).toBe("ok");
    expect(outcomeOf({ Status: "FSR-API-02-01-11", Message: "Firm not found" })).toBe("not_found");
    expect(outcomeOf({ Status: "FSR-API-04-01-11", Message: "No search result found" })).toBe(
      "not_found",
    );
    expect(outcomeOf({ Status: "FSR-API-02-01-21", Message: "Bad Request: Invalid Input" })).toBe(
      "error",
    );
    expect(outcomeOf({ Message: "Ok" })).toBe("error");
    expect(outcomeOf(null)).toBe("error");
  });
});

describe("FCA mapping", () => {
  it("converts dd/mm/yyyy dates and drops anything else", () => {
    expect(isoDate("06/04/2017")).toBe("2017-04-06");
    expect(isoDate("2017-04-06")).toBeUndefined();
    expect(isoDate("")).toBeUndefined();
    expect(normalizeFrn("FRN 759676")).toBe("759676");
    expect(normalizeFrn("12")).toBeUndefined();
    expect(normalizeFrn("12345678")).toBeUndefined();
  });

  it("reads permissions with their limitations, and tolerates odd keys", () => {
    const p = mapPermissions(JSON.parse(fx("permissions-p1.json")).Data);
    expect(p.length).toBe(20);
    expect(p.find((x) => x.name === "Debt Adjusting")!.limitations[0]).toContain("debt adjusting");
    expect(p.find((x) => x.name === "Debt-collecting")!.limitations).toEqual([]);
    const odd = mapPermissions(JSON.parse('{"__proto__":[{"Limitation":["x"]}],"constructor":5}'));
    expect(odd.map((x) => x.name).sort()).toEqual(["__proto__", "constructor"]);
    expect(mapPermissions(null)).toEqual([]);
    expect(mapPermissions([1])).toEqual([]);
  });

  it("reads requirement text from whichever field carries it and counts the unreadable", () => {
    const { items, unreadable } = mapRequirements(JSON.parse(fx("requirements.json")).Data);
    expect(items).toHaveLength(3);
    expect(unreadable).toBe(0);
    expect(items[1]!.kind).toContain("whistleblowing");
    expect(items[0]!.text).toContain("TAKE NOTICE");
    const r = mapRequirements([
      { "Effective Date": "01/01/2024", "Requirement Reference": "R1" },
      { "Effective Date": "01/01/2024", Kind: "Do the thing" },
    ]);
    expect(r.items).toHaveLength(1);
    expect(r.unreadable).toBe(1);
  });

  it("reads regulators", () => {
    expect(mapRegulators(JSON.parse(fx("regulators.json")).Data).map((r) => r.name)).toEqual([
      "Financial Conduct Authority",
      "Prudential Regulation Authority",
    ]);
  });
});

describe("FCA adapter", () => {
  it("looks a firm up by FRN and links its Companies House number", async () => {
    const f = fakeFetch(routes());
    const p = (await adapter.lookup(id("FCA_FRN", "759676"), makeCtx(f)))!;
    expect(p.names[0]).toMatchObject({ name: "Barclays Bank UK PLC", kind: "legal" });
    expect(p.identifiers.map((i) => `${i.scheme}=${i.value}`)).toEqual([
      "FCA_FRN=759676",
      "GB_CRN=09740322",
    ]);
    expect(p.status).toBeUndefined(); // authorisation is not company status
    expect(f.calls[0]!.headers["X-Auth-Email"]).toBe("a@b.test");
  });

  it("returns undefined for an unknown firm and rejects errors and wrong firms without caching", async () => {
    const none = fakeFetch({ [`${F}/Firm/`]: { body: fx("firm-notfound.json") } });
    expect(await adapter.lookup(id("FCA_FRN", "999999"), makeCtx(none))).toBeUndefined();
    const invalid = JSON.stringify({
      Status: "FSR-API-02-01-21",
      Message: "Bad Request: Invalid Input",
      Data: null,
    });
    const bad = fakeFetch({ [`${F}/Firm/`]: { body: invalid } });
    const ctx = makeCtx(bad);
    await expect(adapter.lookup(id("FCA_FRN", "111111"), ctx)).rejects.toMatchObject({
      kind: "bad_response",
    });
    await expect(adapter.lookup(id("FCA_FRN", "111111"), ctx)).rejects.toThrow();
    expect(bad.calls).toHaveLength(2);
    // The record for 759676 answers a request for 111111: refused.
    const wrong = fakeFetch({ [`${F}/Firm/111111`]: { body: fx("firm-759676.json") } });
    await expect(adapter.lookup(id("FCA_FRN", "111111"), makeCtx(wrong))).rejects.toMatchObject({
      kind: "bad_response",
    });
  });

  it("finds the firm of a company by name, confirmed by its Companies House number, and reads everything", async () => {
    const f = fakeFetch(routes());
    const r = (await adapter.regulatory!(
      { identifiers: [id("GB_CRN", "09740322")], names: ["Barclays Bank UK PLC"] },
      makeCtx(f),
    ))!;
    expect(r).toMatchObject({
      frn: "759676",
      name: "Barclays Bank UK PLC",
      status: "Authorised",
      statusEffectiveFrom: "2017-04-06",
      matchedBy: "companies_house_number",
      permissionsTotal: 34,
      requirementsTotal: 3,
      truncated: false,
    });
    expect(r.permissions).toHaveLength(34); // two pages merged
    expect(r.regulators).toHaveLength(2);
    expect(r.requirements).toHaveLength(3);
    expect(r.provenance).toMatchObject({ source: "fca", licence: expect.any(String) });
  });

  it("does not accept a firm whose Companies House number differs", async () => {
    const f = fakeFetch(routes());
    const r = await adapter.regulatory!(
      { identifiers: [id("GB_CRN", "00445790")], names: ["Barclays Bank UK PLC"] },
      makeCtx(f),
    );
    expect(r).toBeUndefined();
  });

  it("prefers the current authorisation when a lapsed firm carries the same company number", async () => {
    const r = routes();
    const hit = (frn: string, status: string) => ({
      URL: `${F}/Firm/${frn}`,
      Status: status,
      "Reference Number": frn,
      "Type of business or Individual": "Firm",
      Name: "Barclays Bank UK PLC",
    });
    r[`${F}/Search?q=Barclays`] = {
      body: JSON.stringify({
        Status: "FSR-API-04-01-00",
        Message: "Ok. Search successful",
        ResultInfo: { total_count: "2" },
        Data: [hit("123456", "No longer authorised"), hit("759676", "Authorised")],
      }),
    };
    const old = JSON.parse(fx("firm-759676.json"));
    old.Data[0].FRN = "123456";
    r[`${F}/Firm/123456`] = { body: JSON.stringify(old) };
    const out = (await adapter.regulatory!(
      { identifiers: [id("GB_CRN", "09740322")], names: ["Barclays Bank UK PLC"] },
      makeCtx(fakeFetch(r)),
    ))!;
    expect(out.frn).toBe("759676");
  });

  it("uses a given FRN directly and caches the whole result", async () => {
    const f = fakeFetch(routes());
    const ctx = makeCtx(f);
    const q = { identifiers: [id("FCA_FRN", "759676")], names: [] };
    expect((await adapter.regulatory!(q, ctx))!.matchedBy).toBe("frn");
    const n = f.calls.length;
    expect((await adapter.regulatory!(q, ctx))!.provenance.fromCache).toBe(true);
    expect(f.calls.length).toBe(n);
  });

  it("flags lists it could not read completely", async () => {
    const r = routes();
    const p1 = JSON.parse(fx("permissions-p1.json"));
    const looping = { ...p1, ResultInfo: { ...p1.ResultInfo, Next: `${F}/more` } };
    r[`${F}/Firm/759676/Permissions?pgnp=2`] = { body: JSON.stringify(looping) };
    r[`${F}/Firm/759676/Permissions`] = { body: JSON.stringify(looping) };
    const out = (await adapter.regulatory!(
      { identifiers: [id("FCA_FRN", "759676")], names: [] },
      makeCtx(fakeFetch(r)),
    ))!;
    expect(out.truncated).toBe(true); // stops after five pages
  });

  it("says it is not configured without credentials", async () => {
    const bare = createFcaAdapter(undefined, undefined);
    await expect(
      bare.lookup(id("FCA_FRN", "759676"), makeCtx(fakeFetch({}))),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("covers regulatory status for company and firm numbers only", () => {
    expect(adapter.covers!("regulatory", id("GB_CRN", "1"))).toBe(true);
    expect(adapter.covers!("regulatory", id("LEI", "x"))).toBe(false);
    expect(adapter.covers!("officers", id("GB_CRN", "1"))).toBe(false);
    expect(adapter.supports(id("GB_CRN", "1"))).toBe(false);
  });
});
