import { EventEmitter } from "node:events";
import { config, type Protocol } from "@/config";
import { ALL_APIS, apiFor, dammV2Api, dlmmApi } from "@/data/client";
import { deriveMetrics, pushFeePoint, type FeePoint } from "@/data/metrics";
import { fetchRugcheck, isTrustedMint } from "@/data/rugcheck";
import { getDb, type RadarDb } from "@/db";
import { logger } from "@/lib/logger";
import type { PoolView, SortSpec } from "@/types/meteora";

const key = (p: { protocol: Protocol; address: string }): string => `${p.protocol}:${p.address}`;

interface HotEntry {
  protocol: Protocol;
  address: string;
  qualifiedAt: number;
}

export interface CollectorStatus {
  running: boolean;
  startedAt: number | null;
  cycles: { discovery: number; newPools: number; hotSet: number };
  lastCycleAt: { discovery: number | null; newPools: number | null; hotSet: number | null };
  hotSetSize: number;
  trackedPools: number;
  errors: number;
  api: Record<Protocol, { requests: number; errors: number; rateLimited: number }>;
}

/**
 * The background service. One instance per process, started from
 * `instrumentation.ts`.
 *
 * Three polling tiers, deliberately unequal:
 *
 *   A. Discovery (60s) — a handful of sorted list requests. Because the list
 *      endpoint returns `cumulative_metrics` for every row, ~12 requests give
 *      us a fee-rate sample for ~1200 pools. This is the whole reason the
 *      dashboard can cover the market cheaply; the old bot instead issued one
 *      request per watched pool and so could only follow ~50.
 *
 *   B. New pools (20s) — `pool_created_at:desc`, 1 request per protocol.
 *
 *   C. Hot set (12s) — per-pool requests for sub-minute resolution on the
 *      pools that actually matter right now.
 *
 * Peak load is ~62 requests per 12s window, i.e. ~5 req/s split across two
 * APIs limited to 20/s and 6/s. Comfortable.
 */
export class Collector {
  private readonly db: RadarDb;
  private readonly bus = new EventEmitter();
  private readonly history = new Map<string, FeePoint[]>();
  private readonly hotSet = new Map<string, HotEntry>();
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private startedAt: number | null = null;
  private errors = 0;
  private readonly cycles = { discovery: 0, newPools: 0, hotSet: 0 };
  private readonly lastCycleAt: CollectorStatus["lastCycleAt"] = {
    discovery: null,
    newPools: null,
    hotSet: null,
  };

  constructor(db: RadarDb = getDb()) {
    this.db = db;
    this.bus.setMaxListeners(0);
  }

  // ---- lifecycle ---------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    logger.info("collector starting");

    // Fire each tier immediately, then on its interval.
    void this.safe("discovery", () => this.runDiscovery());
    void this.safe("newPools", () => this.runNewPools());

