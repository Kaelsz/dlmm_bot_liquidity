import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "@/config";
import { MIGRATIONS, SCHEMA } from "@/db/schema.sql";
import type { DerivedMetrics } from "@/data/metrics";
import type { RugcheckReport } from "@/data/rugcheck";
import type { KolHolder } from "@/data/kol";
import type { PoolView } from "@/types/meteora";

export interface KolRow {
  mint: string;
  kolCount: number;
  holdersJson: string;
}

export interface RugcheckRow {
  mint: string;
  checkedAt: number;
  score: number | null;
  lpLockedPct: number | null;
  risksJson: string;
  unavailable: number;
}

export interface LeaderboardRow {
  address: string;
  protocol: string;
  name: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tokenXMint: string;
  tokenYMint: string;
  binStep: number | null;
  baseFeePct: number;
  dynamicFeePct: number | null;
  createdAt: number;
  isBlacklisted: number;
  launchpad: string | null;
  tokenXHolders: number;
  tokenXVerified: number;
  tokenXFreezeDisabled: number;
  tokenYHolders: number;
  tokenYVerified: number;
  tokenYFreezeDisabled: number;
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

/** Shared projection for every board query, so the row shape stays in one place. */
const LEADERBOARD_SELECT = `
  SELECT
    p.address, p.protocol, p.name,
    p.token_x_symbol AS tokenXSymbol, p.token_y_symbol AS tokenYSymbol,
    p.token_x_mint AS tokenXMint, p.token_y_mint AS tokenYMint, p.bin_step AS binStep,
    p.base_fee_pct AS baseFeePct, p.created_at AS createdAt,
    p.is_blacklisted AS isBlacklisted, p.launchpad,
    p.token_x_holders AS tokenXHolders,
    p.token_x_verified AS tokenXVerified,
    p.token_x_freeze_disabled AS tokenXFreezeDisabled,
    p.token_y_holders AS tokenYHolders,
    p.token_y_verified AS tokenYVerified,
    p.token_y_freeze_disabled AS tokenYFreezeDisabled,
    m.ts, m.fee_rate_usd_min AS feeRateUsdMin, m.heat_pct_hr AS heatPctHr,
    m.fee_accel AS feeAccel, m.hot_streak AS hotStreak,
    m.sample_count AS sampleCount, m.sparkline_json AS sparklineJson,
    m.tvl, m.price, m.volume_30m AS volume30m, m.fees_30m AS fees30m,
    m.fee_tvl_30m_pct AS feeTvl30mPct, m.fee_tvl_24h_pct AS feeTvl24hPct,
    m.dynamic_fee_pct AS dynamicFeePct, m.apy_pct AS apyPct
  FROM pool_metrics m
  JOIN pools p ON p.address = m.pool_address
`;

export class RadarDb {
  readonly db: Database.Database;
  /**
   * Statements are prepared on first use rather than in the constructor:
   * class field initialisers run before the constructor body, so anything
   * touching `this.db` there would see it uninitialised.
   */
  private readonly stmtCache = new Map<string, Database.Statement>();

  constructor(path = config.storage.dbPath) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
    for (const sql of MIGRATIONS) {
      try {
        this.db.exec(sql);
      } catch {
        // Already applied. SQLite offers no ADD COLUMN IF NOT EXISTS, and
        // probing pragma_table_info for each column costs more than this.
      }
    }
  }

  private stmt(sql: string): Database.Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  // ---- writes ------------------------------------------------------------

