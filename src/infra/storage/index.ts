export interface CacheRow {
  key: string;
  value: string;
  fetchedAt: number;
  expiresAt: number;
  source: string;
  personal: boolean;
}

export interface AuditRow {
  at: number;
  tool: string;
  /** Identifier or search string as supplied by the caller (D14: metadata only, no results). */
  subject: string;
  sources: string[];
  cacheHit: boolean;
}

/** Everything the server persists. Swap implementations without touching callers (D31). */
export interface Storage {
  getCache(key: string): CacheRow | undefined;
  putCache(row: CacheRow): void;
  deleteCache(key: string): void;
  /** Remove expired cache rows; returns how many were removed. */
  purgeExpired(now: number): number;
  clearCache(): void;
  addAudit(row: AuditRow): void;
  listAudit(limit: number): AuditRow[];
  purgeAudit(olderThan: number): number;
  close(): void;
}

export { MemoryStorage } from "./memory.js";
export { SqliteStorage, defaultDbPath } from "./sqlite.js";
