/**
 * Central configuration.
 *
 * Everything tunable lives here with a commented default. Secrets and
 * deployment-specific values come from the environment; Next.js loads
 * `.env.local` / `.env` automatically, so no dotenv import is needed.
 */

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  storage: {
    /** SQLite file. On the VPS this must sit on a mounted volume. */
    dbPath: process.env.DB_PATH ?? "data/radar.db",
  },

  log: {
    level: (process.env.LOG_LEVEL ?? "info") as "trace" | "debug" | "info" | "warn" | "error",
  },

  datapi: {
    dlmmBaseUrl: "https://dlmm.datapi.meteora.ag",
    dammV2BaseUrl: "https://damm-v2.datapi.meteora.ag",
    /** Documented limits are ~30/s (DLMM) and ~10/s (DAMM v2); keep headroom. */
    dlmmMaxReqPerSec: 20,
    dammV2MaxReqPerSec: 6,
    requestTimeoutMs: 10_000,
    backoffBaseMs: 500,
    backoffMaxMs: 30_000,
    maxRetries: 5,
  },

  collector: {
    /** Master switch — set COLLECTOR=off to run the UI against an existing DB. */
    enabled: (process.env.COLLECTOR ?? "on") !== "off",

    /**
     * Tier A — broad market discovery. The list endpoint returns
     * `cumulative_metrics` for every row, so a handful of requests yields the
     * derived fee rate for the whole visible market. 2 protocols x 3 sorts x
     * 2 pages = 12 requests per cycle.
     */
    discoveryIntervalMs: num(process.env.DISCOVERY_INTERVAL_MS, 60_000),
    discoveryPages: 2,
    discoveryPageSize: 100,
    discoverySorts: [
      "fee_tvl_ratio_30m:desc",
      "volume_30m:desc",
      "tvl:desc",
    ] as const,

    /** Tier B — new pool detection via `pool_created_at:desc` (1 request per protocol). */
    newPoolsIntervalMs: num(process.env.NEW_POOLS_INTERVAL_MS, 20_000),
    newPoolsPageSize: 100,

    /** Tier C — per-pool polling for sub-minute resolution on the hot set. */
    hotSetIntervalMs: num(process.env.HOT_SET_INTERVAL_MS, 12_000),
    hotSetMaxSize: 60,
    /** Top-N by heat from tier A are always in the hot set. */
    hotSetTopByHeat: 40,
    /** Pools younger than this with enough liquidity join the hot set. */
    hotSetYoungPoolMaxAgeMs: 30 * 60_000,
    hotSetYoungPoolMinTvlUsd: 500,
    /** Dropped from the hot set after this long without re-qualifying. */
    hotSetTtlMs: 10 * 60_000,

    /** Rolling fee history kept in memory per pool (points). */
    historyPoints: 60,
    /** Raw samples retention. */
    sampleRetentionMs: 6 * 3_600_000,
  },

  rugcheck: {
    baseUrl: "https://api.rugcheck.xyz",
    /** No published rate limit, so stay gentle on purpose. */
    maxReqPerSec: 2,
    requestTimeoutMs: 8_000,
    /** Reports are re-fetched after this long. LP can be unlocked at any time. */
    cacheTtlMs: 30 * 60_000,
    /** Score is 0-100 and HIGHER IS RISKIER. */
    cautionScore: 25,
    dangerScore: 50,
    /** Per cycle, how many uncached young pools to enrich. */
    maxLookupsPerCycle: 12,
  },

  helius: {
    /** Never hardcoded. Lives in .env.local, which is gitignored. */
    apiKey: process.env.HELIUS_API_KEY ?? "",
    rpcUrl: (key: string) => `https://mainnet.helius-rpc.com/?api-key=${key}`,
    /** Deliberately gentle; the free tier is metered by credits, not just rate. */
    maxReqPerSec: 5,
    requestTimeoutMs: 15_000,
    /** Holder pages to walk per token. 1000 owners is plenty to find a KOL. */
    maxHolderPages: 2,
    holderPageSize: 1000,
  },

  kol: {
    /**
     * Full rebuild of the mint -> KOLs index.
     *
     * COST, because this is by far the biggest consumer of Helius credits and
     * the arithmetic is not obvious. One pass is
     *
     *     553 wallets x 2 token programs = ~1100 requests
     *
     * so the daily total is 1100 x (1440 / interval_in_minutes):
     *
     *     every 10 min -> ~159 000/day  (~4.8M/month — well past a free tier)
     *     every 30 min -> ~53 000/day   (~1.6M/month)
     *     every 60 min -> ~26 000/day   (~800k/month)
     *
     * 30 minutes is the default because the signal is about attention, not
     * execution: knowing within half an hour that a KOL took a position is
     * enough to go and look. Lower it if your quota allows, and watch
     * /api/health, which reports the projected daily figure.
     */
    refreshIntervalMs: num(process.env.KOL_REFRESH_INTERVAL_MS, 30 * 60_000),
    /**
     * Query the Token-2022 program as well. It doubles the request count and
     * almost no memecoin uses it, so it is worth turning off on a tight quota.
     */
    includeToken2022: (process.env.KOL_TOKEN_2022 ?? "on") !== "off",
    /** Parallel wallet lookups. The token bucket still caps the actual rate. */
    concurrency: 8,
  },

  /**
   * Display defaults. These are NOT hard filters like the old bot's — the UI
   * exposes them and the collector stores everything it sees.
   */
  display: {
    /** Anti-dust default on the new-pools view: TVL above OR 30m volume above. */
    newPoolMinTvlUsd: 500,
    newPoolMinVolume30mUsd: 1_000,
    leaderboardSize: 100,
  },
} as const;

export type Protocol = "dlmm" | "damm_v2";
