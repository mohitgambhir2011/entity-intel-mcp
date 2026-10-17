import { describe, expect, it } from "vitest";
import {
  createCompaniesHouseAdapter,
  mapChStatus,
} from "../../src/adapters/companies-house/index.js";
import { gleifAdapter } from "../../src/adapters/gleif/index.js";
import { viesAdapter } from "../../src/adapters/vies/index.js";
import type { Identifier } from "../../src/core/types.js";
import { fakeFetch, fixtureText, makeCtx } from "../helpers.js";

const id = (scheme: Identifier["scheme"], value: string): Identifier => ({
  scheme,
  value,
  validated: false,
  provenance: [],
});

describe("GLEIF adapter", () => {
  const route = "https://api.gleif.org/api/v1/lei-records/2138002P5RNKC5W2JZ46";

  it("maps a LEI record, including the Companies House cross-reference", async () => {
    const f = fakeFetch({ [route]: { body: fixtureText("gleif/lei-tesco.json") } });
    const e = await gleifAdapter.lookup(id("LEI", "2138002P5RNKC5W2JZ46"), makeCtx(f));
    expect(e?.names[0]?.name).toBe("TESCO PLC");
    expect(e?.status?.value).toMatchObject({ normalized: "active", group: "operating" });
    expect(e?.legalForm?.value.code).toBe("B6ES");
    expect(e?.incorporationDate?.value).toBe("1947-11-27");
    expect(e?.registeredAddress?.value.formatted).toContain("WELWYN GARDEN CITY");
    const crn = e?.identifiers.find((i) => i.scheme === "GB_CRN");
    expect(crn?.value).toBe("00445790");
    const lei = e?.identifiers.find((i) => i.scheme === "LEI");
    expect(lei).toMatchObject({ validated: true, status: "active" });
    expect(lei?.provenance[0]).toMatchObject({ source: "gleif", fromCache: false });
  });

  it("serves the second lookup from cache", async () => {
    const f = fakeFetch({ [route]: { body: fixtureText("gleif/lei-tesco.json") } });
    const ctx = makeCtx(f);
    await gleifAdapter.lookup(id("LEI", "2138002P5RNKC5W2JZ46"), ctx);
    const again = await gleifAdapter.lookup(id("LEI", "2138002P5RNKC5W2JZ46"), ctx);
    expect(f.calls).toHaveLength(1);
    expect(again?.identifiers[0]?.provenance[0]?.fromCache).toBe(true);
  });

  it("returns undefined for 404 and for an invalid LEI without calling the API", async () => {
    const f = fakeFetch({ [route]: { status: 404, body: "" } });
    expect(
      await gleifAdapter.lookup(id("LEI", "2138002P5RNKC5W2JZ46"), makeCtx(f)),
    ).toBeUndefined();
    const f2 = fakeFetch({});
    expect(
      await gleifAdapter.lookup(id("LEI", "2138002P5RNKC5W2JZ47"), makeCtx(f2)),
    ).toBeUndefined();
    expect(f2.calls).toHaveLength(0);
  });

  it("searches by name and returns candidates (not auto-picked)", async () => {
    const f = fakeFetch({
      "https://api.gleif.org/api/v1/lei-records?": { body: fixtureText("gleif/search-tesco.json") },
    });
    const hits = await gleifAdapter.search!("TESCO PLC", makeCtx(f), 3);
    expect(hits.map((h) => h.name)).toEqual([
      "TESCO PLC",
      "TESCO TREASURY SERVICES PLC",
      "TESCO PLC PENSION SCHEME",
    ]);
    expect(hits[0]?.identifier.scheme).toBe("LEI");
  });
});

