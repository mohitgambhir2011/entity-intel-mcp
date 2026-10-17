import type { AuditRow, CacheRow, Storage } from "./index.js";

/** Non-persistent storage: used in tests and as a fallback if SQLite cannot be opened. */
export class MemoryStorage implements Storage {
  private readonly cache = new Map<string, CacheRow>();
  private audit: AuditRow[] = [];

  getCache(key: string): CacheRow | undefined {
    return this.cache.get(key);
  }
  putCache(row: CacheRow): void {
    this.cache.set(row.key, row);
  }
  deleteCache(key: string): void {
    this.cache.delete(key);
  }
  purgeExpired(now: number): number {
    let n = 0;
    for (const [k, v] of this.cache) {
      if (v.expiresAt <= now) {
        this.cache.delete(k);
        n++;
      }
    }
    return n;
  }
  clearCache(): void {
    this.cache.clear();
  }
  addAudit(row: AuditRow): void {
    this.audit.push(row);
  }
  listAudit(limit: number): AuditRow[] {
    return this.audit.slice(-limit).reverse();
  }
  purgeAudit(olderThan: number): number {
    const before = this.audit.length;
    this.audit = this.audit.filter((r) => r.at >= olderThan);
    return before - this.audit.length;
  }
  close(): void {}
}
