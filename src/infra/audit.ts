import type { AuditRow, Storage } from "./storage/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One metadata row per tool call (D14). Never stores result bodies. */
export class AuditLog {
  constructor(
    private readonly storage: Storage,
    private readonly retentionDays: number,
    private readonly now: () => number = Date.now,
  ) {}

  record(entry: Omit<AuditRow, "at">): void {
    try {
      this.storage.addAudit({ ...entry, at: this.now() });
    } catch (err) {
      // Auditing must never break a lookup, but the failure should be visible on stderr.
      console.error("audit log write failed:", err instanceof Error ? err.message : err);
    }
  }

  purge(): number {
    return this.storage.purgeAudit(this.now() - this.retentionDays * DAY_MS);
  }
}
