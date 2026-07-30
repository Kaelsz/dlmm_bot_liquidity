import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { config } from "../config/config.js";
import { logger } from "../utils/logger.js";
import type { BotDb } from "../db/database.js";

const run = promisify(execFile);

/**
 * Durable off-container state backup.
 *
 * The remote execution environment restores containers from periodic
 * snapshots; two paper runs were lost that way (up to 24h of positions and
 * scored opportunities). Git is the only storage that survives a rollback,
 * so the bot commits and pushes its own state on a timer rather than relying
 * on an external scheduler that may not fire while the container is asleep.
 *
 * Only the small, irreplaceable tables are exported — the bulky
 * pool_snapshots time series is left out to keep commits cheap.
 */
export class StateBackup {
  private running = false;

  constructor(
    private readonly db: BotDb,
    private readonly filePath = config.backup.exportPath,
    private readonly branch = config.backup.branch,
  ) {}

  /** Write the JSON export. Always safe to call; never throws. */
  export(): boolean {
    try {
      const sinceMs = Date.now() - config.backup.opportunityWindowMs;
      const state = {
        exportedAt: new Date().toISOString(),
        positions: this.db.db.prepare("SELECT * FROM positions ORDER BY id").all(),
        pnl: this.db.db.prepare("SELECT * FROM pnl ORDER BY position_id").all(),
        position_events: this.db.db.prepare("SELECT * FROM position_events ORDER BY id").all(),
        opportunities: this.db.db
          .prepare("SELECT * FROM opportunities WHERE ts >= ? ORDER BY id")
          .all(sinceMs),
      };
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(state));
      return true;
    } catch (err) {
      logger.warn({ err }, "state export failed");
      return false;
    }
  }

  /** Export, commit and push. Silent no-op when there is nothing new. */
  async push(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.export()) return;
      await run("git", ["add", "-f", this.filePath]);
      const { stdout } = await run("git", ["status", "--porcelain", "--", this.filePath]);
      if (stdout.trim() === "") return;
      await run("git", ["commit", "-q", "-m", "state backup (automatic)"]);
      await run("git", ["push", "-q", "-u", "origin", this.branch]);
      logger.info({ file: this.filePath }, "state backed up to git");
    } catch (err) {
      // A failed backup must never interrupt trading.
      logger.warn({ err }, "state backup push failed");
    } finally {
      this.running = false;
    }
  }
}