describe("VIES adapter", () => {
  const base = "https://ec.europa.eu/taxation_customs/vies/rest-api/ms";

  it("returns name and address when the member state releases them", async () => {
    const f = fakeFetch({
      [`${base}/IE/vat/6388047V`]: { body: fixtureText("vies/ie-valid.json") },
    });
    const e = await viesAdapter.lookup(id("VAT", "IE6388047V"), makeCtx(f));
    expect(e?.names[0]?.name).toBe("GOOGLE IRELAND LIMITED");
    expect(e?.identifiers[0]).toMatchObject({ value: "IE6388047V", validated: true });
    expect(e?.registeredAddress?.value.formatted).toContain("DUBLIN 4");
  });

  it("treats '---' as withheld, not as a name", async () => {
    const f = fakeFetch({
      [`${base}/DE/vat/811128135`]: { body: fixtureText("vies/de-name-withheld.json") },
    });
    const e = await viesAdapter.lookup(id("VAT", "DE811128135"), makeCtx(f));
    expect(e?.names).toHaveLength(0);
    expect(e?.identifiers[0]?.validated).toBe(true);
    expect(e?.notes.join(" ")).toContain("does not release");
  });

  it("reports invalid numbers as not validated", async () => {
    const f = fakeFetch({
      [`${base}/NL/vat/820571204B01`]: { body: fixtureText("vies/nl-invalid.json") },
    });
    const e = await viesAdapter.lookup(id("VAT", "NL820571204B01"), makeCtx(f));
    expect(e?.identifiers[0]).toMatchObject({ validated: false, status: "unknown" });
    expect(e?.notes.join(" ")).toContain("not valid");
  });

  it("surfaces member-state outages as unavailable errors", async () => {
    const f = fakeFetch({
      [`${base}/FR/vat/12345678901`]: {
        body: JSON.stringify({ isValid: false, userError: "MS_UNAVAILABLE" }),
      },
    });
    await expect(viesAdapter.lookup(id("VAT", "FR12345678901"), makeCtx(f))).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});

describe("Companies House adapter", () => {
  const key = "test-key-123";
  const adapter = createCompaniesHouseAdapter(key);
  const base = "https://api.company-information.service.gov.uk";

  it("maps a company profile with former names", async () => {
    const f = fakeFetch({
      [`${base}/company/00445790`]: { body: fixtureText("companies_house/company-tesco.json") },
    });
    const e = await adapter.lookup(id("GB_CRN", "445790"), makeCtx(f));
    expect(e?.names[0]).toMatchObject({ name: "TESCO PLC", kind: "legal" });
    expect(e?.names.filter((n) => n.kind === "former")).toHaveLength(2);
    expect(e?.status?.value).toMatchObject({ normalized: "active", group: "operating" });
    expect(e?.legalForm?.value.normalized).toBe("public_company");
    expect(e?.registeredAddress?.value.postalCode).toBe("AL7 1GA");
    expect(e?.identifiers[0]?.provenance[0]?.licence).toContain("Open Government");
  });

  it("sends the key as HTTP Basic auth and never in the URL", async () => {
    const f = fakeFetch({
      [`${base}/company/00445790`]: { body: fixtureText("companies_house/company-tesco.json") },
    });
    await adapter.lookup(id("GB_CRN", "00445790"), makeCtx(f));
    const call = f.calls[0]!;
    expect(call.url).not.toContain(key);
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from(`${key}:`).toString("base64")}`);
  });

  it("returns undefined on 404", async () => {
    const f = fakeFetch({ [`${base}/company/99999999`]: { status: 404, body: "" } });
    expect(await adapter.lookup(id("GB_CRN", "99999999"), makeCtx(f))).toBeUndefined();
  });

  it("fails with an auth error naming the env var when no key is configured", async () => {
    const nokey = createCompaniesHouseAdapter(undefined);
    await expect(
      nokey.lookup(id("GB_CRN", "00445790"), makeCtx(fakeFetch({}))),
    ).rejects.toMatchObject({
      kind: "auth",
      message: expect.stringContaining("COMPANIES_HOUSE_API_KEY"),
    });
  });

  it("searches and maps status", async () => {
    const f = fakeFetch({
      [`${base}/search/companies`]: { body: fixtureText("companies_house/search-tesco.json") },
    });
    const hits = await adapter.search!("tesco", makeCtx(f), 3);
    expect(hits[0]).toMatchObject({ name: "TESCO PLC", identifier: { value: "00445790" } });
    expect(hits[0]?.status?.normalized).toBe("active");
  });

  it("maps statuses per D21 and never guesses", () => {
    expect(mapChStatus("liquidation").normalized).toBe("in_liquidation");
    expect(mapChStatus("administration").group).toBe("distressed");
    expect(mapChStatus("converted-closed").normalized).toBe("merged_or_converted");
    expect(mapChStatus("something-new")).toMatchObject({ normalized: "unknown", group: "unknown" });
  });
});
