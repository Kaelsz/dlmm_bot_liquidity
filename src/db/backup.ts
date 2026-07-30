import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { config } from "../config/config.js";
import { logger } from "../utils/logger.js";
import type { BotDb } from "../db/database.js";

const run = promisify(execFile);

type Row = Record<string, unknown>;

/**
 * Merge previously exported rows with the current ones, keyed by a natural
 * key rather than the SQLite rowid: after a snapshot rollback the database
 * goes back in time and re-issues ids, so an id-keyed merge would silently
 * drop or alias rows. Current rows win on conflict.
 */
function merge(previous: Row[], current: Row[], key: (row: Row) => string): Row[] {
  const byKey = new Map<string, Row>();
  for (const row of previous) byKey.set(key(row), row);
  for (const row of current) byKey.set(key(row), row);
  return [...byKey.values()];
}

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}

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

  /** Read whatever is already on disk, so a rolled-back DB cannot shrink it. */
  private previous(): Record<string, unknown> {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, unknown>;
    } catch (err) {
      logger.warn({ err }, "previous state export unreadable, starting fresh");
      return {};
    }
  }

  /** Write the JSON export. Always safe to call; never throws. */
  export(): boolean {
    try {
      const sinceMs = Date.now() - config.backup.opportunityWindowMs;
      const prev = this.previous();
      // Positions carry their pnl inline: after a rollback the position ids are
      // reused, so a separate pnl array keyed by position_id would mis-join.
      const positions = this.db.db
        .prepare(
          `SELECT p.*, n.fees_claimed_usd, n.il_usd, n.tx_costs_usd, n.slippage_usd,
                  n.net_pnl_usd, n.holding_minutes
             FROM positions p LEFT JOIN pnl n ON n.position_id = p.id
            ORDER BY p.opened_at`,
        )
        .all() as Row[];
      const events = this.db.db.prepare("SELECT * FROM position_events ORDER BY ts").all() as Row[];
      const opportunities = this.db.db
        .prepare("SELECT * FROM opportunities WHERE ts >= ? ORDER BY ts")
        .all(sinceMs) as Row[];

      const state = {
        exportedAt: new Date().toISOString(),
        positions: merge(
          asRows(prev.positions),
          positions,
          (r) => `${String(r.pool_address)}|${String(r.opened_at)}`,
        ),
        position_events: merge(
          asRows(prev.position_events),
          events,
          (r) => `${String(r.ts)}|${String(r.kind)}|${String(r.data)}`,
        ),
        opportunities: merge(
          asRows(prev.opportunities),
          opportunities,
          (r) => `${String(r.ts)}|${String(r.pool_address)}`,
        ).filter((r) => Number(r.ts) >= sinceMs),
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
