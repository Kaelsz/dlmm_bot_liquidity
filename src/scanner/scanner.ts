import { config } from "../config/config.js";
import { logger } from "../utils/logger.js";
import type { BotDb } from "../db/database.js";
import type { PoolView, Protocol } from "../types/datapi.js";
import { apiFor, dammV2Api, dlmmApi } from "./datapi.js";

/**
 * Two-tier scanner.
 *
 * Tier 1 (broad, slow): every `broadScanIntervalMs`, pull a few sorted pages
 * from both data APIs (fee_tvl_ratio_30m and volume_30m descending), apply
 * cheap pre-filters (TVL bounds, blacklist, heat anomaly ratio) and refresh
 * the watchlist.
 *
 * Tier 2 (fast): every `fastPollIntervalMs`, fetch each watchlisted pool
 * individually. Successive snapshots of `cumulative_metrics.fees` give the
 * exact fees-per-minute signal (Δfees/Δt) that the 30m API bucket cannot
 * provide. Snapshots are persisted to SQLite for derivative computations.
 */

export interface WatchlistEntry {
  pool: PoolView;
  addedAt: number;
  lastQualifiedAt: number;
}

export interface HeatSample {
  pool: PoolView;
  /** Derived USD fees per minute over the last polling interval. */
  instantFeeRateUsdPerMin: number;
  /** (Δfees / TVL) scaled to % per hour. */
  instantHeatPctPerHour: number;
  /** Second derivative of cumulative fees (USD/min per minute). */
  feeAcceleration: number;
  /** Number of fast samples available for this pool. */
  sampleCount: number;
  /**
   * Trailing count of consecutive samples whose heat stayed above the entry
   * threshold. Measured burst durations show 76% of fee bursts die in under
   * 2 minutes — entries require persistence, not a single hot reading.
   */
  consecutiveHotSamples: number;
  /** Highest fee rate (USD/min) seen over the recent sample window. */
  peakRateUsdPerMin: number;
}

interface FeePoint {
  ts: number;
  cumFees: number;
  tvl: number;
}

export class Scanner {
  private readonly watchlist = new Map<string, WatchlistEntry>();
  /** Rolling fee points per pool (fast poll only), newest last. */
  private readonly feeHistory = new Map<string, FeePoint[]>();
  private consecutiveErrors = 0;

  constructor(private readonly db: BotDb) {}

  getWatchlist(): WatchlistEntry[] {
    return [...this.watchlist.values()];
  }

  get errorStreak(): number {
    return this.consecutiveErrors;
  }

  /** Tier 1: refresh the watchlist from sorted broad scans of both APIs. */
  async broadScan(): Promise<void> {
    const candidates = new Map<string, PoolView>();
    const sortKeys = ["fee_tvl_ratio_30m:desc", "volume_30m:desc"];
    for (const api of [dlmmApi, dammV2Api]) {
      for (const sortBy of sortKeys) {
        for (let page = 1; page <= config.scanner.broadScanPages; page++) {
          try {
            const pools = await api.listPools({
              page,
              pageSize: config.scanner.broadScanPageSize,
              sortBy,
            });
            this.consecutiveErrors = 0;
            for (const p of pools) {
              if (this.prefilter(p)) candidates.set(`${p.protocol}:${p.address}`, p);
            }
          } catch (err) {
            this.consecutiveErrors += 1;
            logger.error({ err, api: api.protocol, sortBy, page }, "broad scan page failed");
          }
        }
      }
    }

    const now = Date.now();
    // Qualify candidates into the watchlist, best heat first.
    const ranked = [...candidates.values()].sort(
      (a, b) => b.feeTvlRatio["30m"] - a.feeTvlRatio["30m"],
    );
    for (const pool of ranked) {
      const key = `${pool.protocol}:${pool.address}`;
      const existing = this.watchlist.get(key);
      if (existing) {
        existing.pool = pool;
        existing.lastQualifiedAt = now;
      } else if (this.countByProtocol(pool.protocol) < config.scanner.watchlistMaxSize) {
        this.watchlist.set(key, { pool, addedAt: now, lastQualifiedAt: now });
        logger.info(
          {
            pool: pool.name,
            protocol: pool.protocol,
            feeTvl30m: pool.feeTvlRatio["30m"].toFixed(4),
            tvl: Math.round(pool.tvl),
          },
          "watchlist +",
        );
      }
      this.persistPool(pool, "broad");
    }

    // Expire stale entries.
    for (const [key, entry] of this.watchlist) {
      if (now - entry.lastQualifiedAt > config.scanner.watchlistTtlMs) {
        this.watchlist.delete(key);
        this.feeHistory.delete(key);
        logger.info({ pool: entry.pool.name }, "watchlist - (stale)");
      }
    }

    this.db.pruneSnapshots(config.scanner.snapshotRetentionMs);
    logger.debug({ watchlist: this.watchlist.size, candidates: candidates.size }, "broad scan done");
  }

  /** Cheap pre-filters before a pool may enter the watchlist. */
  private prefilter(p: PoolView): boolean {
    if (p.isBlacklisted) return false;
    if (p.tvl < config.scanner.minTvlUsd || p.tvl > config.scanner.maxTvlUsd) return false;
    if (p.currentPrice <= 0) return false;
    if (p.feeTvlRatio["30m"] * 100 < config.scanner.watchlistMinFeeTvl30mPct) return false;
    // Anomaly filter: current 30m heat must dominate the pool's own 24h baseline.
    const heat30m = p.feeTvlRatio["30m"];
    const baselinePer30m = p.feeTvlRatio["24h"] / 48;
    if (baselinePer30m > 0 && heat30m / baselinePer30m < config.scanner.watchlistMinHeatRatio) {
      return false;
    }
    return true;
  }

