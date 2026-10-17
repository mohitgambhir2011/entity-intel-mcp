import { SourceError } from "../core/errors.js";
import { RateLimiter, systemClock, type Clock, type RateLimitRule } from "./ratelimit.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpResponse<T> {
  status: number;
  body: T;
  headers: Headers;
  url: string;
}

export interface HttpClientOptions {
  fetch?: FetchLike;
  clock?: Clock;
  userAgent?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Per-host limits. Hosts not listed use `defaultRule`. */
  rules?: Record<string, RateLimitRule>;
  defaultRule?: RateLimitRule;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Name used in errors and rate-limit messages, e.g. "companies_house". */
  source: string;
  /** Statuses that are returned to the caller instead of thrown (e.g. 404). */
  allowStatus?: number[];
}

const DEFAULT_RULE: RateLimitRule = { max: 5, windowMs: 1000 };

/**
 * Thin wrapper over fetch: per-host rate limiting, one retry on 429/5xx, timeouts, a response size
 * cap, and a refusal to follow redirects to another host. Secrets are never put in error messages.
 */
export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private readonly limiters = new Map<string, RateLimiter>();

  constructor(private readonly opts: HttpClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.clock = opts.clock ?? systemClock;
  }

  private limiter(host: string, source: string): RateLimiter {
    let l = this.limiters.get(host);
    if (!l) {
      const rule = this.opts.rules?.[host] ?? this.opts.defaultRule ?? DEFAULT_RULE;
      l = new RateLimiter(rule, source, this.clock);
      this.limiters.set(host, l);
    }
    return l;
  }

  /**
   * Sends the request without letting fetch follow redirects: automatic redirects would forward
   * custom credential headers (e.g. the FCA's X-Auth-Key) to whatever host is named. Only
   * same-host https redirects are followed, up to three hops.
   */
  private async fetchFollowingSameHostRedirects(
    startUrl: string,
    host: string,
    req: RequestOptions,
  ): Promise<Response> {
    let url = startUrl;
    for (let hop = 0; hop <= 3; hop++) {
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": this.opts.userAgent ?? "entity-intel-mcp",
          ...req.headers,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return res;

      const next = new URL(location, url);
      if (next.host !== host || next.protocol !== "https:") {
        throw new SourceError(
          `${req.source} redirected to another host or to an insecure URL`,
          req.source,
          "bad_response",
        );
      }
      url = next.toString();
    }
    throw new SourceError(`${req.source} redirected too many times`, req.source, "bad_response");
  }

  /** Reads the body but stops as soon as it exceeds the size cap, instead of buffering it all. */
  private async readBounded(res: Response, source: string): Promise<string> {
    const max = this.opts.maxBytes ?? 5_000_000;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > max) {
      throw new SourceError(`${source} response too large`, source, "bad_response");
    }
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new SourceError(`${source} response too large`, source, "bad_response");
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  async getJson<T = unknown>(url: string, req: RequestOptions): Promise<HttpResponse<T>> {
    const host = new URL(url).host;
    const limiter = this.limiter(host, req.source);
    let lastStatus = 0;

    for (let attempt = 0; attempt < 2; attempt++) {
      await limiter.acquire();
      let res: Response;
      try {
        res = await this.fetchFollowingSameHostRedirects(url, host, req);
      } catch (err) {
        // Policy errors (e.g. a refused redirect) are final: do not retry or relabel them.
        if (err instanceof SourceError) throw err;
        if (attempt === 0) {
          await this.clock.sleep(jitter(500));
          continue;
        }
        throw new SourceError(
          `${req.source} request failed: ${err instanceof Error ? err.name : "network error"}`,
          req.source,
          "unavailable",
        );
      }

      lastStatus = res.status;
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (res.status === 429) limiter.penalise(retryAfter ?? 1000);
        if (attempt === 0) {
          await this.clock.sleep(Math.min(retryAfter ?? jitter(1000), 10_000));
          continue;
        }
        break;
      }

      if ((res.status === 401 || res.status === 403) && !req.allowStatus?.includes(res.status)) {
        throw new SourceError(
          `${req.source} rejected the credentials or request (HTTP ${res.status})`,
          req.source,
          "auth",
        );
      }
      if (res.status === 404 && !req.allowStatus?.includes(404)) {
        throw new SourceError(`${req.source}: not found`, req.source, "not_found");
      }
      if (res.status >= 400 && !req.allowStatus?.includes(res.status)) {
        throw new SourceError(
          `${req.source} returned HTTP ${res.status}`,
          req.source,
          "bad_response",
        );
      }

      const text = await this.readBounded(res, req.source);
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new SourceError(`${req.source} returned invalid JSON`, req.source, "bad_response");
        }
      }
      return { status: res.status, body: body as T, headers: res.headers, url };
    }

    throw new SourceError(
      lastStatus === 429
        ? `${req.source} is rate limiting requests (HTTP 429)`
        : `${req.source} is unavailable (HTTP ${lastStatus || "no response"})`,
      req.source,
      lastStatus === 429 ? "rate_limited" : "unavailable",
    );
  }
}

function jitter(baseMs: number): number {
  return baseMs + Math.floor(Math.random() * baseMs * 0.5);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  return Number.isFinite(secs) ? Math.max(0, secs) * 1000 : undefined;
}

/** Host rules for the sources used so far. Companies House: 600 / 5 min (kept slightly under). */
export const DEFAULT_HOST_RULES: Record<string, RateLimitRule> = {
  "api.company-information.service.gov.uk": { max: 550, windowMs: 5 * 60_000 },
  "register.fca.org.uk": { max: 8, windowMs: 10_000 },
  "api.gleif.org": { max: 50, windowMs: 60_000 },
  "ec.europa.eu": { max: 20, windowMs: 10_000 },
};
