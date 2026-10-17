import { describe, expect, it } from "vitest";
import { Cache } from "../../src/infra/cache.js";
import { HttpClient } from "../../src/infra/http.js";
import { MemoryStorage } from "../../src/infra/storage/memory.js";
import { ListIndex, SanctionsIndex } from "../../src/sanctions/index.js";
import { parseEu } from "../../src/sanctions/parsers/eu.js";
import { parseOfac } from "../../src/sanctions/parsers/ofac.js";
import { parseUk } from "../../src/sanctions/parsers/uk.js";
import type { SanctionEntry } from "../../src/sanctions/types.js";
import { extractIdentifiers, unescapeXml } from "../../src/sanctions/xml.js";
import { sanctionsRoutes } from "../harness.js";
import { fakeFetch, fixtureText, instantClock } from "../helpers.js";

const THRESHOLDS = { match: 0.95, possible: 0.8 };

describe("xml helpers", () => {
  it("decodes standard and numeric entities without expanding anything else", () => {
    expect(unescapeXml("Smith &amp; Sons &#233; &#x41; &unknown;")).toBe(
      "Smith & Sons é A &unknown;",
    );
  });

  it("extracts registration-looking tokens from free text only", () => {
    expect(extractIdentifiers("(1) Kazakhstan BIN - 170440031562")).toEqual(["170440031562"]);
    expect(extractIdentifiers("Registered in London, see website")).toEqual([]);
  });
});

describe("parsers (real samples)", () => {
  it("UK: reads names, aliases with quality, company numbers, ships; ignores personal documents", () => {
    const { entries, versionDate } = parseUk(fixtureText("sanctions/uk-sample.xml"));
    expect(versionDate).toBe("2026-10-16");
    expect(entries.map((e) => e.entryId).sort()).toEqual([
      "AFG0007",
      "AFG0009",
      "BEL0107",
      "DPR0075",
    ]);

    const person = entries.find((e) => e.entryId === "AFG0007")!;
    expect(person.subjectType).toBe("person");
    expect(person.names[0]).toMatchObject({ name: "Abdul Kabir MOHAMMAD JAN", primary: true });
    expect(person.names.some((n) => !n.primary && n.name === "A Kabir")).toBe(true);
    expect(person.identifiers).toEqual([]); // passports / ids are not read
    expect(person.listedOn).toBe("2001-01-25");

    const company = entries.find((e) => e.entryId === "BEL0107")!;
    expect(company).toMatchObject({ subjectType: "entity", identifiers: ["06527449"] });
    expect(company.names.map((n) => n.name)).toContain("BNK UK Limited");
    expect(company.countries).toEqual(["United Kingdom"]);

    expect(entries.find((e) => e.entryId === "DPR0075")).toMatchObject({
      subjectType: "vessel",
      identifiers: ["IMO9562233"],
    });
    expect(entries.some((e) => e.names.some((n) => !n.strong))).toBe(true); // low-quality alias kept, flagged
  });

  it("EU: reads aliases, programmes and the generation date; ignores personal documents", () => {
    const { entries, versionDate } = parseEu(fixtureText("sanctions/eu-sample.xml"));
    expect(entries).toHaveLength(3);
    expect(versionDate).toBe("2026-10-15");
    const saddam = entries.find((e) => e.entryId === "EU.27.28")!;
    expect(saddam).toMatchObject({ subjectType: "person", programmes: ["IRQ"], identifiers: [] });
    expect(saddam.names[0]).toMatchObject({ name: "Saddam Hussein Al-Tikriti", primary: true });
    const org = entries.find((e) => e.entryId === "EU.620.38")!;
    expect(org.subjectType).toBe("entity");
    expect(org.identifiers).toEqual(["363823186"]);
  });

  it("OFAC: names, aliases with quality, company numbers; no free-text 'identifiers'", () => {
    const { entries, versionDate } = parseOfac(fixtureText("sanctions/ofac-sample.xml"));
    expect(versionDate).toBe("2026-10-15");
    expect(entries.map((e) => e.entryId)).toEqual(["36", "906", "2674", "4238"]);
    const bank = entries.find((e) => e.entryId === "906")!;
    expect(bank.identifiers.sort()).toEqual(["01074897", "HAVIGB2L"]);
    expect(bank.names.map((n) => n.name)).toContain("HAVANA INTERNATIONAL BANK, LTD");
    const person = entries.find((e) => e.entryId === "2674")!;
    expect(person.subjectType).toBe("person");
    expect(person.identifiers).toEqual([]);
    expect(entries.find((e) => e.entryId === "4238")!.subjectType).toBe("vessel");
  });

  it.each([
    ["UK", parseUk],
    ["EU", parseEu],
    ["OFAC", parseOfac],
  ])("%s: rejects a document that is not the expected list", (_n, parse) => {
    expect(() => parse("<html><body>Maintenance</body></html>")).toThrow(/unexpected format/);
  });
});

