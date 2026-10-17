import { describe, expect, it } from "vitest";
import { SourceError } from "../../src/core/errors.js";
import { AuditLog } from "../../src/infra/audit.js";
import { Cache } from "../../src/infra/cache.js";
import { HttpClient } from "../../src/infra/http.js";
import { RateLimiter } from "../../src/infra/ratelimit.js";
import { MemoryStorage } from "../../src/infra/storage/memory.js";
import { SqliteStorage } from "../../src/infra/storage/sqlite.js";
import { fakeFetch, instantClock } from "../helpers.js";

describe("RateLimiter", () => {
  it("lets max requests through immediately, then waits for the window", async () => {
    const clock = instantClock();
    const l = new RateLimiter({ max: 2, windowMs: 1000 }, "t", clock);
    const t0 = clock.now();
    await l.acquire();
    await l.acquire();
    await l.acquire();
    expect(clock.now() - t0).toBeGreaterThanOrEqual(1000);
  });

  it("fails fast instead of waiting longer than the cap", async () => {
    const clock = instantClock();
    const l = new RateLimiter({ max: 1, windowMs: 300_000 }, "ch", clock, 30_000);
    await l.acquire();
    await expect(l.acquire()).rejects.toMatchObject({ kind: "rate_limited" });
  });
});

describe("HttpClient", () => {
  it("retries once on 503 and then succeeds", async () => {
    const f = fakeFetch({
      "https://x.test/a": [{ status: 503, body: "" }, { body: '{"ok":true}' }],
    });
    const http = new HttpClient({ fetch: f, clock: instantClock() });
    const r = await http.getJson<{ ok: boolean }>("https://x.test/a", { source: "x" });
    expect(r.body.ok).toBe(true);
    expect(f.calls).toHaveLength(2);
  });

  it("gives up after one retry with an unavailable error", async () => {
    const f = fakeFetch({ "https://x.test/a": { status: 500, body: "" } });
    const http = new HttpClient({ fetch: f, clock: instantClock() });
    await expect(http.getJson("https://x.test/a", { source: "x" })).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(f.calls).toHaveLength(2);
  });

  it("reports 429 as rate_limited", async () => {
    const f = fakeFetch({
      "https://x.test/a": { status: 429, body: "", headers: { "retry-after": "1" } },
    });
    const http = new HttpClient({ fetch: f, clock: instantClock() });
    await expect(http.getJson("https://x.test/a", { source: "x" })).rejects.toMatchObject({
      kind: "rate_limited",
    });
  });

  it("maps 401 to an auth error without leaking headers", async () => {
    const f = fakeFetch({ "https://x.test/a": { status: 401, body: "" } });
    const http = new HttpClient({ fetch: f, clock: instantClock() });
    const err = await http
      .getJson("https://x.test/a", { source: "x", headers: { authorization: "Basic SECRET" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).kind).toBe("auth");
    expect((err as SourceError).message).not.toContain("SECRET");
  });

  it("returns allowed statuses to the caller", async () => {
    const f = fakeFetch({ "https://x.test/a": { status: 404, body: "" } });
    const http = new HttpClient({ fetch: f, clock: instantClock() });
    const r = await http.getJson("https://x.test/a", { source: "x", allowStatus: [404] });
    expect(r.status).toBe(404);
  });

  it("rejects invalid JSON", async () => {
    const f = fakeFetch({ "https://x.test/a": { body: "<html>" } });
    const http = new HttpClient({ fetch: f, clock: instantClock() });
    await expect(http.getJson("https://x.test/a", { source: "x" })).rejects.toMatchObject({
      kind: "bad_response",
    });
  });
});

describe.each([
  ["memory", () => new MemoryStorage()],
  ["sqlite", () => new SqliteStorage(":memory:")],
])("Cache over %s storage", (_name, make) => {
  it("serves within TTL, refetches after, and honours fresh", async () => {
    const clock = instantClock();
    const cache = new Cache(make(), 1000, clock.now);
    let n = 0;
    const fetcher = async () => ({ n: ++n });
    const opts = { ttlSeconds: 60, source: "s" };

    expect((await cache.getOrFetch("k", opts, fetcher)).fromCache).toBe(false);
    const hit = await cache.getOrFetch("k", opts, fetcher);
    expect(hit).toMatchObject({ fromCache: true, value: { n: 1 } });

    expect((await cache.getOrFetch("k", { ...opts, fresh: true }, fetcher)).value).toEqual({
      n: 2,
    });

    clock.advance(61_000);
    expect((await cache.getOrFetch("k", opts, fetcher)).value).toEqual({ n: 3 });
  });

  it("never serves expired data when the refresh fails (D28)", async () => {
    const clock = instantClock();
    const cache = new Cache(make(), 1000, clock.now);
    const opts = { ttlSeconds: 10, source: "s" };
    await cache.getOrFetch("k", opts, async () => 1);
    clock.advance(11_000);
    await expect(
      cache.getOrFetch("k", opts, async () => {
        throw new Error("source down");
      }),
    ).rejects.toThrow("source down");
  });

  it("caps personal data to the personal TTL (D11)", async () => {
    const clock = instantClock();
    const storage = make();
    const cache = new Cache(storage, 5, clock.now);
    await cache.getOrFetch("p", { ttlSeconds: 3600, source: "s", personal: true }, async () => 1);
    const row = storage.getCache("p")!;
    expect(row.expiresAt - row.fetchedAt).toBe(5000);
    expect(row.personal).toBe(true);
  });

  it("purges expired rows and audit entries by retention", () => {
    const storage = make();
    const clock = instantClock();
    storage.putCache({
      key: "a",
      value: "1",
      fetchedAt: 0,
      expiresAt: 10,
      source: "s",
      personal: false,
    });
    expect(storage.purgeExpired(20)).toBe(1);

    const audit = new AuditLog(storage, 1, clock.now);
    audit.record({ tool: "t", subject: "00445790", sources: ["gleif"], cacheHit: false });
    clock.advance(2 * 86400_000);
    expect(audit.purge()).toBe(1);
    expect(storage.listAudit(10)).toHaveLength(0);
  });
});
