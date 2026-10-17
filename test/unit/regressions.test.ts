// One test per defect found in the xhigh code review of src/ (2026-10-17). Each test fails on the
// code as it was before the fix.
import { describe, expect, it } from "vitest";
import { gleifAdapter } from "../../src/adapters/gleif/index.js";
import { viesAdapter } from "../../src/adapters/vies/index.js";
import { loadConfig } from "../../src/core/config.js";
import { detectIdentifier, makeIdentifier } from "../../src/core/identifiers.js";
import { fallbackEntityId } from "../../src/core/ids.js";
import type { PartialEntity, Provenance } from "../../src/core/types.js";
import { makeStatus } from "../../src/core/types.js";
import { Cache, NEGATIVE_TTL_SECONDS } from "../../src/infra/cache.js";
import { HttpClient } from "../../src/infra/http.js";
import { RateLimiter } from "../../src/infra/ratelimit.js";
import { MemoryStorage } from "../../src/infra/storage/memory.js";
import type { Storage } from "../../src/infra/storage/index.js";
import { normaliseName } from "../../src/resolution/normalise.js";
import { scoreName } from "../../src/resolution/score.js";
import { auditSubject } from "../../src/services/audit.js";
import { mergePartials } from "../../src/services/merge.js";
import { fakeFetch, instantClock, makeCtx } from "../helpers.js";

describe("review: company names are not VAT numbers", () => {
  it.each(["Deutsche Bank", "Dell Technologies", "Atos SE", "Italian Foods", "Elementis plc"])(
    "%s is not detected as an identifier",
    (name) => {
      expect(detectIdentifier(name)).toBeUndefined();
    },
  );

  it.each([
    "DE811128135",
    "NL820571204B01",
    "IE6388047V",
    "FR12345678901",
    "ATU12345678",
    "BE0417497106",
    "ESA12345678",
  ])("%s is still detected as a VAT number", (vat) => {
    expect(detectIdentifier(vat)).toMatchObject({ scheme: "VAT", value: vat });
  });
});

describe("review: non-Latin and non-decomposing letters survive normalisation", () => {
  it("folds Nordic and German letters", () => {
    expect(normaliseName("Ørsted A/S").key).toBe("orsted");
    expect(normaliseName("Æ Rederi AS").key).toBe("ae rederi");
    expect(normaliseName("Straße GmbH").key).toBe("strasse");
  });

  it("keeps Greek and Cyrillic names distinct instead of erasing them", () => {
    expect(normaliseName("Ελληνικά Πετρέλαια Α.Ε.").key).not.toBe("");
    expect(normaliseName("Ελληνικά Πετρέλαια").key).not.toBe(normaliseName("Τράπεζα Πειραιώς").key);
    expect(normaliseName("Софийска вода АД").key).not.toBe("");
    expect(scoreName("Ελληνικά Πετρέλαια", "Τράπεζα Πειραιώς").band).toBe("low");
  });

  it("gives different fallback ids to different non-Latin names", () => {
    expect(fallbackEntityId("Ελληνικά Πετρέλαια", "GR")).not.toBe(
      fallbackEntityId("Τράπεζα Πειραιώς", "GR"),
    );
  });
});