  private countByProtocol(protocol: Protocol): number {
    let n = 0;
    for (const e of this.watchlist.values()) if (e.pool.protocol === protocol) n += 1;
    return n;
  }

  /**
   * Tier 2: poll every watchlisted pool and derive the fees/minute signal
   * from cumulative fee deltas. Returns one sample per pool that has enough
   * history (>= 2 points).
   */
  async fastPoll(): Promise<HeatSample[]> {
    const samples: HeatSample[] = [];
    const entries = [...this.watchlist.values()];
    await Promise.all(
      entries.map(async (entry) => {
        const api = apiFor(entry.pool.protocol);
        try {
          const fresh = await api.getPool(entry.pool.address);
          this.consecutiveErrors = 0;
          if (!fresh) return;
          entry.pool = fresh;
          const sample = this.recordFeePoint(fresh);
          this.persistPool(fresh, "fast");
          if (sample) samples.push(sample);
        } catch (err) {
          this.consecutiveErrors += 1;
          logger.warn({ err, pool: entry.pool.name }, "fast poll failed");
        }
      }),
    );
    return samples.sort((a, b) => b.instantHeatPctPerHour - a.instantHeatPctPerHour);
  }

  /** Direct sample computation for a single pool (used by position monitor too). */
  recordFeePoint(pool: PoolView): HeatSample | undefined {
    const key = `${pool.protocol}:${pool.address}`;
    const history = this.feeHistory.get(key) ?? [];
    const point: FeePoint = { ts: Date.now(), cumFees: pool.cumulativeFeesUsd, tvl: pool.tvl };
    // Cumulative fees are monotonically increasing; a lower value means the
    // API served a stale reading — skip it rather than produce a negative rate.
    const last = history[history.length - 1];
    if (last && point.cumFees < last.cumFees) return undefined;
    history.push(point);
    while (history.length > 20) history.shift();
    this.feeHistory.set(key, history);

    if (history.length < 2) return undefined;
    const rate = (a: FeePoint, b: FeePoint): number => {
      const dtMin = (b.ts - a.ts) / 60_000;
      return dtMin > 0 ? (b.cumFees - a.cumFees) / dtMin : 0;
    };
    const prev = history[history.length - 2]!;
    const curr = history[history.length - 1]!;
    const instantFeeRateUsdPerMin = rate(prev, curr);
    const tvl = curr.tvl > 0 ? curr.tvl : pool.tvl;
    const instantHeatPctPerHour = tvl > 0 ? ((instantFeeRateUsdPerMin * 60) / tvl) * 100 : 0;

    let feeAcceleration = 0;
    if (history.length >= 3) {
      const prev2 = history[history.length - 3]!;
      const prevRate = rate(prev2, prev);
      const dtMin = (curr.ts - prev.ts) / 60_000;
      feeAcceleration = dtMin > 0 ? (instantFeeRateUsdPerMin - prevRate) / dtMin : 0;
    }

    // Persistence over the recent window: rate per consecutive point pair,
    // heat computed against each point's own TVL.
    const recentWindow = 10;
    const start = Math.max(1, history.length - recentWindow);
    let peakRateUsdPerMin = 0;
    let consecutiveHotSamples = 0;
    for (let i = start; i < history.length; i++) {
      const a = history[i - 1]!;
      const b = history[i]!;
      const r = rate(a, b);
      peakRateUsdPerMin = Math.max(peakRateUsdPerMin, r);
      const t = b.tvl > 0 ? b.tvl : tvl;
      const heat = t > 0 ? ((r * 60) / t) * 100 : 0;
      if (heat >= config.scoring.minInstantHeatPctPerHour) consecutiveHotSamples += 1;
      else consecutiveHotSamples = 0;
    }

    return {
      pool,
      instantFeeRateUsdPerMin,
      instantHeatPctPerHour,
      feeAcceleration,
      sampleCount: history.length,
      consecutiveHotSamples,
      peakRateUsdPerMin,
    };
  }

  private persistPool(pool: PoolView, source: "broad" | "fast"): void {
    try {
      this.db.upsertPool({
        address: pool.address,
        protocol: pool.protocol,
        name: pool.name,
        tokenXMint: pool.tokenX.address,
        tokenYMint: pool.tokenY.address,
        tokenXSymbol: pool.tokenX.symbol,
        tokenYSymbol: pool.tokenY.symbol,
        binStep: pool.binStep,
        baseFeePct: pool.baseFeePct,
        collectFeeMode: pool.collectFeeMode,
        createdAt: pool.createdAtMs,
      });
      this.db.insertSnapshot({
        pool_address: pool.address,
        protocol: pool.protocol,
        ts: Date.now(),
        tvl: pool.tvl,
        current_price: pool.currentPrice,
        dynamic_fee_pct: pool.dynamicFeePct ?? null,
        cum_fees_usd: pool.cumulativeFeesUsd,
        cum_volume_usd: pool.cumulativeVolumeUsd,
        fees_30m: pool.fees["30m"],
        volume_30m: pool.volume["30m"],
        fee_tvl_30m: pool.feeTvlRatio["30m"],
        source,
      });
    } catch (err) {
      logger.warn({ err, pool: pool.address }, "snapshot persist failed");
    }
  }
}
