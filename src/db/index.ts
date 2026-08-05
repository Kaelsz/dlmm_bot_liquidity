import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "@/config";
import { MIGRATIONS, SCHEMA } from "@/db/schema.sql";
import type { DerivedMetrics } from "@/data/metrics";
import { isTrustedMint, type RugcheckReport } from "@/data/rugcheck";
import type { PoolView } from "@/types/meteora";

/** One point of the derived signal, recomputed from two consecutive samples. */
export interface SignalPoint {
  ts: number;
  rate: number;
  heat: number;
  tvl: number;
  price: number;
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
  /** Market cap du token risqué. Celui du quote n'a aucune valeur informative. */
  marketCap: number;
  tokenXHolders: number;
  tokenXVerified: number;
  tokenXFreezeDisabled: number;
  tokenYHolders: number;
  tokenYVerified: number;
  tokenYFreezeDisabled: number;
  ts: number;
  feeRateUsdMin: number;
  volumeRateUsdMin: number;
  rateSpanMs: number;
  rateUpdates: number;
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

export interface PositionRow {
  positionAddress: string;
  owner: string;
  poolAddress: string;
  poolName: string;
  firstSeenAt: number;
  lastSeenAt: number;
  closedAt: number | null;
  depositedUsd: number;
  withdrawnUsd: number;
  totalShares: number;
  valueUsd: number;
  claimedFeeUsd: number;
  unclaimedFeeUsd: number;
  lowerBinId: number;
  upperBinId: number;
  inRange: number;
  valued: number;
}

export interface LeaderboardFilters {
  minTvl?: number;
  maxTvl?: number;
  minHeat?: number;
  minMcap?: number;
  maxMcap?: number;
  maxAgeMinutes?: number;
  protocol?: "dlmm" | "damm_v2";
  excludeBlacklisted?: boolean;
  /** Only pools whose metrics were refreshed within this window. */
  freshWithinMs?: number;
  sort?: "heat" | "rate" | "volumeRate" | "tvl" | "volume" | "mcap" | "age" | "accel";
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
    p.risky_market_cap AS marketCap,
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
    m.volume_rate_usd_min AS volumeRateUsdMin,
    m.rate_span_ms AS rateSpanMs, m.rate_updates AS rateUpdates,
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
      first_seen_at, last_seen_at, is_blacklisted, launchpad, tags,
      risky_market_cap
    ) VALUES (
      @address, @protocol, @name,
      @tokenXMint, @tokenXSymbol, @tokenXDecimals, @tokenXHolders,
      @tokenXVerified, @tokenXFreezeDisabled, @tokenXMarketCap,
      @tokenYMint, @tokenYSymbol, @tokenYDecimals, @tokenYHolders,
      @tokenYVerified, @tokenYFreezeDisabled, @tokenYMarketCap,
      @binStep, @baseFeePct, @collectFeeMode, @createdAt,
      @now, @now, @isBlacklisted, @launchpad, @tags,
      @riskyMarketCap
    )
    ON CONFLICT(address) DO UPDATE SET
      last_seen_at = @now,
      name = @name,
      base_fee_pct = @baseFeePct,
      token_x_holders = @tokenXHolders,
      token_x_market_cap = @tokenXMarketCap,
      token_y_holders = @tokenYHolders,
      token_y_market_cap = @tokenYMarketCap,
      risky_market_cap = @riskyMarketCap,
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
      // Le côté risqué est celui qui n'est pas SOL/USDC/USDT. Même logique que
      // riskyMintOf, appliquée ici pour que le filtre reste un simple BETWEEN.
      riskyMarketCap:
        isTrustedMint(p.tokenX.address) && !isTrustedMint(p.tokenY.address)
          ? p.tokenY.market_cap
          : p.tokenX.market_cap,
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
      pool_address, ts, fee_rate_usd_min, volume_rate_usd_min,
      rate_span_ms, rate_updates, heat_pct_hr, fee_accel,
      peak_rate_usd_min, hot_streak, sample_count, sparkline_json,
      tvl, price, volume_30m, fees_30m, fee_tvl_30m_pct, fee_tvl_24h_pct,
      dynamic_fee_pct, apy_pct, reserve_x_amount, reserve_y_amount
    ) VALUES (
      @poolAddress, @ts, @feeRate, @volumeRate,
      @rateSpanMs, @rateUpdates, @heat, @accel,
      @peakRate, @hotStreak, @sampleCount, @sparkline,
      @tvl, @price, @volume30m, @fees30m, @feeTvl30mPct, @feeTvl24hPct,
      @dynamicFeePct, @apyPct, @reserveX, @reserveY
    )
    ON CONFLICT(pool_address) DO UPDATE SET
      ts = @ts, fee_rate_usd_min = @feeRate,
      volume_rate_usd_min = @volumeRate,
      rate_span_ms = @rateSpanMs, rate_updates = @rateUpdates, heat_pct_hr = @heat,
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
      volumeRate: m.volumeRateUsdPerMin,
      rateSpanMs: m.rateSpanMs,
      rateUpdates: m.rateUpdates,
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
  recentSamples(
    poolAddress: string,
    limit: number,
  ): Array<{ ts: number; cumFees: number; cumVolume: number; tvl: number }> {
    const rows = this.db
      .prepare(
        `SELECT ts, cum_fees_usd AS cumFees, cum_volume_usd AS cumVolume, tvl
           FROM pool_samples WHERE pool_address = ?
          ORDER BY ts DESC LIMIT ?`,
      )
      .all(poolAddress, limit) as Array<{
      ts: number;
      cumFees: number;
      cumVolume: number;
      tvl: number;
    }>;
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
    if (f.minMcap !== undefined) {
      where.push("p.risky_market_cap >= @minMcap");
      params.minMcap = f.minMcap;
    }
    if (f.maxMcap !== undefined) {
      // Un market cap à 0 signifie « inconnu », pas « minuscule » : l'exclure
      // d'un plafond éviterait de faire passer pour petites des pools qu'on
      // n'a simplement pas su mesurer.
      where.push("(p.risky_market_cap > 0 AND p.risky_market_cap <= @maxMcap)");
      params.maxMcap = f.maxMcap;
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
        mcap: "p.risky_market_cap DESC",
        volumeRate: "m.volume_rate_usd_min DESC",
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

  // ---- positions ---------------------------------------------------------

  /** Enregistre une consultation. C'est elle qui maintient le wallet suivi. */
  trackWallet(owner: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO tracked_wallets (owner, added_at, last_viewed_at) VALUES (?, ?, ?)
         ON CONFLICT(owner) DO UPDATE SET last_viewed_at = ?`,
      )
      .run(owner, now, now, now);
  }

  /**
   * Wallets à sonder en fond : les plus récemment consultés, plafonnés.
   *
   * Le site est public, donc n'importe qui peut faire enregistrer une adresse.
   * Sans plafond ni péremption, le collecteur finirait par sonder des
   * centaines de wallets toutes les cinq minutes aux frais du propriétaire.
   */
  trackedWallets(limit: number, ttlMs: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT owner FROM tracked_wallets
            WHERE last_viewed_at IS NOT NULL AND last_viewed_at >= ?
            ORDER BY last_viewed_at DESC LIMIT ?`,
        )
        .all(Date.now() - ttlMs, limit) as Array<{ owner: string }>
    ).map((r) => r.owner);
  }

  markWalletSynced(owner: string, ts = Date.now()): void {
    this.db.prepare(`UPDATE tracked_wallets SET last_sync_at = ? WHERE owner = ?`).run(ts, owner);
  }

  positionsFor(owner: string): PositionRow[] {
    return this.db
      .prepare(
        `SELECT position_address AS positionAddress, owner, pool_address AS poolAddress,
                pool_name AS poolName, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
                closed_at AS closedAt, deposited_usd AS depositedUsd,
                withdrawn_usd AS withdrawnUsd, total_shares AS totalShares,
                value_usd AS valueUsd, claimed_fee_usd AS claimedFeeUsd,
                unclaimed_fee_usd AS unclaimedFeeUsd, lower_bin_id AS lowerBinId,
                upper_bin_id AS upperBinId, in_range AS inRange, valued
           FROM wallet_positions WHERE owner = ?
          ORDER BY closed_at IS NOT NULL, last_seen_at DESC`,
      )
      .all(owner) as PositionRow[];
  }

  private static readonly UPSERT_POSITION = `
    INSERT INTO wallet_positions (
      position_address, owner, pool_address, pool_name, first_seen_at, last_seen_at,
      deposited_usd, withdrawn_usd, total_shares, value_usd, claimed_fee_usd,
      unclaimed_fee_usd, lower_bin_id, upper_bin_id, in_range, valued
    ) VALUES (
      @positionAddress, @owner, @poolAddress, @poolName, @ts, @ts,
      @depositedUsd, @withdrawnUsd, @totalShares, @valueUsd, @claimedFeeUsd,
      @unclaimedFeeUsd, @lowerBinId, @upperBinId, @inRange, @valued
    )
    ON CONFLICT(position_address) DO UPDATE SET
      last_seen_at = @ts, closed_at = NULL, pool_name = @poolName,
      deposited_usd = @depositedUsd, withdrawn_usd = @withdrawnUsd,
      total_shares = @totalShares, value_usd = @valueUsd,
      claimed_fee_usd = @claimedFeeUsd, unclaimed_fee_usd = @unclaimedFeeUsd,
      lower_bin_id = @lowerBinId, upper_bin_id = @upperBinId,
      in_range = @inRange, valued = @valued
  `;

  upsertPosition(r: Omit<PositionRow, "firstSeenAt" | "lastSeenAt" | "closedAt">, ts: number): void {
    this.stmt(RadarDb.UPSERT_POSITION).run({ ...r, ts });
  }

  /** Marque fermées les positions du wallet absentes du dernier relevé. */
  closeMissingPositions(owner: string, seen: string[], ts: number): number {
    const ph = seen.length ? seen.map(() => "?").join(",") : "''";
    return this.db
      .prepare(
        `UPDATE wallet_positions SET closed_at = ?
          WHERE owner = ? AND closed_at IS NULL
            AND position_address NOT IN (${ph})`,
      )
      .run(ts, owner, ...seen).changes;
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

  /** One pool by address, with its latest metrics. */
  poolByAddress(address: string): LeaderboardRow | undefined {
    return this.db.prepare(`${LEADERBOARD_SELECT} WHERE p.address = ?`).get(address) as
      | LeaderboardRow
      | undefined;
  }

  /**
   * The derived signal over time, oldest first.
   *
   * Rates are recomputed here from consecutive cumulative-fee readings rather
   * than read from pool_metrics, which only ever holds the latest value. The
   * same guard as the live path applies: a reading where the counter went
   * backwards is a stale API response and is dropped, not turned into a
   * negative rate followed by a phantom spike.
   */
  signalHistory(
    poolAddress: string,
    sinceMs: number,
  ): SignalPoint[] {
    const rows = this.db
      .prepare(
        `SELECT ts, tvl, price, cum_fees_usd AS cumFees
           FROM pool_samples WHERE pool_address = ? AND ts >= ?
          ORDER BY ts ASC`,
      )
      .all(poolAddress, sinceMs) as Array<{
      ts: number;
      tvl: number;
      price: number;
      cumFees: number;
    }>;

    const out: SignalPoint[] = [];
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1]!;
      const curr = rows[i]!;
      if (curr.cumFees < prev.cumFees) continue;
      const dtMin = (curr.ts - prev.ts) / 60_000;
      if (dtMin <= 0) continue;
      const rate = (curr.cumFees - prev.cumFees) / dtMin;
      const heat = curr.tvl > 0 ? ((rate * 60) / curr.tvl) * 100 : 0;
      out.push({ ts: curr.ts, rate, heat, tvl: curr.tvl, price: curr.price });
    }
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
