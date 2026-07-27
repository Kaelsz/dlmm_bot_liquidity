import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config/config.js";
import type { Protocol } from "../types/datapi.js";

/**
 * SQLite persistence.
 *
 * Tables:
 *  - pools:            static-ish metadata per pool (upserted on scan)
 *  - pool_snapshots:   time series of cumulative fees / tvl / price used to
 *                      derive the high-frequency fees-per-minute signal
 *  - opportunities:    every scored evaluation with full decomposition
 *  - positions:        paper + live position lifecycle
 *  - position_events:  append-only event log per position
 *  - pnl:              final accounting per closed position
 *  - rugcheck_cache:   fail-closed verdict cache
 */

export interface SnapshotRow {
  pool_address: string;
  protocol: Protocol;
  ts: number;
  tvl: number;
  current_price: number;
  dynamic_fee_pct: number | null;
  cum_fees_usd: number;
  cum_volume_usd: number;
  fees_30m: number;
  volume_30m: number;
  fee_tvl_30m: number;
  source: "broad" | "fast";
}

export interface PositionRow {
  id: number;
  pool_address: string;
  protocol: Protocol;
  mode: "PAPER" | "LIVE";
  status: "OPEN" | "CLOSED";
  pool_name: string;
  opened_at: number;
  closed_at: number | null;
  entry_price: number;
  exit_price: number | null;
  size_usd: number;
  lower_price: number;
  upper_price: number;
  bin_range: number;
  entry_fee_rate_usd_min: number;
  onchain_address: string | null;
  tx_open: string | null;
  tx_close: string | null;
  exit_reason: string | null;
}

export class BotDb {
  readonly db: Database.Database;

  constructor(path: string = config.storage.dbPath) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pools (
        address TEXT PRIMARY KEY,
        protocol TEXT NOT NULL,
        name TEXT NOT NULL,
        token_x_mint TEXT NOT NULL,
        token_y_mint TEXT NOT NULL,
        token_x_symbol TEXT NOT NULL,
        token_y_symbol TEXT NOT NULL,
        bin_step INTEGER,
        base_fee_pct REAL NOT NULL DEFAULT 0,
        collect_fee_mode INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pool_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_address TEXT NOT NULL,
        protocol TEXT NOT NULL,
        ts INTEGER NOT NULL,
        tvl REAL NOT NULL,
        current_price REAL NOT NULL,
        dynamic_fee_pct REAL,
        cum_fees_usd REAL NOT NULL,
        cum_volume_usd REAL NOT NULL,
        fees_30m REAL NOT NULL,
        volume_30m REAL NOT NULL,
        fee_tvl_30m REAL NOT NULL,
        source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_pool_ts ON pool_snapshots(pool_address, ts);

      CREATE TABLE IF NOT EXISTS opportunities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        pool_address TEXT NOT NULL,
        protocol TEXT NOT NULL,
        pool_name TEXT NOT NULL,
        score REAL NOT NULL,
        instant_fee_rate_usd_min REAL NOT NULL,
        instant_heat_pct_hr REAL NOT NULL,
        fee_acceleration REAL NOT NULL,
        turnover_30m REAL NOT NULL,
        stability REAL NOT NULL,
        expected_fees_usd REAL NOT NULL,
        expected_il_usd REAL NOT NULL,
        fixed_costs_usd REAL NOT NULL,
        expected_net_usd REAL NOT NULL,
        breakeven_min REAL NOT NULL,
        decision TEXT NOT NULL,
        reject_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_opps_ts ON opportunities(ts);

      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_address TEXT NOT NULL,
        protocol TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        pool_name TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        entry_price REAL NOT NULL,
        exit_price REAL,
        size_usd REAL NOT NULL,
        lower_price REAL NOT NULL,
        upper_price REAL NOT NULL,
        bin_range INTEGER NOT NULL,
        entry_fee_rate_usd_min REAL NOT NULL,
        onchain_address TEXT,
        tx_open TEXT,
        tx_close TEXT,
        exit_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

      CREATE TABLE IF NOT EXISTS position_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_position ON position_events(position_id);

      CREATE TABLE IF NOT EXISTS pnl (
        position_id INTEGER PRIMARY KEY,
        fees_claimed_usd REAL NOT NULL,
        il_usd REAL NOT NULL,
        tx_costs_usd REAL NOT NULL,
        slippage_usd REAL NOT NULL,
        net_pnl_usd REAL NOT NULL,
        holding_minutes REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rugcheck_cache (
        mint TEXT PRIMARY KEY,
        checked_at INTEGER NOT NULL,
        verdict TEXT NOT NULL,
        score_normalised REAL,
        reason TEXT
      );
    `);
  }

  // ---- pools & snapshots -------------------------------------------------

  upsertPool(p: {
    address: string;
    protocol: Protocol;
    name: string;
    tokenXMint: string;
    tokenYMint: string;
    tokenXSymbol: string;
    tokenYSymbol: string;
    binStep: number | undefined;
    baseFeePct: number;
    collectFeeMode: number;
    createdAt: number;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO pools (address, protocol, name, token_x_mint, token_y_mint, token_x_symbol, token_y_symbol,
           bin_step, base_fee_pct, collect_fee_mode, created_at, first_seen_at, last_seen_at)
         VALUES (@address, @protocol, @name, @tokenXMint, @tokenYMint, @tokenXSymbol, @tokenYSymbol,
           @binStep, @baseFeePct, @collectFeeMode, @createdAt, @now, @now)
         ON CONFLICT(address) DO UPDATE SET last_seen_at=@now, name=@name, base_fee_pct=@baseFeePct`,
      )
      .run({ ...p, binStep: p.binStep ?? null, now });
  }

