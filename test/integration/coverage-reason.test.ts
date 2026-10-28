import { afterEach, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../harness.js";

// E7: get_entity's per-family coverage carries a machine-readable `reason` when a family is
// unavailable, in the same vocabulary as the family tools (D28), so clients need not read prose.

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const families = async (identifier: string, country: string) =>
  (await h!.call("get_entity", { identifier, country })).json.data.coverage.families;

describe("profile coverage carries a reason for unavailable families (E7)", () => {
  it("Norway: ownership is restricted_access; officers, being available, carry no reason", async () => {
    h = await startHarness();
    const f = await families("923609016", "NO");
    expect(f.ownership).toMatchObject({ state: "unavailable", reason: "restricted_access" });
    expect(f.officers.state).toBe("available");
    expect("reason" in f.officers).toBe(false);
  });

  it("Finland: officers are not_published_by_source, ownership is restricted_access", async () => {
    h = await startHarness({ env: {} });
    const f = await families("0112038-9", "FI");
    expect(f.officers).toMatchObject({ state: "unavailable", reason: "not_published_by_source" });
    expect(f.ownership).toMatchObject({ state: "unavailable", reason: "restricted_access" });
  });

  it("Ireland: ownership is restricted_access; officers are not yet supported and have no reason", async () => {
    h = await startHarness({ env: {} });
    const f = await families("249885", "IE");
    expect(f.ownership).toMatchObject({ state: "unavailable", reason: "restricted_access" });
    expect(f.officers.state).toBe("not_yet_supported");
    expect("reason" in f.officers).toBe(false);
  });

  it("UK without a Companies House key: every key-bound family says requires_credentials", async () => {
    h = await startHarness({ env: {} });
    const f = await families("00445790", "GB");
    for (const family of ["officers", "ownership", "filings", "insolvency"]) {
      expect(f[family], family).toMatchObject({
        state: "unavailable",
        reason: "requires_credentials",
      });
    }
  });

  it("UK with a key but no FCA account: regulatory is requires_credentials", async () => {
    h = await startHarness();
    const f = await families("00445790", "GB");
    expect(f.regulatory).toMatchObject({ state: "unavailable", reason: "requires_credentials" });
    expect("reason" in f.officers).toBe(false); // available
  });

  it("a source switched off with EIM_ADAPTERS says not_enabled", async () => {
    h = await startHarness({ env: { EIM_ADAPTERS: "gleif,vies,gb-fca" } });
    // Companies House is off, so the UK number can only be looked up through the LEI route.
    const e = (await h.call("get_entity", { identifier: "2138002P5RNKC5W2JZ46" })).json.data;
    const f = e.coverage.families;
    expect(f.officers.state).toBe("unavailable");
    expect(f.officers.reason).toBe("not_enabled"); // switched off, not a missing key
  });

  it("REGRESSION honesty: the reason in the profile equals the reason the family tool gives", async () => {
    h = await startHarness();
    const no = await families("923609016", "NO");
    const own = await h.call("get_ownership", { identifier: "923609016", country: "NO" });
    expect(own.json.data.ownership.reason).toBe(no.ownership.reason);

    const fi = await families("0112038-9", "FI");
    const off = await h.call("get_officers", { identifier: "0112038-9", country: "FI" });
    expect(off.json.data.officers.reason).toBe(fi.officers.reason);
  });

  it("only the unavailable state carries a reason (never available, error or not_yet_supported)", async () => {
    h = await startHarness();
    for (const [id, cc] of [
      ["00445790", "GB"],
      ["923609016", "NO"],
      ["0112038-9", "FI"],
      ["249885", "IE"],
    ] as const) {
      const f = await families(id, cc);
      for (const [name, fam] of Object.entries<any>(f)) {
        if (fam.state !== "unavailable") {
          expect("reason" in fam, `${cc} ${name} (${fam.state})`).toBe(false);
        } else {
          expect(typeof fam.reason, `${cc} ${name}`).toBe("string");
        }
      }
    }
  });
});
