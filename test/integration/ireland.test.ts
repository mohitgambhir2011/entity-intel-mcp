import { afterEach, describe, expect, it } from "vitest";
import { defaultRoutes, startHarness, type Harness } from "../harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const LEI = "635400BR2ROC1FVEBQ56";

describe("Ireland through the tools", () => {
  it("builds a profile from the CRO and GLEIF with an Irish entity id", async () => {
    h = await startHarness({ env: {} });
    const r = await h.call("get_entity", { identifier: "249885", country: "IE" });
    expect(r.isError).toBe(false);
    const p = r.json.data;
    expect(p.entityId).toBe("IE:CRO:249885");
    expect(p.aliases).toEqual([`ID:LEI:${LEI}`]);
    expect(p.identifiers.map((i: any) => `${i.scheme}=${i.value}`).sort()).toEqual([
      `IE_CRO=249885`,
      `LEI=${LEI}`,
    ]);
    expect(p.names[0].name).toBe("RYANAIR HOLDINGS PUBLIC LIMITED COMPANY");
    expect(p.status.value).toMatchObject({ normalized: "active", group: "operating" });
    expect(p.legalForm.value.normalized).toBe("public_company");
    expect(r.json.meta.sourcesQueried.sort()).toEqual(["cro_ie", "gleif"]);
  });

  it("reaches the same entity from its LEI, entity id and explicit scheme", async () => {
    h = await startHarness({ env: {} });
    expect((await h.call("get_entity", { identifier: LEI })).json.data.entityId).toBe(
      "IE:CRO:249885",
    );
    expect((await h.call("get_entity", { entity_id: "IE:CRO:249885" })).json.data.entityId).toBe(
      "IE:CRO:249885",
    );
    const s = await h.call("get_entity", { identifier: "0249885", scheme: "IE_CRO" });
    expect(s.json.data.entityId).toBe("IE:CRO:249885");
    expect((await h.call("get_entity", { identifier: "249885" })).isError).toBe(true);
    const bad = await h.call("get_entity", { identifier: "12x", scheme: "IE_CRO" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Irish company number");
  });

  it("reports dissolved and liquidated companies by their status group", async () => {
    h = await startHarness({ env: {} });
    const dis = await h.call("get_entity", { identifier: "279457", scheme: "IE_CRO" });
    expect(dis.json.data.status.value).toMatchObject({ normalized: "dissolved", group: "ended" });
    expect(dis.json.data.dissolutionDate.value).toBe("2000-06-30");
    const liq = await h.call("get_entity", { identifier: "283902", scheme: "IE_CRO" });
    expect(liq.json.data.status.value.group).toBe("distressed");
  });

  it("searches only the Irish register for country=IE", async () => {
    h = await startHarness();
    const r = await h.call("search_entities", { query: "Ryanair", country: "IE" });
    expect(r.json.meta.sourcesQueried.sort()).toEqual(["cro_ie", "gleif"]);
    expect(r.json.data.candidates[0]).toMatchObject({ jurisdiction: "IE" });
    expect(r.json.data.candidates[0].entityId.startsWith("IE:CRO:")).toBe(true);
    const gb = await h.call("search_entities", { query: "Ryanair", country: "GB" });
    expect(gb.json.meta.sourcesQueried).not.toContain("cro_ie");
  });

  it("says why Irish owners are unavailable and what is not built yet", async () => {
    h = await startHarness({ env: {} });
    const own = await h.call("get_ownership", { identifier: "249885", country: "IE" });
    expect(own.json.data.ownership).toMatchObject({
      state: "unavailable",
      reason: "restricted_access",
    });
    const off = await h.call("get_officers", { identifier: "249885", country: "IE" });
    expect(off.json.data.officers.state).toBe("not_yet_supported");
    const e = (await h.call("get_entity", { identifier: "249885", country: "IE" })).json.data;
    expect(e.coverage.families.ownership.state).toBe("unavailable");
    expect(e.coverage.families.officers.state).toBe("not_yet_supported");
  });

  it("falls back to GLEIF with a warning when the CRO is down", async () => {
    h = await startHarness({
      env: {},
      routes: {
        ...defaultRoutes(),
        "https://opendata.cro.ie/api/3/action/package_show": { status: 500, body: "" },
      },
    });
    const r = await h.call("get_entity", { identifier: LEI });
    expect(r.isError).toBe(false);
    expect(r.json.data.names[0].provenance.map((p: any) => p.source)).toEqual(["gleif"]);
    expect(r.json.warnings.join(" ")).toContain("cro_ie");
  });
});
