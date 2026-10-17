import { afterEach, describe, expect, it } from "vitest";
import { defaultRoutes, startHarness, type Harness } from "../harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const F = "https://register.fca.org.uk/services/V0.1";
const withFca = {
  COMPANIES_HOUSE_API_KEY: "k",
  FCA_AUTH_EMAIL: "a@b.test",
  FCA_AUTH_KEY: "k",
};

describe("get_regulatory_status", () => {
  it("finds an FCA-authorised company from its Companies House number", async () => {
    h = await startHarness({ env: withFca });
    const r = await h.call("get_regulatory_status", { identifier: "09740322", country: "GB" });
    expect(r.isError).toBe(false);
    const d = r.json.data.regulatory;
    expect(d.state).toBe("available");
    expect(d.data).toMatchObject({
      frn: "759676",
      status: "Authorised",
      matchedBy: "companies_house_number",
    });
    expect(d.data.regulators.map((x: any) => x.name)).toContain("Prudential Regulation Authority");
    expect(r.json.data.company.entityId).toBe("GB:CH:09740322");
    expect(r.json.summary).toContain("Found on the FCA Register");
  });

  it("starts from a firm reference number and reaches the company profile", async () => {
    h = await startHarness({ env: withFca });
    const r = await h.call("get_regulatory_status", { identifier: "759676", scheme: "FCA_FRN" });
    expect(r.json.data.company.entityId).toBe("GB:CH:09740322");
    expect(r.json.data.regulatory.data.matchedBy).toBe("frn");
    const e = await h.call("get_entity", { entity_id: "GB:FCA:759676" });
    expect(e.json.data.entityId).toBe("GB:CH:09740322");
    expect(e.json.data.identifiers.map((i: any) => i.scheme)).toContain("FCA_FRN");
    const bad = await h.call("get_entity", { identifier: "12", scheme: "FCA_FRN" });
    expect(bad.isError).toBe(true);
  });

  it("does not call a company unregulated just because no firm was found", async () => {
    h = await startHarness({ env: withFca });
    const r = await h.call("get_regulatory_status", { identifier: "00445790", country: "GB" });
    expect(r.json.data.regulatory).toMatchObject({
      state: "unavailable",
      reason: "no_such_record",
    });
    expect(r.json.data.regulatory.detail).toContain("not proof");
  });

  it("names the missing credentials, and does not blame them for other families", async () => {
    h = await startHarness();
    const r = await h.call("get_regulatory_status", { identifier: "00445790", country: "GB" });
    expect(r.json.data.regulatory).toMatchObject({
      state: "unavailable",
      reason: "requires_credentials",
    });
    expect(r.json.data.regulatory.detail).toContain("FCA_AUTH_EMAIL");
    const o = await h.call("get_officers", { identifier: "00445790", country: "GB" });
    expect(o.json.data.officers.state).toBe("available");
  });

  it("is not yet supported outside the UK", async () => {
    h = await startHarness({ env: withFca });
    const r = await h.call("get_regulatory_status", { identifier: "923609016", country: "NO" });
    expect(r.json.data.regulatory.state).toBe("not_yet_supported");
  });

  it("reports an outage as an error, not as 'not regulated'", async () => {
    h = await startHarness({
      env: withFca,
      routes: { ...defaultRoutes(), [`${F}/Search?q=BARCLAYS`]: { status: 500, body: "" } },
    });
    const r = await h.call("get_regulatory_status", { identifier: "09740322", country: "GB" });
    expect(r.json.data.regulatory.state).toBe("error");
    expect(r.json.warnings.join(" ")).toContain("fca");
  });

  it("states regulatory coverage per company and in check_coverage", async () => {
    h = await startHarness({ env: withFca });
    const uk = (await h.call("get_entity", { identifier: "09740322", country: "GB" })).json.data;
    expect(uk.coverage.families.regulatory).toMatchObject({
      state: "available",
      note: "Call get_regulatory_status",
    });
    const no = (await h.call("get_entity", { identifier: "923609016", country: "NO" })).json.data;
    expect(no.coverage.families.regulatory.state).toBe("not_yet_supported");
    const cov = await h.call("check_coverage", {});
    expect(cov.json.data.familiesSupported.join(" ")).toContain(
      "regulatory status (GB: get_regulatory_status)",
    );
    await h.close();
    h = await startHarness();
    const bare = (await h.call("get_entity", { identifier: "00445790", country: "GB" })).json.data;
    expect(bare.coverage.families.regulatory.state).toBe("unavailable");
  });
});