  insertSnapshot(s: SnapshotRow): void {
    this.db
      .prepare(
        `INSERT INTO pool_snapshots (pool_address, protocol, ts, tvl, current_price, dynamic_fee_pct,
           cum_fees_usd, cum_volume_usd, fees_30m, volume_30m, fee_tvl_30m, source)
         VALUES (@pool_address, @protocol, @ts, @tvl, @current_price, @dynamic_fee_pct,
           @cum_fees_usd, @cum_volume_usd, @fees_30m, @volume_30m, @fee_tvl_30m, @source)`,
      )
      .run(s);
  }

  recentSnapshots(poolAddress: string, limit: number): SnapshotRow[] {
    return this.db
      .prepare(
        `SELECT * FROM pool_snapshots WHERE pool_address = ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(poolAddress, limit) as SnapshotRow[];
  }

  pruneSnapshots(olderThanMs: number): number {
    const r = this.db
      .prepare(`DELETE FROM pool_snapshots WHERE ts < ?`)
      .run(Date.now() - olderThanMs);
    return r.changes;
  }

  // ---- opportunities -----------------------------------------------------

  insertOpportunity(o: {
    ts: number;
    poolAddress: string;
    protocol: Protocol;
    poolName: string;
    score: number;
    instantFeeRateUsdMin: number;
    instantHeatPctHr: number;
    feeAcceleration: number;
    turnover30m: number;
    stability: number;
    expectedFeesUsd: number;
    expectedIlUsd: number;
    fixedCostsUsd: number;
    expectedNetUsd: number;
    breakevenMin: number;
    decision: "ENTER" | "SKIP";
    rejectReason: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO opportunities (ts, pool_address, protocol, pool_name, score,
           instant_fee_rate_usd_min, instant_heat_pct_hr, fee_acceleration, turnover_30m, stability,
           expected_fees_usd, expected_il_usd, fixed_costs_usd, expected_net_usd, breakeven_min,
           decision, reject_reason)
         VALUES (@ts, @poolAddress, @protocol, @poolName, @score,
           @instantFeeRateUsdMin, @instantHeatPctHr, @feeAcceleration, @turnover30m, @stability,
           @expectedFeesUsd, @expectedIlUsd, @fixedCostsUsd, @expectedNetUsd, @breakevenMin,
           @decision, @rejectReason)`,
      )
      .run(o);
  }

  // ---- positions ---------------------------------------------------------