  private static readonly UPSERT_POOL = `
    INSERT INTO pools (
      address, protocol, name,
      token_x_mint, token_x_symbol, token_x_decimals, token_x_holders,
      token_x_verified, token_x_freeze_disabled, token_x_market_cap,
      token_y_mint, token_y_symbol, token_y_decimals, token_y_holders,
      token_y_verified, token_y_freeze_disabled, token_y_market_cap,
      bin_step, base_fee_pct, collect_fee_mode, created_at,
      first_seen_at, last_seen_at, is_blacklisted, launchpad, tags
    ) VALUES (
      @address, @protocol, @name,
      @tokenXMint, @tokenXSymbol, @tokenXDecimals, @tokenXHolders,
      @tokenXVerified, @tokenXFreezeDisabled, @tokenXMarketCap,
      @tokenYMint, @tokenYSymbol, @tokenYDecimals, @tokenYHolders,
      @tokenYVerified, @tokenYFreezeDisabled, @tokenYMarketCap,
      @binStep, @baseFeePct, @collectFeeMode, @createdAt,
      @now, @now, @isBlacklisted, @launchpad, @tags
    )
    ON CONFLICT(address) DO UPDATE SET
      last_seen_at = @now,
      name = @name,
      base_fee_pct = @baseFeePct,
      token_x_holders = @tokenXHolders,
      token_x_market_cap = @tokenXMarketCap,
      token_y_holders = @tokenYHolders,
      token_y_market_cap = @tokenYMarketCap,
      is_blacklisted = @isBlacklisted
  `;

