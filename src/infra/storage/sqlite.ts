import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuditRow, CacheRow, Storage } from "./index.js";

export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EIM_DB_PATH && env.EIM_DB_PATH.trim() !== "") return env.EIM_DB_PATH;
  const base =
    process.platform === "win32"
      ? (env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
      : (env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));
  return join(base, "entity-intel-mcp", "entity-intel.db");
}

interface CacheDbRow {
  key: string;
  value: string;
  fetched_at: number;
  expires_at: number;
  source: string;
  personal: number;
}

interface AuditDbRow {
  at: number;
  tool: string;
  subject: string;
  sources: string;
  cache_hit: number;
}

export class SqliteStorage implements Storage {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        personal INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS cache_expires ON cache(expires_at);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        tool TEXT NOT NULL,
        subject TEXT NOT NULL,
        sources TEXT NOT NULL,
        cache_hit INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
    `);
  }

  getCache(key: string): CacheRow | undefined {
    const r = this.db.prepare("SELECT * FROM cache WHERE key = ?").get(key) as
      CacheDbRow | undefined;
    if (!r) return undefined;
    return {
      key: r.key,
      value: r.value,
      fetchedAt: r.fetched_at,
      expiresAt: r.expires_at,
      source: r.source,
      personal: r.personal === 1,
    };
  }

  putCache(row: CacheRow): void {
    this.db
      .prepare(
        `INSERT INTO cache (key, value, fetched_at, expires_at, source, personal)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at,
           expires_at = excluded.expires_at, source = excluded.source, personal = excluded.personal`,
      )
      .run(row.key, row.value, row.fetchedAt, row.expiresAt, row.source, row.personal ? 1 : 0);
  }

  deleteCache(key: string): void {
    this.db.prepare("DELETE FROM cache WHERE key = ?").run(key);
  }

  purgeExpired(now: number): number {
    return Number(this.db.prepare("DELETE FROM cache WHERE expires_at <= ?").run(now).changes);
  }

  clearCache(): void {
    this.db.exec("DELETE FROM cache");
  }

  addAudit(row: AuditRow): void {
    this.db
      .prepare("INSERT INTO audit (at, tool, subject, sources, cache_hit) VALUES (?, ?, ?, ?, ?)")
      .run(row.at, row.tool, row.subject, JSON.stringify(row.sources), row.cacheHit ? 1 : 0);
  }

  listAudit(limit: number): AuditRow[] {
    const rows = this.db
      .prepare("SELECT at, tool, subject, sources, cache_hit FROM audit ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as AuditDbRow[];
    return rows.map((r) => ({
      at: r.at,
      tool: r.tool,
      subject: r.subject,
      sources: JSON.parse(r.sources) as string[],
      cacheHit: r.cache_hit === 1,
    }));
  }

  purgeAudit(olderThan: number): number {
    return Number(this.db.prepare("DELETE FROM audit WHERE at < ?").run(olderThan).changes);
  }

  close(): void {
    this.db.close();
  }
}