const entry = (
  over: Partial<SanctionEntry> & { names: SanctionEntry["names"] },
): SanctionEntry => ({
  list: "OFAC_SDN",
  entryId: "1",
  subjectType: "entity",
  identifiers: [],
  programmes: ["TEST"],
  countries: [],
  ...over,
});
const n = (name: string, primary = true, strong = true) => ({ name, primary, strong });

describe("matching", () => {
  const index = new ListIndex("OFAC_SDN", [
    entry({
      entryId: "bank",
      names: [n("HAVIN BANK LIMITED"), n("Havana International Bank", false)],
      identifiers: ["01074897"],
    }),
    entry({ entryId: "gaz", names: [n("Gazprom Neft PJSC")] }),
    entry({
      entryId: "per",
      subjectType: "person",
      names: [n("Ivan Petrov"), n("Vanya Petrov", false, false)],
    }),
    entry({ entryId: "short", names: [n("ABC")] }),
  ]);
  const screen = (
    names: string[],
    opts: { ids?: string[]; kind?: "person" | "entity" | "any" } = {},
  ) => index.screen({ names, identifiers: opts.ids ?? [], kind: opts.kind ?? "any" }, THRESHOLDS);

  it("matches an identical name regardless of case, punctuation and legal form", () => {
    const [hit] = screen(["havin bank ltd"]);
    expect(hit).toMatchObject({ entryId: "bank", score: 1, basis: "exact_name" });
  });

  it("matches a listed alias and says so", () => {
    expect(screen(["Havana International Bank"])[0]).toMatchObject({
      entryId: "bank",
      basis: "alias",
    });
  });

  it("matches the same words in a different order (surname-first lists)", () => {
    expect(screen(["Petrov Ivan"])[0]).toMatchObject({ entryId: "per", score: 0.98 });
  });

  it("finds a misspelling as a possible match, below the match threshold", () => {
    const [hit] = screen(["Gazprm Neft"]);
    expect(hit?.entryId).toBe("gaz");
    expect(hit!.score).toBeGreaterThanOrEqual(0.8);
    expect(hit!.score).toBeLessThan(0.95);
    expect(hit!.basis).toBe("fuzzy_name");
  });

  it("matches on an exact registration number even when the name differs", () => {
    const [hit] = screen(["Totally Different Name Ltd"], { ids: ["01074897"] });
    expect(hit).toMatchObject({ entryId: "bank", score: 1, basis: "exact_identifier" });
    // Short numbers (7 digits, e.g. IMO numbers) collide across countries and are never matched.
    expect(screen([], { ids: ["1074897"] })).toEqual([]);
  });

  it("does not match short or unrelated names", () => {
    expect(screen(["ABC"])[0]?.entryId).toBe("short"); // identical short names do match exactly
    expect(screen(["ABD"])).toEqual([]); // but fuzzy matching is off for very short names
    // Found by a live run: a single wrong letter in a short name is noise, not a possible match.
    expect(
      new ListIndex("EU", [entry({ list: "EU", entryId: "f", names: [n("FESCO")] })]).screen(
        { names: ["Tesco PLC"], identifiers: [], kind: "any" },
        THRESHOLDS,
      ),
    ).toEqual([]);
    expect(screen(["Sainsbury's Bank plc"])).toEqual([]);
    expect(screen(["Bank"])).toEqual([]); // a single common word is never enough
  });

  it("caps a match on a low-quality alias below the match threshold", () => {
    const [hit] = screen(["Vanya Petrov"]);
    expect(hit).toMatchObject({ entryId: "per", weakAlias: true });
    expect(hit!.score).toBeLessThan(0.95);
  });

  it("respects the subject kind", () => {
    expect(screen(["Ivan Petrov"], { kind: "entity" })).toEqual([]);
    expect(screen(["Ivan Petrov"], { kind: "person" })[0]?.entryId).toBe("per");
  });

  it("matches Greek and Cyrillic names (not erased by normalisation)", () => {
    const idx = new ListIndex("EU", [
      entry({ list: "EU", entryId: "ru", names: [n("Газпром нефть")] }),
    ]);
    const hit = idx.screen({ names: ["ГАЗПРОМ НЕФТЬ"], identifiers: [], kind: "any" }, THRESHOLDS);
    expect(hit[0]).toMatchObject({ entryId: "ru", score: 1 });
    expect(
      idx.screen({ names: ["Ελληνικά Πετρέλαια"], identifiers: [], kind: "any" }, THRESHOLDS),
    ).toEqual([]);
  });
});

