import { describe, expect, it } from "vitest";
import {
  fetchOfficerAppointments,
  mapAppointment,
} from "../../src/adapters/companies-house/people.js";
import { fakeFetch, fixtureText, makeCtx } from "../helpers.js";

const CH = "https://api.company-information.service.gov.uk";
const headers = { Authorization: "Basic eA==" };

describe("officer appointments (D49)", () => {
  it("maps role, dates and status, and skips an entry with no usable company number", () => {
    expect(
      mapAppointment({
        appointed_to: {
          company_number: "sc000003",
          company_name: "X",
          company_status: "dissolved",
        },
        appointed_on: "2015-01-01",
        resigned_on: "2019-12-31",
        officer_role: "secretary",
      }),
    ).toMatchObject({
      companyNumber: "SC000003",
      role: "secretary",
      active: false,
      resignedOn: "2019-12-31",
    });
    expect(mapAppointment({ appointed_to: { company_name: "NO NUMBER" } })).toBeUndefined();
  });

  it("returns appointments with counts, provenance and a cache hit on the second read", async () => {
    const f = fakeFetch({
      [`${CH}/officers/abc/appointments`]: {
        body: fixtureText("companies_house/officer-appointments.json"),
      },
    });
    const ctx = makeCtx(f);
    const r = await fetchOfficerAppointments(ctx, headers, "abc");
    expect(r!.appointments).toHaveLength(3); // the entry without a number is skipped
    expect(r!.total).toBe(4);
    expect(r!.activeCount).toBe(2);
    expect(r!.provenance).toMatchObject({ source: "companies_house", fromCache: false });
    expect((await fetchOfficerAppointments(ctx, headers, "abc"))!.provenance.fromCache).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  it("REGRESSION: counts are not claimed complete when the register holds more than was read", async () => {
    const page = (n: number) =>
      JSON.stringify({
        total_results: 500,
        items: Array.from({ length: n }, (_, i) => ({
          appointed_to: { company_number: String(10000000 + i).slice(0, 8) },
          officer_role: "director",
        })),
      });
    const f = fakeFetch({ [`${CH}/officers/big/appointments`]: [{ body: page(50) }] });
    const r = await fetchOfficerAppointments(makeCtx(f), headers, "big");
    expect(f.calls).toHaveLength(3); // hard stop at 3 pages
    expect(r!.total).toBe(500);
    expect(r!.truncated).toBe(true);
  });

  it("REGRESSION: an unknown id is undefined (not zero appointments) and is not cached as a fact", async () => {
    const f = fakeFetch({ [`${CH}/officers/nope/appointments`]: { status: 404, body: "" } });
    expect(await fetchOfficerAppointments(makeCtx(f), headers, "nope")).toBeUndefined();
  });

  it("REGRESSION: an id that could alter the URL is refused before any request", async () => {
    const f = fakeFetch({});
    expect(await fetchOfficerAppointments(makeCtx(f), headers, "a/../b")).toBeUndefined();
    expect(await fetchOfficerAppointments(makeCtx(f), headers, "a?x=1")).toBeUndefined();
    expect(f.calls).toHaveLength(0);
  });

  it("rejects a malformed body rather than reporting no appointments", async () => {
    const f = fakeFetch({
      [`${CH}/officers/bad/appointments`]: { body: JSON.stringify({ nope: 1 }) },
    });
    await expect(fetchOfficerAppointments(makeCtx(f), headers, "bad")).rejects.toThrow(
      /unexpected appointments response/,
    );
  });
});
