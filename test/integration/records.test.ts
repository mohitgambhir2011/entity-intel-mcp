import { afterEach, describe, expect, it } from "vitest";
import { defaultRoutes, startHarness, type Harness } from "../harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const CH = "https://api.company-information.service.gov.uk/company";

describe("get_filings_and_insolvency", () => {
  it("returns filings, charges and insolvency for a UK company", async () => {
    h = await startHarness();
    const r = await h.call("get_filings_and_insolvency", { identifier: "00445790", country: "GB" });
    expect(r.isError).toBe(false);
    const d = r.json.data;
    expect(d.company.entityId).toBe("GB:CH:00445790");
    expect(d.filings.state).toBe("available");
    expect(d.filings.data.total).toBe(8372);
    expect(d.filings.data.items[0]).toMatchObject({ type: "SH03", category: "capital" });
    expect(d.charges.data).toMatchObject({ total: 9, outstanding: 2 });
    expect(d.insolvency.data.cases).toEqual([]); // 404 = no insolvency record
    expect(r.json.meta.page).toMatchObject({ total: 8372, limit: 25, offset: 0 });
    expect(r.json.warnings.join(" ")).toContain("could be read"); // 3 of 9 charges in the sample
    expect(r.json.disclaimer).toContain("personal data"); // charge holders can be individuals
  });

  it("does not call a charges 404 'no charges', and rejects an empty include", async () => {
    h = await startHarness({
      routes: { ...defaultRoutes(), [`${CH}/00445790/charges`]: { status: 404, body: "" } },
    });
    const r = await h.call("get_filings_and_insolvency", {
      identifier: "00445790",
      country: "GB",
      include: ["charges"],
    });
    expect(r.json.data.charges).toMatchObject({ state: "unavailable", reason: "no_such_record" });
    const none = await h.call("get_filings_and_insolvency", {
      identifier: "00445790",
      country: "GB",
      include: [],
    });
    expect(none.isError).toBe(true);
  });

  it("pages and filters filings by category", async () => {
    h = await startHarness();
    const r = await h.call("get_filings_and_insolvency", {
      identifier: "00445790",
      country: "GB",
      include: ["filings"],
      category: "accounts",
      limit: 2,
    });
    expect(r.json.data.charges).toBeUndefined();
    expect(r.json.data.families).toEqual(["filings"]);
    expect(r.json.data.filings.data.items.length).toBeLessThanOrEqual(2);
    expect(h.fetch.calls.some((c) => c.url.includes("category=accounts"))).toBe(true);
    const bad = await h.call("get_filings_and_insolvency", {
      identifier: "00445790",
      country: "GB",
      category: "x; drop",
    });
    expect(bad.isError).toBe(true);
  });

  it("shows insolvency cases and practitioners with the personal-data notice", async () => {
    h = await startHarness();
    const r = await h.call("get_filings_and_insolvency", {
      identifier: "NI017460",
      include: ["insolvency", "charges"],
    });
    const i = r.json.data.insolvency.data;
    expect(i.cases[0]).toMatchObject({ type: "compulsory-liquidation" });
    expect(i.cases[0].practitioners).toHaveLength(3);
    expect(r.json.data.charges.data.total).toBe(0);
    expect(r.json.disclaimer).toContain("personal data");
    expect(r.json.warnings.join(" ")).not.toContain("no insolvency case");
  });

  it("warns when the status is distressed but no insolvency case is listed", async () => {
    h = await startHarness({
      routes: { ...defaultRoutes(), [`${CH}/NI017460/insolvency`]: { status: 404, body: "" } },
    });
    const r = await h.call("get_filings_and_insolvency", {
      identifier: "NI017460",
      include: ["insolvency"],
    });
    expect(r.json.data.insolvency.data.cases).toEqual([]);
    expect(r.json.warnings.join(" ")).toContain("lists no insolvency case");
  });

  it("reports one failing family as an error and still returns the others", async () => {
    h = await startHarness({
      routes: { ...defaultRoutes(), [`${CH}/00445790/charges`]: { status: 500, body: "" } },
    });
    const r = await h.call("get_filings_and_insolvency", { identifier: "00445790", country: "GB" });
    expect(r.json.data.charges.state).toBe("error");
    expect(r.json.data.filings.state).toBe("available");
    expect(r.json.warnings.join(" ")).toContain("companies_house");
  });

  it("says why other countries and a missing key give nothing, never an empty list", async () => {
    h = await startHarness({ env: {} });
    const uk = await h.call("get_filings_and_insolvency", {
      identifier: "00445790",
      country: "GB",
    });
    // No key: the company can still be reached through GLEIF, but the register is switched off.
    expect(uk.isError ? uk.text : uk.json.data.filings.state).not.toBe("available");
    const no = await h.call("get_filings_and_insolvency", {
      identifier: "923609016",
      country: "NO",
    });
    expect(no.json.data.filings.state).toBe("not_yet_supported");
    expect(no.json.data.insolvency.state).toBe("not_yet_supported");
  });

  it("states filings and insolvency coverage in the entity profile", async () => {
    h = await startHarness();
    const uk = (await h.call("get_entity", { identifier: "00445790", country: "GB" })).json.data;
    expect(uk.coverage.families.filings).toMatchObject({
      state: "available",
      note: "Call get_filings_and_insolvency",
    });
    expect(uk.coverage.families.insolvency.state).toBe("available");
    const no = (await h.call("get_entity", { identifier: "923609016", country: "NO" })).json.data;
    expect(no.coverage.families.filings.state).toBe("not_yet_supported");
    const cov = await h.call("check_coverage", {});
    expect(cov.json.data.familiesSupported.join(" ")).toContain(
      "filings, charges, insolvency (GB: get_filings_and_insolvency)",
    );
  });
});
