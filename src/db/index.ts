import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "@/config";
import { SCHEMA } from "@/db/schema.sql";
import type { DerivedMetrics } from "@/data/metrics";
import type { PoolView } from "@/types/meteora";

export interface LeaderboardRow {
  address: string;
  protocol: string;
  name: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tokenXMint: string;
  binStep: number | null;
  baseFeePct: number;
  dynamicFeePct: number | null;
  createdAt: number;
  isBlacklisted: number;
  launchpad: string | null;
  tokenXHolders: number;
  tokenXVerified: number;
  tokenXFreezeDisabled: number;
  ts: number;
  feeRateUsdMin: number;
  heatPctHr: number;
  feeAccel: number;
  hotStreak: number;
  sampleCount: number;
  sparklineJson: string;
  tvl: number;
  price: number;
  volume30m: number;
  fees30m: number;
  feeTvl30mPct: number;
  feeTvl24hPct: number;
  apyPct: number | null;
}

export interface LeaderboardFilters {
  minTvl?: number;
  maxTvl?: number;
  minHeat?: number;
  maxAgeMinutes?: number;
  protocol?: "dlmm" | "damm_v2";
  excludeBlacklisted?: boolean;
  /** Only pools whose metrics were refreshed within this window. */
  freshWithinMs?: number;
  sort?: "heat" | "rate" | "tvl" | "volume" | "age" | "accel";
  limit?: number;
}

export class RadarDb {
  readonly db: Database.Database;

  constructor(path = config.storage.dbPath) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  // ---- writes ------------------------------------------------------------

  private readonly upsertPoolStmt = this.db.prepare(`
    INSERT INTO pools (
      address, protocol, name,
      token_x_mint, token_x_symbol, token_x_decimals, token_x_holders,
      token_x_verified, token_x_freeze_disabled, token_x_market_cap,
      token_y_mint, token_y_symbol, token_y_decimals,
      bin_step, base_fee_pct, collect_fee_mode, created_at,
      first_seen_at, last_seen_at, is_blacklisted, launchpad, tags
    ) VALUES (
      @address, @protocol, @name,
      @tokenXMint, @tokenXSymbol, @tokenXDecimals, @tokenXHolders,
      @tokenXVerified, @tokenXFreezeDisabled, @tokenXMarketCap,
      @tokenYMint, @tokenYSymbol, @tokenYDecimals,
      @binStep, @baseFeePct, @collectFeeMode, @createdAt,
      @now, @now, @isBlacklisted, @launchpad, @tags
    )
    ON CONFLICT(address) DO UPDATE SET
      last_seen_at = @now,
      name = @name,
      base_fee_pct = @baseFeePct,
      token_x_holders = @tokenXHolders,
      token_x_market_cap = @tokenXMarketCap,
      is_blacklisted = @isBlacklisted
  `);

  upsertPool(p: PoolView, now = Date.now()): void {
    this.upsertPoolStmt.run({
      address: p.address,
      protocol: p.protocol,
      name: p.name,
      tokenXMint: p.tokenX.address,
      tokenXSymbol: p.tokenX.symbol,
      tokenXDecimals: p.tokenX.decimals,
      tokenXHolders: p.tokenX.holders,
      tokenXVerified: p.tokenX.is_verified ? 1 : 0,
      tokenXFreezeDisabled: p.tokenX.freeze_authority_disabled ? 1 : 0,
      tokenXMarketCap: p.tokenX.market_cap,
      tokenYMint: p.tokenY.address,
      tokenYSymbol: p.tokenY.symbol,
      tokenYDecimals: p.tokenY.decimals,
      binStep: p.binStep ?? null,
      baseFeePct: p.baseFeePct,
      collectFeeMode: p.collectFeeMode,
      createdAt: p.createdAtMs,
      now,
      isBlacklisted: p.isBlacklisted ? 1 : 0,
      launchpad: p.launchpad,
      tags: JSON.stringify(p.tags),
    });
  }

