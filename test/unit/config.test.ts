import { describe, expect, it } from "vitest";
import { adapterStatuses } from "../../src/adapters/registry.js";
import { loadConfig } from "../../src/core/config.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig({});
    expect(c.personalDataTtlDays).toBe(30);
    expect(c.sanctionsMatch).toBe(0.95);
    expect(c.adapterAllowList).toBeUndefined();
  });

  it("parses the adapter allow-list and ignores blanks", () => {
    const c = loadConfig({ EIM_ADAPTERS: " GB, no ,," });
    expect(c.adapterAllowList).toEqual(["gb", "no"]);
  });

  it("falls back on non-numeric thresholds", () => {
    expect(loadConfig({ EIM_SANCTIONS_MATCH: "abc" }).sanctionsMatch).toBe(0.95);
  });
});

describe("adapterStatuses", () => {
  it("reports missing credentials by variable name only", () => {
    const s = adapterStatuses(loadConfig({}), {}).find((a) => a.id === "gb");
    expect(s?.enabled).toBe(false);
    expect(s?.reason).toContain("COMPANIES_HOUSE_API_KEY");
  });

  it("never includes credential values", () => {
    const env = { COMPANIES_HOUSE_API_KEY: "secret-value" };
    const json = JSON.stringify(adapterStatuses(loadConfig(env), env));
    expect(json).not.toContain("secret-value");
  });

  it("respects the allow-list", () => {
    const s = adapterStatuses(loadConfig({ EIM_ADAPTERS: "no" }), {}).find((a) => a.id === "fi");
    expect(s?.reason).toContain("allow-list");
  });
});
