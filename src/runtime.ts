import { adapterStatuses, buildAdapters, type AdapterStatus } from "./adapters/registry.js";
import type { SourceAdapter } from "./adapters/types.js";
import type { Config } from "./core/config.js";
import { AuditLog } from "./infra/audit.js";
import { Cache } from "./infra/cache.js";
import { DEFAULT_HOST_RULES, HttpClient, type FetchLike } from "./infra/http.js";
import type { Clock } from "./infra/ratelimit.js";
import {
  MemoryStorage,
  SqliteStorage,
  defaultDbPath,
  type Storage,
} from "./infra/storage/index.js";

export const USER_AGENT = "entity-intel-mcp/0.0.1";

export interface Runtime {
  config: Config;
  storage: Storage;
  http: HttpClient;
  cache: Cache;
  audit: AuditLog;
  /** Only adapters that are enabled and usable. */
  adapters: SourceAdapter[];
  statuses: AdapterStatus[];
  now: () => Date;
}

export interface RuntimeOverrides {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  storage?: Storage;
  clock?: Clock;
}

function openStorage(env: NodeJS.ProcessEnv): Storage {
  try {
    return new SqliteStorage(defaultDbPath(env));
  } catch (err) {
    console.error(
      "could not open the SQLite cache, using in-memory storage:",
      err instanceof Error ? err.message : err,
    );
    return new MemoryStorage();
  }
}

export function createRuntime(config: Config, overrides: RuntimeOverrides = {}): Runtime {
  const env = overrides.env ?? process.env;
  for (const problem of config.problems) console.error(`config: ${problem}`);
  const storage = overrides.storage ?? openStorage(env);
  const clockNow = overrides.clock ? () => overrides.clock!.now() : Date.now;

  const http = new HttpClient({
    fetch: overrides.fetch,
    clock: overrides.clock,
    userAgent: USER_AGENT,
    rules: DEFAULT_HOST_RULES,
  });
  const cache = new Cache(storage, config.personalDataTtlDays * 86_400, clockNow);
  const audit = new AuditLog(storage, config.auditRetentionDays, clockNow);

  const statuses = adapterStatuses(config, env);
  const adapters = buildAdapters(config, statuses);

  // Housekeeping: drop expired cache rows and audit rows past retention (D11, D14).
  try {
    storage.purgeExpired(clockNow());
    audit.purge();
  } catch (err) {
    console.error("storage housekeeping failed:", err instanceof Error ? err.message : err);
  }

  return {
    config,
    storage,
    http,
    cache,
    audit,
    adapters,
    statuses,
    now: () => new Date(clockNow()),
  };
}