describe("SanctionsIndex", () => {
  function setup(routes = sanctionsRoutes(), minEntries = 1) {
    const clock = instantClock();
    const f = fakeFetch(routes);
    const http = new HttpClient({ fetch: f, clock });
    const cache = new Cache(new MemoryStorage(), 86400, clock.now);
    const idx = new SanctionsIndex({ http, cache, now: clock.now, minEntries });
    return { idx, f, clock };
  }

  it("downloads, parses and serves a list, following the OFAC redirect to its CDN", async () => {
    const { idx, f } = setup();
    const ofac = await idx.get("OFAC_SDN");
    expect(ofac).toMatchObject({ versionDate: "2026-10-15", entries: 4 });
    expect(f.calls.map((c) => new URL(c.url).host)).toEqual([
      "www.treasury.gov",
      "wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com",
    ]);
  });

  it("downloads each list once, then serves from memory and from the cache", async () => {
    const { idx, f } = setup();
    await Promise.all([idx.get("UK"), idx.get("UK"), idx.get("UK")]);
    await idx.get("UK");
    expect(f.calls).toHaveLength(1);
  });

  it("re-downloads on fresh=true", async () => {
    const { idx, f } = setup();
    await idx.get("EU");
    await idx.get("EU", { fresh: true });
    expect(f.calls).toHaveLength(2);
  });

  it("rejects a list that looks truncated and does not cache it", async () => {
    const { idx, f } = setup(sanctionsRoutes(), 100);
    await expect(idx.get("EU")).rejects.toMatchObject({ kind: "bad_response" });
    await expect(idx.get("EU")).rejects.toMatchObject({ kind: "bad_response" });
    expect(f.calls).toHaveLength(2); // not cached: the second call downloaded again
    expect(idx.status().find((s) => s.list === "EU")).toMatchObject({ state: "error" });
  });

  it("refuses to follow a redirect to an unexpected host", async () => {
    const routes = sanctionsRoutes();
    routes["https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml"] = {
      status: 302,
      body: "",
      headers: { location: "https://evil.example/ConList.xml" },
    };
    const { idx } = setup(routes);
    await expect(idx.get("UK")).rejects.toMatchObject({ kind: "bad_response" });
  });

  it("measures staleness from download time, not from when the list was indexed", async () => {
    const { idx, f, clock } = setup();
    await idx.get("EU");
    clock.advance(25 * 3600 * 1000); // past the 24 h lifetime
    const again = await idx.get("EU");
    expect(f.calls).toHaveLength(2);
    expect(again.fromCache).toBe(false);
  });

  it("reports whether a list came from memory/cache or was downloaded", async () => {
    const { idx } = setup();
    expect((await idx.get("EU")).fromCache).toBe(false);
    expect((await idx.get("EU")).fromCache).toBe(true);
  });

  it("reports load state per list", async () => {
    const { idx } = setup();
    expect(idx.status().every((s) => s.state === "not_loaded")).toBe(true);
    await idx.get("UK");
    expect(idx.status().find((s) => s.list === "UK")).toMatchObject({
      state: "loaded",
      entries: 4,
    });
  });

  it("warmFromCache never touches the network", async () => {
    const { idx, f } = setup();
    idx.warmFromCache();
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls).toHaveLength(0);
    expect(idx.status().every((s) => s.state === "not_loaded")).toBe(true);
  });
});
