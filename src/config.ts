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

  chain: {
    /**
     * Endpoint RPC Solana, lu côté serveur uniquement — la clé ne doit jamais
     * atteindre le navigateur. Sans elle, la vue Positions le dit au lieu
     * d'échouer : le reste du dashboard n'en dépend pas.
     */
    rpcUrl: process.env.RPC_URL ?? "",
    /**
     * Rafraîchissement de fond des wallets suivis. Il ne sert qu'à repérer les
     * fermetures de positions, invisibles autrement : la fraîcheur immédiate
     * vient de la synchronisation à l'ouverture de la page. D'où une cadence
     * lente — le site est public et chaque cycle consomme du quota RPC.
     */
    positionsIntervalMs: num(process.env.POSITIONS_INTERVAL_MS, 300_000),
    /** Nombre maximum de wallets sondés en continu. */
    maxTrackedWallets: num(process.env.MAX_TRACKED_WALLETS, 20),
    /** Un wallet non consulté depuis ce délai sort du suivi de fond. */
    trackedWalletTtlMs: num(process.env.TRACKED_WALLET_TTL_MS, 24 * 3_600_000),
    /** Limite par IP sur /api/positions. */
    positionsRateLimit: { max: 12, windowMs: 60_000 },
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

    /**
     * Fenêtre de dérivation du taux de fees.
     *
     * MESURÉ sur l'API : `cumulative_metrics.fees` n'augmente pas de façon
     * continue, il saute environ une fois par minute (20 intervalles nuls sur
     * 23 lectures à 5 s d'écart, sur la pool la plus active du marché).
     *
     * Dériver sur le seul dernier couple d'échantillons donne donc soit 0,
     * soit l'accumulé d'une minute divisé par 12 s — jamais le vrai débit.
     *
     * On remonte donc jusqu'à capter `minUpdates` sauts. La fenêtre est
     * ADAPTATIVE : elle se referme quand les sauts s'enchaînent (pool qui
     * s'emballe → chiffre réactif) et s'étire quand ils s'espacent (pool calme
     * → chiffre stable). La réactivité suit l'activité, pas la cadence de
     * sondage.
     */
    rate: {
      minUpdates: 3,
      /** Plancher : sous ça, la division amplifie le bruit d'échantillonnage. */
      minSpanMs: 45_000,
      /** Plafond : une pool inerte ne doit pas moyenner indéfiniment. */
      maxWindowMs: 600_000,
      /**
       * Sous ce taux, on affiche zéro. Mesuré : 39 % des taux positifs sont
       * sous $0,01/min et le plus petit vaut 2e-20 — de la poussière en
       * virgule flottante. $0,01/min = moins de $15/jour, rien d'exploitable.
       */
      minMeaningfulRate: 0.01,
    },
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

  /**
   * Display defaults. These are NOT hard filters like the old bot's — the UI
   * exposes them and the collector stores everything it sees.
   */
  display: {
    leaderboardSize: 100,
  },
} as const;

export type Protocol = "dlmm" | "damm_v2";