  createPosition(p: Omit<PositionRow, "id" | "closed_at" | "exit_price" | "tx_close" | "exit_reason">): number {
    const r = this.db
      .prepare(
        `INSERT INTO positions (pool_address, protocol, mode, status, pool_name, opened_at,
           entry_price, size_usd, lower_price, upper_price, bin_range, entry_fee_rate_usd_min,
           onchain_address, tx_open)
         VALUES (@pool_address, @protocol, @mode, @status, @pool_name, @opened_at,
           @entry_price, @size_usd, @lower_price, @upper_price, @bin_range, @entry_fee_rate_usd_min,
           @onchain_address, @tx_open)`,
      )
      .run(p);
    return Number(r.lastInsertRowid);
  }

  closePosition(id: number, exitPrice: number, exitReason: string, txClose: string | null): void {
    this.db
      .prepare(
        `UPDATE positions SET status='CLOSED', closed_at=?, exit_price=?, exit_reason=?, tx_close=? WHERE id=?`,
      )
      .run(Date.now(), exitPrice, exitReason, txClose, id);
  }

  openPositions(mode?: "PAPER" | "LIVE"): PositionRow[] {
    if (mode) {
      return this.db
        .prepare(`SELECT * FROM positions WHERE status='OPEN' AND mode=? ORDER BY opened_at`)
        .all(mode) as PositionRow[];
    }
    return this.db
      .prepare(`SELECT * FROM positions WHERE status='OPEN' ORDER BY opened_at`)
      .all() as PositionRow[];
  }

  closedPositions(sinceMs = 0): PositionRow[] {
    return this.db
      .prepare(`SELECT * FROM positions WHERE status='CLOSED' AND closed_at >= ? ORDER BY closed_at`)
      .all(sinceMs) as PositionRow[];
  }

  addPositionEvent(positionId: number, kind: string, data: unknown): void {
    this.db
      .prepare(`INSERT INTO position_events (position_id, ts, kind, data) VALUES (?, ?, ?, ?)`)
      .run(positionId, Date.now(), kind, JSON.stringify(data ?? {}));
  }

  // ---- pnl ---------------------------------------------------------------

  upsertPnl(row: {
    positionId: number;
    feesClaimedUsd: number;
    ilUsd: number;
    txCostsUsd: number;
    slippageUsd: number;
    netPnlUsd: number;
    holdingMinutes: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO pnl (position_id, fees_claimed_usd, il_usd, tx_costs_usd, slippage_usd, net_pnl_usd, holding_minutes)
         VALUES (@positionId, @feesClaimedUsd, @ilUsd, @txCostsUsd, @slippageUsd, @netPnlUsd, @holdingMinutes)
         ON CONFLICT(position_id) DO UPDATE SET
           fees_claimed_usd=@feesClaimedUsd, il_usd=@ilUsd, tx_costs_usd=@txCostsUsd,
           slippage_usd=@slippageUsd, net_pnl_usd=@netPnlUsd, holding_minutes=@holdingMinutes`,
      )
      .run(row);
  }

  // ---- rugcheck cache ----------------------------------------------------

  getRugcheckVerdict(mint: string, ttlMs: number): { verdict: string; reason: string | null } | undefined {
    const row = this.db
      .prepare(`SELECT verdict, reason, checked_at FROM rugcheck_cache WHERE mint=?`)
      .get(mint) as { verdict: string; reason: string | null; checked_at: number } | undefined;
    if (!row) return undefined;
    if (Date.now() - row.checked_at > ttlMs) return undefined;
    return { verdict: row.verdict, reason: row.reason };
  }

  setRugcheckVerdict(mint: string, verdict: string, scoreNormalised: number | null, reason: string | null): void {
    this.db
      .prepare(
        `INSERT INTO rugcheck_cache (mint, checked_at, verdict, score_normalised, reason)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(mint) DO UPDATE SET checked_at=excluded.checked_at, verdict=excluded.verdict,
           score_normalised=excluded.score_normalised, reason=excluded.reason`,
      )
      .run(mint, Date.now(), verdict, scoreNormalised, reason);
  }

  close(): void {
    this.db.close();
  }
}
