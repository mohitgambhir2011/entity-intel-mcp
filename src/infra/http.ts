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
  /** Default per-request timeout. */
  timeoutMs?: number;
  /** Default response size cap in bytes. */
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
  /** Overrides the client's size cap for this request (bulk downloads). */
  maxBytes?: number;
  /** Overrides the client's timeout for this request (bulk downloads). */
  timeoutMs?: number;
  /**
   * Host suffixes (e.g. ".amazonaws.com") the request may be redirected to over https. Only for
   * public downloads: custom headers are NOT forwarded to a different host.
   */
  allowRedirectHosts?: string[];
}

const DEFAULT_RULE: RateLimitRule = { max: 5, windowMs: 1000 };
const MAX_REDIRECTS = 3;

/**
 * Thin wrapper over fetch: per-host rate limiting, one retry on 429/5xx/network errors, timeouts, a
 * bounded body read, and a strict redirect policy. Secrets are never put in error messages.
 */
export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private readonly limiters = new Map<string, RateLimiter>();

  constructor(private readonly opts: HttpClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.clock = opts.clock ?? systemClock;
  }

  /** GET a JSON document. An empty body parses as `null`. */
  async getJson<T = unknown>(url: string, req: RequestOptions): Promise<HttpResponse<T>> {
    const res = await this.request(url, req, "application/json");
    const text = await this.readBounded(res, req);
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

  /** GET a text document (XML lists etc.), size-capped by `req.maxBytes`. */
  async getText(url: string, req: RequestOptions): Promise<HttpResponse<string>> {
    const res = await this.request(url, req, "application/xml, text/xml, text/plain, */*");
    const body = await this.readBounded(res, req);
    return { status: res.status, body, headers: res.headers, url };
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
   * Sends the request with rate limiting and one retry, and checks the status. Returns the response
   * with its body still unread.
   */
  private async request(url: string, req: RequestOptions, accept: string): Promise<Response> {
    const host = new URL(url).host;
    const limiter = this.limiter(host, req.source);
    let lastStatus = 0;

    for (let attempt = 0; attempt < 2; attempt++) {
      await limiter.acquire();
      let res: Response;
      try {
        res = await this.fetchFollowingRedirects(url, host, req, accept);
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
        await discard(res);
        if (attempt === 0) {
          await this.clock.sleep(Math.min(retryAfter ?? jitter(1000), 10_000));
          continue;
        }
        break;
      }

      if ((res.status === 401 || res.status === 403) && !req.allowStatus?.includes(res.status)) {
        await discard(res);
        throw new SourceError(
          `${req.source} rejected the credentials or request (HTTP ${res.status})`,
          req.source,
          "auth",
        );
      }
      if (res.status === 404 && !req.allowStatus?.includes(404)) {
        await discard(res);
        throw new SourceError(`${req.source}: not found`, req.source, "not_found");
      }
      if (res.status >= 400 && !req.allowStatus?.includes(res.status)) {
        await discard(res);
        throw new SourceError(
          `${req.source} returned HTTP ${res.status}`,
          req.source,
          "bad_response",
        );
      }
      return res;
    }

    throw new SourceError(
      lastStatus === 429
        ? `${req.source} is rate limiting requests (HTTP 429)`
        : `${req.source} is unavailable (HTTP ${lastStatus || "no response"})`,
      req.source,
      lastStatus === 429 ? "rate_limited" : "unavailable",
    );
  }

  /**
   * Sends the request without letting fetch follow redirects: automatic redirects would forward
   * custom credential headers (e.g. the FCA's X-Auth-Key) to whatever host is named. Same-host https
   * redirects are followed; a different host only if the caller listed it in `allowRedirectHosts`,
   * and then without the caller's custom headers. At most three hops.
   */
  private async fetchFollowingRedirects(
    startUrl: string,
    startHost: string,
    req: RequestOptions,
    accept: string,
  ): Promise<Response> {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const sameHost = new URL(url).host === startHost;
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept,
          "user-agent": this.opts.userAgent ?? "entity-intel-mcp",
          ...(sameHost ? req.headers : undefined),
        },
        redirect: "manual",
        signal: AbortSignal.timeout(req.timeoutMs ?? this.opts.timeoutMs ?? 20_000),
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return res;

      const next = new URL(location, url);
      const allowedElsewhere = req.allowRedirectHosts?.some((d) => hostMatches(next.hostname, d));
      if (next.protocol !== "https:" || (next.host !== startHost && !allowedElsewhere)) {
        throw new SourceError(
          `${req.source} redirected to another host or to an insecure URL`,
          req.source,
          "bad_response",
        );
      }
      await discard(res);
      url = next.toString();
    }
    throw new SourceError(`${req.source} redirected too many times`, req.source, "bad_response");
  }

  /** Reads the body but stops as soon as it exceeds the size cap, instead of buffering it all. */
  private async readBounded(res: Response, req: RequestOptions): Promise<string> {
    const max = req.maxBytes ?? this.opts.maxBytes ?? 5_000_000;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > max) {
      throw new SourceError(`${req.source} response too large`, req.source, "bad_response");
    }
    if (!res.body) return "";
    const reader = res.body.getReader();
    // Decode incrementally: keeping raw chunks, a concatenated buffer and the string would triple
    // the memory of a 50 MB download.
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new SourceError(`${req.source} response too large`, req.source, "bad_response");
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  }
}

/** Frees the connection of a response whose body we will not read. */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already closed or locked: nothing to free.
  }
}

/** True when `host` is `domain` or one of its subdomains ("x.amazonaws.com" for ".amazonaws.com"). */
export function hostMatches(host: string, domain: string): boolean {
  const bare = domain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  return h === bare || h.endsWith(`.${bare}`);
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
  // Sanctions bulk downloads: a handful of files per day is enough.
  "sanctionslist.fcdo.gov.uk": { max: 3, windowMs: 60_000 },
  "webgate.ec.europa.eu": { max: 3, windowMs: 60_000 },
  // No published limits (UNVERIFIED): conservative fair-use rates.
  "data.brreg.no": { max: 10, windowMs: 1000 },
  "avoindata.prh.fi": { max: 5, windowMs: 1000 },
  "opendata.cro.ie": { max: 5, windowMs: 1000 },
  "www.treasury.gov": { max: 3, windowMs: 60_000 },
};