  private readonly insertSampleStmt = this.db.prepare(`
    INSERT INTO pool_samples (
      pool_address, ts, tvl, price, cum_fees_usd, cum_volume_usd,
      fees_30m, volume_30m, fee_tvl_30m_pct,
      reserve_x_amount, reserve_y_amount, source
    ) VALUES (
      @poolAddress, @ts, @tvl, @price, @cumFees, @cumVolume,
      @fees30m, @volume30m, @feeTvl30mPct,
      @reserveX, @reserveY, @source
    )
  `);

  insertSample(p: PoolView, ts: number, source: string): void {
    this.insertSampleStmt.run({
      poolAddress: p.address,
      ts,
      tvl: p.tvl,
      price: p.currentPrice,
      cumFees: p.cumulativeFeesUsd,
      cumVolume: p.cumulativeVolumeUsd,
      fees30m: p.fees["30m"],
      volume30m: p.volume["30m"],
      feeTvl30mPct: p.feeTvlRatioPct["30m"],
      reserveX: p.reserveXAmount,
      reserveY: p.reserveYAmount,
      source,
    });
  }

  private readonly upsertMetricsStmt = this.db.prepare(`
    INSERT INTO pool_metrics (
      pool_address, ts, fee_rate_usd_min, heat_pct_hr, fee_accel,
      peak_rate_usd_min, hot_streak, sample_count, sparkline_json,
      tvl, price, volume_30m, fees_30m, fee_tvl_30m_pct, fee_tvl_24h_pct,
      dynamic_fee_pct, apy_pct, reserve_x_amount, reserve_y_amount
    ) VALUES (
      @poolAddress, @ts, @feeRate, @heat, @accel,
      @peakRate, @hotStreak, @sampleCount, @sparkline,
      @tvl, @price, @volume30m, @fees30m, @feeTvl30mPct, @feeTvl24hPct,
      @dynamicFeePct, @apyPct, @reserveX, @reserveY
    )
    ON CONFLICT(pool_address) DO UPDATE SET
      ts = @ts, fee_rate_usd_min = @feeRate, heat_pct_hr = @heat,
      fee_accel = @accel, peak_rate_usd_min = @peakRate,
      hot_streak = @hotStreak, sample_count = @sampleCount,
      sparkline_json = @sparkline, tvl = @tvl, price = @price,
      volume_30m = @volume30m, fees_30m = @fees30m,
      fee_tvl_30m_pct = @feeTvl30mPct, fee_tvl_24h_pct = @feeTvl24hPct,
      dynamic_fee_pct = @dynamicFeePct, apy_pct = @apyPct,
      reserve_x_amount = @reserveX, reserve_y_amount = @reserveY
  `);

  upsertMetrics(p: PoolView, m: DerivedMetrics, ts: number, sparklinePoints: number): void {
    const series = m.rateSeries.slice(-sparklinePoints);
    this.upsertMetricsStmt.run({
      poolAddress: p.address,
      ts,
      feeRate: m.feeRateUsdPerMin,
      heat: m.heatPctPerHour,
      accel: m.feeAccel,
      peakRate: m.peakRateUsdPerMin,
      hotStreak: m.hotStreak,
      sampleCount: m.sampleCount,
      // Rounded: the sparkline only needs shape, and this keeps the row small.
      sparkline: JSON.stringify(series.map((r) => Math.round(r * 100) / 100)),
      tvl: p.tvl,
      price: p.currentPrice,
      volume30m: p.volume["30m"],
      fees30m: p.fees["30m"],
      feeTvl30mPct: p.feeTvlRatioPct["30m"],
      feeTvl24hPct: p.feeTvlRatioPct["24h"],
      dynamicFeePct: p.dynamicFeePct ?? null,
      apyPct: p.apyPct ?? null,
      reserveX: p.reserveXAmount,
      reserveY: p.reserveYAmount,
    });
  }

  /** Rebuild in-memory fee history after a restart. Oldest first. */
  recentSamples(poolAddress: string, limit: number): Array<{ ts: number; cumFees: number; tvl: number }> {
    const rows = this.db
      .prepare(
        `SELECT ts, cum_fees_usd AS cumFees, tvl
           FROM pool_samples WHERE pool_address = ?
          ORDER BY ts DESC LIMIT ?`,
      )
      .all(poolAddress, limit) as Array<{ ts: number; cumFees: number; tvl: number }>;
    return rows.reverse();
  }

