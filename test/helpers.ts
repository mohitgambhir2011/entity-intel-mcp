import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterContext } from "../src/adapters/types.js";
import { Cache } from "../src/infra/cache.js";
import { HttpClient, type FetchLike } from "../src/infra/http.js";
import type { Clock } from "../src/infra/ratelimit.js";
import { MemoryStorage } from "../src/infra/storage/memory.js";

const here = dirname(fileURLToPath(import.meta.url));

export function fixtureText(path: string): string {
  return readFileSync(join(here, "fixtures", path), "utf8");
}

export interface FakeRoute {
  status?: number;
  body: string;
  headers?: Record<string, string>;
}

export interface FakeFetch extends FetchLike {
  calls: { url: string; headers: Record<string, string> }[];
}

/** Routes are matched by URL prefix. Unmatched URLs fail the test loudly. */
export function fakeFetch(routes: Record<string, FakeRoute | FakeRoute[]>): FakeFetch {
  const counters = new Map<string, number>();
  const fn = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fn.calls.push({ url, headers });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new Error(`unexpected request in test: ${url}`);
    const route = routes[key]!;
    const n = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    const r = Array.isArray(route) ? (route[Math.min(n, route.length - 1)] as FakeRoute) : route;
    const res = new Response(r.body, { status: r.status ?? 200, headers: r.headers });
    Object.defineProperty(res, "url", { value: url });
    return res;
  }) as FakeFetch;
  fn.calls = [];
  return fn;
}

export const instantClock = (start = 1_700_000_000_000): Clock & { advance(ms: number): void } => {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
};

export function makeCtx(fetchImpl: FetchLike, clock = instantClock()): AdapterContext {
  const storage = new MemoryStorage();
  return {
    http: new HttpClient({ fetch: fetchImpl, clock }),
    cache: new Cache(storage, 30 * 86400, clock.now),
    now: () => new Date(clock.now()),
  };
}