    this.every(config.collector.discoveryIntervalMs, () =>
      this.safe("discovery", () => this.runDiscovery()),
    );
    this.every(config.collector.newPoolsIntervalMs, () =>
      this.safe("newPools", () => this.runNewPools()),
    );
    this.every(config.collector.hotSetIntervalMs, () =>
      this.safe("hotSet", () => this.runHotSet()),
    );
    // Housekeeping, well off the hot path.
    this.every(10 * 60_000, async () => {
      const removed = this.db.pruneSamples(config.collector.sampleRetentionMs);
      if (removed > 0) logger.debug({ removed }, "pruned samples");
    });
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.running = false;
    logger.info("collector stopped");
  }

  private every(ms: number, fn: () => unknown): void {
    const t = setInterval(fn, ms);
    t.unref?.();
    this.timers.push(t);
  }

  private async safe(tier: keyof CollectorStatus["cycles"], fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      this.cycles[tier] += 1;
      this.lastCycleAt[tier] = Date.now();
    } catch (err) {
      this.errors += 1;
      logger.warn({ tier, err }, "collector cycle failed");
    }
  }

  // ---- subscription ------------------------------------------------------

  onUpdate(fn: () => void): () => void {
    this.bus.on("update", fn);
    return () => this.bus.off("update", fn);
  }

  // ---- tiers -------------------------------------------------------------

  private async runDiscovery(): Promise<void> {
    const jobs: Array<Promise<PoolView[]>> = [];
    for (const api of ALL_APIS) {
      for (const sort of config.collector.discoverySorts) {
        for (let page = 1; page <= config.collector.discoveryPages; page += 1) {
          jobs.push(
            api
              .listPools({
                page,
                pageSize: config.collector.discoveryPageSize,
                sortBy: sort as SortSpec,
              })
              .catch((err) => {
                logger.debug({ protocol: api.protocol, sort, page, err }, "discovery page failed");
                return [] as PoolView[];
              }),
          );
        }
      }
    }
    const pages = await Promise.all(jobs);
    const pools = pages.flat();
    const seen = this.ingest(pools, "discovery");
    this.refreshHotSet();
    logger.debug({ pools: seen }, "discovery cycle");
    this.bus.emit("update");

    // Safety for the hottest pools too, not only the freshly launched ones —
    // otherwise the market view's safety column is permanently "unknown".
    const hot = new Set(this.hotSet.keys());
    const hotPools = pools.filter((p) => hot.has(key(p)));
    await this.enrichSafety(hotPools);
  }

  private async runNewPools(): Promise<void> {
    const pages = await Promise.all(
      ALL_APIS.map((api) =>
        api
          .listPools({
            page: 1,
            pageSize: config.collector.newPoolsPageSize,
            sortBy: "pool_created_at:desc",
          })
          .catch((err) => {
            logger.debug({ protocol: api.protocol, err }, "new-pools page failed");
            return [] as PoolView[];
          }),
      ),
    );
    const pools = pages.flat();
    this.ingest(pools, "new_pools");

    // Young pools with real liquidity earn a place in the hot set immediately —
    // this is the window where a launch is worth catching.
    const now = Date.now();
    const young: PoolView[] = [];
    for (const p of pools) {
      const age = now - p.createdAtMs;
      if (p.createdAtMs <= 0 || age >= config.collector.hotSetYoungPoolMaxAgeMs) continue;
      young.push(p);
      if (p.tvl >= config.collector.hotSetYoungPoolMinTvlUsd) {
        this.hotSet.set(key(p), { protocol: p.protocol, address: p.address, qualifiedAt: now });
      }
    }

    this.bus.emit("update");
    // Third-party lookups run after the emit so the table updates without
    // waiting on APIs whose latency we do not control.
    await this.enrichSafety(young);
  }

  private async runHotSet(): Promise<void> {
    const now = Date.now();
    // Evict stale entries first so a dead pool stops consuming budget.
    for (const [k, e] of this.hotSet) {
      if (now - e.qualifiedAt > config.collector.hotSetTtlMs) this.hotSet.delete(k);
    }
    const entries = [...this.hotSet.values()].slice(0, config.collector.hotSetMaxSize);
    if (entries.length === 0) return;

    const results = await Promise.all(
      entries.map((e) => apiFor(e.protocol).getPool(e.address)),
    );
    const pools = results.filter((p): p is PoolView => p !== undefined);
    this.ingest(pools, "hot");
    logger.debug({ polled: pools.length }, "hot set cycle");
    this.bus.emit("update");
  }

  /**
   * Fill in RugCheck reports for the non-quote side of young pools.
   *
   * Budgeted twice over: only mints without a fresh cache entry are looked up,
   * and only a handful per cycle. The pools with real liquidity go first —
   * most new pools are dust and are not worth a request.
   */
  private async enrichSafety(pools: PoolView[]): Promise<void> {
    if (pools.length === 0) return;

    const byMint = new Map<string, number>();
    for (const p of pools) {
      // The risky side is whichever token is not the quote. Meteora does not
      // normalise the order, so this cannot assume token_x.
      const mint = isTrustedMint(p.tokenX.address) ? p.tokenY.address : p.tokenX.address;
      if (isTrustedMint(mint)) continue; // exotic pair, both sides trusted
      byMint.set(mint, Math.max(byMint.get(mint) ?? 0, p.tvl));
    }
    // Biggest first: with a bounded budget, the pools someone might actually
    // size into are worth the request.
    const ranked = [...byMint.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);

    const todo = this.db.mintsNeedingRugcheck(
      ranked,
      config.rugcheck.cacheTtlMs,
      config.rugcheck.maxLookupsPerCycle,
    );
    if (todo.length === 0) return;

    const reports = await Promise.all(todo.map((m) => fetchRugcheck(m)));
    const write = this.db.db.transaction((rs: typeof reports) => {
      for (const r of rs) this.db.upsertRugcheck(r);
    });
    write(reports);

    const flagged = reports.filter((r) => !r.unavailable).length;
    logger.debug({ looked: reports.length, resolved: flagged }, "rugcheck enrichment");
    this.bus.emit("update");
  }

  // ---- ingestion ---------------------------------------------------------

  /**
   * Persist a batch and update the derived metrics. Deduplicates within the
   * batch, since the discovery sorts overlap heavily (a pool ranked high on
   * fee/TVL is usually also high on volume).
   */
  private ingest(pools: PoolView[], source: string): number {
    const now = Date.now();
    const unique = new Map<string, PoolView>();
    for (const p of pools) unique.set(key(p), p);

    const write = this.db.db.transaction((batch: PoolView[]) => {
      for (const p of batch) {
        this.db.upsertPool(p, now);

        const k = key(p);
        const next = pushFeePoint(
          this.history.get(k) ?? [],
          { ts: now, cumFees: p.cumulativeFeesUsd, tvl: p.tvl },
          config.collector.historyPoints,
        );
        // A rejected point means a stale API read; skip the sample entirely
        // rather than store a reading that would produce a phantom spike.
        if (!next) continue;
        this.history.set(k, next);
        this.db.insertSample(p, now, source);

        const m = deriveMetrics(next);
        if (m) this.db.upsertMetrics(p, m, now, 60);
      }
    });
    write([...unique.values()]);
    return unique.size;
  }

  /** Top pools by derived heat always deserve fine-grained polling. */
  private refreshHotSet(): void {
    const now = Date.now();
    const top = this.db.leaderboard({
      sort: "heat",
      limit: config.collector.hotSetTopByHeat,
      freshWithinMs: 5 * 60_000,
    });
    for (const row of top) {
      this.hotSet.set(`${row.protocol}:${row.address}`, {
        protocol: row.protocol as Protocol,
        address: row.address,
        qualifiedAt: now,
      });
    }
  }

  // ---- introspection -----------------------------------------------------

  status(): CollectorStatus {
    return {
      running: this.running,
      startedAt: this.startedAt,
      cycles: { ...this.cycles },
      lastCycleAt: { ...this.lastCycleAt },
      hotSetSize: this.hotSet.size,
      trackedPools: this.history.size,
      errors: this.errors,
      api: {
        dlmm: { ...dlmmApi.stats },
        damm_v2: { ...dammV2Api.stats },
      },
    };
  }
}

/**
 * Singleton. Next.js evaluates `instrumentation.ts` once per process, but hot
 * reload in dev re-runs module code — without this guard every edit would
 * spawn another set of intervals hammering the API.
 */
const globalForCollector = globalThis as unknown as { __collector?: Collector };

export function getCollector(): Collector {
  globalForCollector.__collector ??= new Collector();
  return globalForCollector.__collector;
}