  pruneSamples(olderThanMs: number): number {
    return this.db.prepare(`DELETE FROM pool_samples WHERE ts < ?`).run(Date.now() - olderThanMs)
      .changes;
  }

  // ---- reads -------------------------------------------------------------

  leaderboard(f: LeaderboardFilters = {}): LeaderboardRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (f.minTvl !== undefined) {
      where.push("m.tvl >= @minTvl");
      params.minTvl = f.minTvl;
    }
    if (f.maxTvl !== undefined) {
      where.push("m.tvl <= @maxTvl");
      params.maxTvl = f.maxTvl;
    }
    if (f.minHeat !== undefined) {
      where.push("m.heat_pct_hr >= @minHeat");
      params.minHeat = f.minHeat;
    }
    if (f.protocol) {
      where.push("p.protocol = @protocol");
      params.protocol = f.protocol;
    }
    if (f.excludeBlacklisted) where.push("p.is_blacklisted = 0");
    if (f.maxAgeMinutes !== undefined) {
      where.push("p.created_at > @minCreatedAt");
      params.minCreatedAt = Date.now() - f.maxAgeMinutes * 60_000;
    }
    if (f.freshWithinMs !== undefined) {
      where.push("m.ts >= @minMetricTs");
      params.minMetricTs = Date.now() - f.freshWithinMs;
    }

    const orderBy =
      {
        heat: "m.heat_pct_hr DESC",
        rate: "m.fee_rate_usd_min DESC",
        tvl: "m.tvl DESC",
        volume: "m.volume_30m DESC",
        age: "p.created_at DESC",
        accel: "m.fee_accel DESC",
      }[f.sort ?? "heat"] ?? "m.heat_pct_hr DESC";

    params.limit = f.limit ?? config.display.leaderboardSize;

    return this.db
      .prepare(
        `SELECT
           p.address, p.protocol, p.name,
           p.token_x_symbol AS tokenXSymbol, p.token_y_symbol AS tokenYSymbol,
           p.token_x_mint AS tokenXMint, p.bin_step AS binStep,
           p.base_fee_pct AS baseFeePct, p.created_at AS createdAt,
           p.is_blacklisted AS isBlacklisted, p.launchpad,
           p.token_x_holders AS tokenXHolders,
           p.token_x_verified AS tokenXVerified,
           p.token_x_freeze_disabled AS tokenXFreezeDisabled,
           m.ts, m.fee_rate_usd_min AS feeRateUsdMin, m.heat_pct_hr AS heatPctHr,
           m.fee_accel AS feeAccel, m.hot_streak AS hotStreak,
           m.sample_count AS sampleCount, m.sparkline_json AS sparklineJson,
           m.tvl, m.price, m.volume_30m AS volume30m, m.fees_30m AS fees30m,
           m.fee_tvl_30m_pct AS feeTvl30mPct, m.fee_tvl_24h_pct AS feeTvl24hPct,
           m.dynamic_fee_pct AS dynamicFeePct, m.apy_pct AS apyPct
         FROM pool_metrics m
         JOIN pools p ON p.address = m.pool_address
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY ${orderBy}
         LIMIT @limit`,
      )
      .all(params) as LeaderboardRow[];
  }

  counts(): { pools: number; samples: number; metrics: number } {
    const one = (sql: string): number =>
      (this.db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
    return {
      pools: one("SELECT COUNT(*) AS n FROM pools"),
      samples: one("SELECT COUNT(*) AS n FROM pool_samples"),
      metrics: one("SELECT COUNT(*) AS n FROM pool_metrics"),
    };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Process-wide singleton. Next.js re-evaluates modules on hot reload, which
 * without this would open a new SQLite handle on every edit until the process
 * runs out of file descriptors.
 */
const globalForDb = globalThis as unknown as { __radarDb?: RadarDb };

export function getDb(): RadarDb {
  globalForDb.__radarDb ??= new RadarDb();
  return globalForDb.__radarDb;
}
