import { afterEach, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../harness.js";
import { fixtureText } from "../helpers.js";

const CH = "https://api.company-information.service.gov.uk";
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("get_officer_appointments (D49)", () => {
  it("returns appointments and counts, with the register's person id never written to the audit log", async () => {
    h = await startHarness({
      routes: {
        [`${CH}/officers/secretref123/appointments`]: {
          body: fixtureText("companies_house/officer-appointments.json"),
        },
      },
    });
    const r = await h.call("get_officer_appointments", { officer_ref: "secretref123" });
    expect(r.isError).toBe(false);
    const a = r.json.data.appointments;
    expect(a.state).toBe("available");
    expect(a.data).toMatchObject({ total: 4, activeCount: 2, skipped: 1, truncated: false });
    expect(r.json.warnings.join(" ")).toMatch(/no usable company number/);
    expect(r.json.disclaimer).toMatch(/personal data/i);
    const rows = JSON.stringify(h.rt.storage.listAudit(5));
    expect(rows).toContain("get_officer_appointments");
    expect(rows).not.toContain("secretref123");
  });

  it("REGRESSION: an unknown person id is unavailable (no_such_record), never zero appointments", async () => {
    h = await startHarness({
      routes: { [`${CH}/officers/unknown1/appointments`]: { status: 404, body: "" } },
    });
    const r = await h.call("get_officer_appointments", { officer_ref: "unknown1" });
    expect(r.json.data.appointments).toMatchObject({
      state: "unavailable",
      reason: "no_such_record",
    });
  });

  it("REGRESSION: an id that could alter the URL is an input error and makes no request", async () => {
    h = await startHarness({ routes: {} });
    const r = await h.call("get_officer_appointments", { officer_ref: "../company/00445790" });
    expect(r.isError).toBe(true);
    expect(h.fetch.calls).toHaveLength(0);
  });

  it("without a Companies House key it says so, rather than reporting nothing", async () => {
    h = await startHarness({ env: {}, routes: {} });
    const r = await h.call("get_officer_appointments", { officer_ref: "abc" });
    expect(r.json.data.appointments).toMatchObject({
      state: "unavailable",
      reason: "requires_credentials",
    });
  });
});