  upsertPool(p: PoolView, now = Date.now()): void {
    this.stmt(RadarDb.UPSERT_POOL).run({
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
      tokenYHolders: p.tokenY.holders,
      tokenYVerified: p.tokenY.is_verified ? 1 : 0,
      tokenYFreezeDisabled: p.tokenY.freeze_authority_disabled ? 1 : 0,
      tokenYMarketCap: p.tokenY.market_cap,
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

  private static readonly INSERT_SAMPLE = `
    INSERT INTO pool_samples (
      pool_address, ts, tvl, price, cum_fees_usd, cum_volume_usd,
      fees_30m, volume_30m, fee_tvl_30m_pct,
      reserve_x_amount, reserve_y_amount, source
    ) VALUES (
      @poolAddress, @ts, @tvl, @price, @cumFees, @cumVolume,
      @fees30m, @volume30m, @feeTvl30mPct,
      @reserveX, @reserveY, @source
    )
  `;

  insertSample(p: PoolView, ts: number, source: string): void {
    this.stmt(RadarDb.INSERT_SAMPLE).run({
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

  private static readonly UPSERT_METRICS = `
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
  `;

  upsertMetrics(p: PoolView, m: DerivedMetrics, ts: number, sparklinePoints: number): void {
    const series = m.rateSeries.slice(-sparklinePoints);
    this.stmt(RadarDb.UPSERT_METRICS).run({
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
        `${LEADERBOARD_SELECT}
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY ${orderBy}
         LIMIT @limit`,
      )
      .all(params) as LeaderboardRow[];
  }

  /**
   * Freshly created pools, newest first.
   *
   * Separate from `leaderboard` because the filter is a disjunction: a pool
   * three minutes old may have almost no TVL yet still be trading heavily, or
   * hold real liquidity while nobody has touched it. Either is interesting;
   * neither survives the AND-shaped filters of the market view. Meteora lists
   * ~250k pools and most new ones are dust, so some floor is mandatory.
   */
  newPools(opts: {
    maxAgeMinutes: number;
    minTvl: number;
    minVolume30m: number;
    limit: number;
    protocol?: "dlmm" | "damm_v2";
  }): LeaderboardRow[] {
    const where: string[] = ["p.created_at > @minCreatedAt", "(m.tvl >= @minTvl OR m.volume_30m >= @minVol)"];
    const params: Record<string, unknown> = {
      minCreatedAt: Date.now() - opts.maxAgeMinutes * 60_000,
      minTvl: opts.minTvl,
      minVol: opts.minVolume30m,
      limit: opts.limit,
    };
    if (opts.protocol) {
      where.push("p.protocol = @protocol");
      params.protocol = opts.protocol;
    }
    return this.db
      .prepare(
        `${LEADERBOARD_SELECT}
          WHERE ${where.join(" AND ")}
          ORDER BY p.created_at DESC
          LIMIT @limit`,
      )
      .all(params) as LeaderboardRow[];
  }

  // ---- rugcheck ----------------------------------------------------------

  private static readonly UPSERT_RUGCHECK = `
    INSERT INTO rugcheck (mint, checked_at, score, lp_locked_pct, risks_json, unavailable)
    VALUES (@mint, @checkedAt, @score, @lpLockedPct, @risks, @unavailable)
    ON CONFLICT(mint) DO UPDATE SET
      checked_at = @checkedAt, score = @score, lp_locked_pct = @lpLockedPct,
      risks_json = @risks, unavailable = @unavailable
  `;

  upsertRugcheck(r: RugcheckReport): void {
    this.stmt(RadarDb.UPSERT_RUGCHECK).run({
      mint: r.mint,
      checkedAt: r.checkedAt,
      score: r.score,
      lpLockedPct: r.lpLockedPct,
      risks: JSON.stringify(r.risks),
      unavailable: r.unavailable ? 1 : 0,
    });
  }

  /** Mints whose report is missing or older than the TTL, newest pools first. */
  mintsNeedingRugcheck(candidateMints: string[], ttlMs: number, limit: number): string[] {
    if (candidateMints.length === 0) return [];
    const cutoff = Date.now() - ttlMs;
    const fresh = new Set(
      (
        this.db
          .prepare(
            `SELECT mint FROM rugcheck
              WHERE checked_at >= ?
                AND mint IN (${candidateMints.map(() => "?").join(",")})`,
          )
          .all(cutoff, ...candidateMints) as Array<{ mint: string }>
      ).map((r) => r.mint),
    );
    return candidateMints.filter((m) => !fresh.has(m)).slice(0, limit);
  }

  rugcheckFor(mints: string[]): Map<string, RugcheckRow> {
    const out = new Map<string, RugcheckRow>();
    if (mints.length === 0) return out;
    const rows = this.db
      .prepare(
        `SELECT mint, checked_at AS checkedAt, score, lp_locked_pct AS lpLockedPct,
                risks_json AS risksJson, unavailable
           FROM rugcheck WHERE mint IN (${mints.map(() => "?").join(",")})`,
      )
      .all(...mints) as RugcheckRow[];
    for (const r of rows) out.set(r.mint, r);
    return out;
  }

  // ---- KOL ---------------------------------------------------------------

  /**
   * Swap in a freshly built index.
   *
   * The whole table is replaced rather than upserted, inside one transaction:
   * a KOL who sold out must disappear, and leaving stale rows behind would
   * show holders who are long gone. Only mints with at least one KOL are
   * stored; absence means zero.
   */
  replaceKolIndex(byMint: Map<string, KolHolder[]>, builtAt: number): void {
    const del = this.db.prepare("DELETE FROM token_kol");
    const ins = this.db.prepare(
      "INSERT INTO token_kol (mint, kol_count, holders_json) VALUES (?, ?, ?)",
    );
    const setMeta = this.db.prepare(
      "INSERT INTO meta (key, value) VALUES ('kol_index_built_at', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    this.db.transaction(() => {
      del.run();
      for (const [mint, holders] of byMint) {
        ins.run(mint, holders.length, JSON.stringify(holders));
      }
      setMeta.run(String(builtAt));
    })();
  }

  /** When the index was last rebuilt, or null if it never has been. */
  kolIndexBuiltAt(): number | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'kol_index_built_at'").get() as
      | { value: string }
      | undefined;
    if (!row) return null;
    const n = Number(row.value);
    return Number.isFinite(n) ? n : null;
  }

  kolFor(mints: string[]): Map<string, KolRow> {
    const out = new Map<string, KolRow>();
    if (mints.length === 0) return out;
    const rows = this.db
      .prepare(
        `SELECT mint, kol_count AS kolCount, holders_json AS holdersJson
           FROM token_kol WHERE mint IN (${mints.map(() => "?").join(",")})`,
      )
      .all(...mints) as KolRow[];
    for (const r of rows) out.set(r.mint, r);
    return out;
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