describe("review: VIES never reports an error as 'invalid'", () => {
  const url = "https://ec.europa.eu/taxation_customs/vies/rest-api/ms/FR/vat/12345678901";
  const id = makeIdentifier("VAT", "FR12345678901");

  it("treats an errorWrappers body as unavailable and does not cache it", async () => {
    const f = fakeFetch({
      [url]: {
        status: 400,
        body: JSON.stringify({ errorWrappers: [{ error: "MS_UNAVAILABLE" }] }),
      },
    });
    const ctx = makeCtx(f);
    await expect(viesAdapter.lookup(id, ctx)).rejects.toMatchObject({ kind: "unavailable" });
    await expect(viesAdapter.lookup(id, ctx)).rejects.toMatchObject({ kind: "unavailable" });
    expect(f.calls).toHaveLength(2); // second call went to the network: nothing was cached
  });

  it("treats a body without a boolean isValid as unavailable", async () => {
    const f = fakeFetch({ [url]: { body: JSON.stringify({ name: "X" }) } });
    await expect(viesAdapter.lookup(id, makeCtx(f))).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("review: rate limiter penalty", () => {
  it("waits for Retry-After after a 429 even when earlier requests are in the window", async () => {
    const clock = instantClock();
    const l = new RateLimiter({ max: 550, windowMs: 300_000 }, "ch", clock, 30_000);
    for (let i = 0; i < 100; i++) await l.acquire();
    clock.advance(60_000);
    const t0 = clock.now();
    l.penalise(10_000);
    await l.acquire(); // used to throw rate_limited (wait ~240 s > cap)
    expect(clock.now() - t0).toBe(10_000);
  });

  it("still fails fast when Retry-After exceeds the cap", async () => {
    const clock = instantClock();
    const l = new RateLimiter({ max: 5, windowMs: 1000 }, "x", clock, 30_000);
    l.penalise(120_000);
    await expect(l.acquire()).rejects.toMatchObject({ kind: "rate_limited" });
  });
});

describe("review: HTTP client redirects and body size", () => {
  it("does not follow a redirect to another host, so credential headers are not forwarded", async () => {
    const f = fakeFetch({
      "https://register.fca.org.uk/a": {
        status: 302,
        body: "",
        headers: { location: "https://evil.example/steal" },
      },
      "https://evil.example/": { body: "{}" },
    });
    const http = new HttpClient({ fetch: f, clock: instantClock() });
    await expect(
      http.getJson("https://register.fca.org.uk/a", {
        source: "fca",
        headers: { "x-auth-key": "SECRET" },
      }),
    ).rejects.toMatchObject({ kind: "bad_response" });
    expect(f.calls.map((c) => c.url)).toEqual(["https://register.fca.org.uk/a"]);
  });

  it("follows a same-host https redirect", async () => {
    const f = fakeFetch({
      "https://x.test/old": { status: 301, body: "", headers: { location: "/new" } },
      "https://x.test/new": { body: '{"ok":true}' },
    });
    const http = new HttpClient({ fetch: f, clock: instantClock() });
    const r = await http.getJson<{ ok: boolean }>("https://x.test/old", { source: "x" });
    expect(r.body.ok).toBe(true);
  });

  it("refuses an oversized body by content-length and by streaming", async () => {
    const f = fakeFetch({
      "https://x.test/declared": { body: "{}", headers: { "content-length": "999999999" } },
      "https://x.test/streamed": { body: JSON.stringify({ pad: "x".repeat(2000) }) },
    });
    const http = new HttpClient({ fetch: f, clock: instantClock(), maxBytes: 1000 });
    await expect(http.getJson("https://x.test/declared", { source: "x" })).rejects.toMatchObject({
      kind: "bad_response",
    });
    await expect(http.getJson("https://x.test/streamed", { source: "x" })).rejects.toMatchObject({
      kind: "bad_response",
    });
  });
});

describe("review: the cache never fails a lookup", () => {
  const broken = (over: Partial<Storage>): Storage =>
    ({ ...new MemoryStorage(), ...over }) as Storage;

  it("returns the fetched value when the storage cannot be written or read", async () => {
    const storage = broken({
      getCache: () => {
        throw new Error("database is locked");
      },
      putCache: () => {
        throw new Error("database is locked");
      },
    });
    const cache = new Cache(storage, 100);
    const r = await cache.getOrFetch("k", { ttlSeconds: 60, source: "s" }, async () => ({ a: 1 }));
    expect(r).toMatchObject({ value: { a: 1 }, fromCache: false });
  });

  it("treats a corrupt cached row as a miss", async () => {
    const storage = new MemoryStorage();
    storage.putCache({
      key: "k",
      value: "{not json",
      fetchedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      source: "s",
      personal: false,
    });
    const r = await new Cache(storage, 100).getOrFetch(
      "k",
      { ttlSeconds: 60, source: "s" },
      async () => 42,
    );
    expect(r).toMatchObject({ value: 42, fromCache: false });
  });

  it("caches 'not found' only briefly so new records appear quickly", async () => {
    const clock = instantClock();
    const storage = new MemoryStorage();
    const cache = new Cache(storage, 100, clock.now);
    await cache.getOrFetch("k", { ttlSeconds: 6 * 3600, source: "s" }, async () => null);
    const row = storage.getCache("k")!;
    expect(row.expiresAt - row.fetchedAt).toBe(NEGATIVE_TTL_SECONDS * 1000);
  });
});

describe("review: config values are range-checked", () => {
  it("rejects out-of-range thresholds and reports why", () => {
    const c = loadConfig({ EIM_SANCTIONS_MATCH: "95", EIM_AUDIT_RETENTION_DAYS: "-3" });
    expect(c.sanctionsMatch).toBe(0.95);
    expect(c.auditRetentionDays).toBe(365);
    expect(c.problems.join(" ")).toContain("EIM_SANCTIONS_MATCH");
    expect(c.problems.join(" ")).toContain("EIM_AUDIT_RETENTION_DAYS");
  });

  it("does not let the 'possible' threshold exceed the 'match' threshold", () => {
    const c = loadConfig({ EIM_SANCTIONS_MATCH: "0.9", EIM_SANCTIONS_POSSIBLE: "0.95" });
    expect(c.sanctionsPossible).toBeLessThanOrEqual(c.sanctionsMatch);
    expect(c.problems.length).toBeGreaterThan(0);
  });

  it("reports no problems for valid values", () => {
    expect(loadConfig({ EIM_SANCTIONS_MATCH: "0.9" }).problems).toEqual([]);
  });
});

describe("review: provenance only credits sources that actually agree", () => {
  const prov = (source: "companies_house" | "gleif"): Provenance => ({
    source,
    sourceRecordId: "1",
    retrievedAt: "2026-01-01T00:00:00Z",
    fromCache: false,
  });
  const partial = (
    source: "companies_house" | "gleif",
    status: ReturnType<typeof makeStatus>,
  ): PartialEntity => ({
    source,
    names: [],
    identifiers: [],
    status: { value: status, provenance: [prov(source)] },
    notes: [],
  });

  it("does not list a source that said 'unknown' as supporting the chosen status", () => {
    const merged = mergePartials(
      [
        partial("companies_house", makeStatus("dissolved", "dissolved")),
        partial("gleif", makeStatus("unknown", "INACTIVE")),
      ],
      [],
    );
    expect(merged.status?.value.normalized).toBe("dissolved");
    expect(merged.status?.provenance.map((p) => p.source)).toEqual(["companies_house"]);
    expect(merged.conflicts).toEqual([]);
  });

  it("still credits a source that agrees", () => {
    const merged = mergePartials(
      [
        partial("companies_house", makeStatus("active", "active")),
        partial("gleif", makeStatus("active", "ACTIVE")),
      ],
      [],
    );
    expect(merged.status?.provenance.map((p) => p.source).sort()).toEqual([
      "companies_house",
      "gleif",
    ]);
  });
});

describe("review: GLEIF responses are validated before use and caching", () => {
  it("rejects an error body instead of crashing or caching it", async () => {
    const url = "https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=";
    const f = fakeFetch({ [url]: { body: JSON.stringify({ errors: [{ title: "boom" }] }) } });
    const ctx = makeCtx(f);
    await expect(gleifAdapter.search!("Tesco", ctx, 5)).rejects.toMatchObject({
      kind: "bad_response",
    });
    await expect(gleifAdapter.search!("Tesco", ctx, 5)).rejects.toMatchObject({
      kind: "bad_response",
    });
    expect(f.calls).toHaveLength(2);
  });
});

describe("review: audit log does not store free-text names", () => {
  it("logs identifiers as typed and names as a hash", () => {
    expect(auditSubject("2138002P5RNKC5W2JZ46")).toBe("LEI:2138002P5RNKC5W2JZ46");
    const s = auditSubject("Jane Q. Smith Consulting");
    expect(s).toMatch(/^name#[0-9a-f]{12} \(\d+ chars\)$/);
    expect(s).not.toContain("Smith");
    expect(auditSubject("jane q. smith consulting")).toBe(s); // stable, case-insensitive
  });
});
