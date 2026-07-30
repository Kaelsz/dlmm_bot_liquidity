import "dotenv/config";
import { z } from "zod";

/**
 * Central configuration of the bot.
 *
 * Every threshold mentioned in the strategy lives here with a commented,
 * conservative default. Values can be overridden through environment
 * variables (secrets, mode, RPC) — strategy parameters are edited here.
 */

const EnvSchema = z.object({
  DRY_RUN: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  RPC_SEND_URL: z.string().default(""),
  WALLET_KEYPAIR_PATH: z.string().default(""),
  WALLET_SECRET_KEY_B58: z.string().default(""),
  CAPITAL_USD: z.coerce.number().positive().default(1000),
  DISCORD_WEBHOOK_URL: z.string().default(""),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_ID: z.string().default(""),
  DB_PATH: z.string().default("data/bot.db"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(8787),
});

const env = EnvSchema.parse(process.env);

export const config = {
  /** Global mode. true => no transaction is ever sent. */
  dryRun: env.DRY_RUN,

  solana: {
    rpcUrl: env.RPC_URL,
    /** Optional separate endpoint used only for sendTransaction. */
    rpcSendUrl: env.RPC_SEND_URL || env.RPC_URL,
    walletKeypairPath: env.WALLET_KEYPAIR_PATH,
    walletSecretKeyB58: env.WALLET_SECRET_KEY_B58,
    /** Commitment used for tx confirmation before accounting re-check. */
    commitment: "confirmed" as const,
    /** Max priority fee we are willing to pay, in micro-lamports per CU. */
    maxPriorityFeeMicroLamports: 2_000_000,
    /** Multiplier applied to the median of getRecentPrioritizationFees. */
    priorityFeeMultiplier: 1.5,
    /** Compute unit limit for position transactions. */
    computeUnitLimit: 800_000,
    /** Max attempts for send+confirm (with blockhash re-fetch). */
    sendMaxRetries: 4,
  },

  storage: {
    dbPath: env.DB_PATH,
  },

  log: {
    level: env.LOG_LEVEL,
  },

  dashboard: {
    port: env.DASHBOARD_PORT,
  },

  datapi: {
    dlmmBaseUrl: "https://dlmm.datapi.meteora.ag",
    dammV2BaseUrl: "https://damm-v2.datapi.meteora.ag",
    /** Hard rate limits documented by Meteora. We stay well under. */
    dlmmMaxReqPerSec: 20, // documented ~30/s, keep headroom
    dammV2MaxReqPerSec: 6, // documented ~10/s, keep headroom
    /** HTTP timeout per request (ms). */
    requestTimeoutMs: 10_000,
    /** Exponential backoff base delay on 429/5xx (ms). */
    backoffBaseMs: 500,
    backoffMaxMs: 30_000,
  },

  scanner: {
    /** Broad scan interval (all candidate pools via sorted pages). */
    broadScanIntervalMs: 90_000,
    /** Pages of page_size pools fetched per sort key during broad scan. */
    broadScanPages: 3,
    broadScanPageSize: 100,
    /**
     * Fast poll interval on the watchlist (drives the fees/min signal).
     * 76% of observed fee bursts die in under 2 minutes: detection latency
     * is the dominant edge, so poll aggressively (still far below the API
     * rate limits with a 25-pool watchlist per protocol).
     */
    fastPollIntervalMs: 12_000,
    /** Max pools kept on the watchlist per protocol. */
    watchlistMaxSize: 25,
    /** A pool must show at least this fee/TVL over 30m to enter the watchlist (1 = 1%). */
    watchlistMinFeeTvl30mPct: 0.35,
    /** heat_30m (annualized-ish, per-30m) must exceed heat_24h/48 * this factor => "anomaly" filter. */
    watchlistMinHeatRatio: 3,
    /** Pools with less TVL than this are ignored entirely (USD). */
    minTvlUsd: 20_000,
    /** Pools with more TVL than this are ignored (our deposit would be diluted / not a sniper target). */
    maxTvlUsd: 5_000_000,
    /** Drop watchlist entries not re-qualified after this long (ms). */
    watchlistTtlMs: 15 * 60_000,
    /** Snapshots older than this are pruned from SQLite (ms). */
    snapshotRetentionMs: 24 * 3_600_000,
  },

  scoring: {
    /**
     * Entry threshold on the derived instantaneous heat:
     * (Δfees / TVL) per hour, in percent. 2 means the pool prints 2% of its
     * TVL in fees per hour right now — extremely selective on purpose.
     */
    minInstantHeatPctPerHour: 2.0,
    /**
     * Minimum absolute derived fee rate (USD/min). Raised from 25 after the
     * 24h paper run: with ~$2.50 of fixed costs per round-trip, only strong
     * printers amortize the entry fast enough.
     */
    minInstantFeeRateUsdPerMin: 50,
    /**
     * Burst persistence gate: the heat must have stayed above the entry
     * threshold for at least this many consecutive fast samples. Kills the
     * sub-2-minute bursts that produced 100% of the losing paper entries.
     */
    minConsecutiveHotSamples: 3,
    /** Current rate must still be at least this fraction of the recent peak (reject post-peak entries). */
    minRateVsPeakFraction: 0.5,
    /**
     * Pre-entry recheck: after all gates pass, wait this long, re-poll the
     * pool and require the fresh rate to still be at least
     * entryRecheckMinFraction of the rate that triggered the signal.
     */
    entryRecheckDelayMs: 8_000,
    entryRecheckMinFraction: 0.4,
    /** Require fee acceleration >= this (USD/min per min; 0 = flat is acceptable, never negative). */
    minFeeAcceleration: 0,
    /**
     * Stability filter: |price drift| over the confirmation window divided by
     * realized range. Volume-in-range is good, violent trend is bad.
     * We require volumePerAbsPriceMovePct >= this many USD of volume per 1% of net drift.
     */
    minVolumePerPctDrift: 30_000,
    /** Max absolute net price drift over the last 15 minutes (%). Above this it's a trend, not a range. */
    maxNetDrift15mPct: 12,
    /** Composite score weights (normalized internally). */
    weights: {
      instantHeat: 0.35,
      feeAcceleration: 0.15,
      turnover30m: 0.15,
      dynamicFee: 0.1,
      stability: 0.15,
      feeTvl30m: 0.1,
    },
    /** Minimum composite score (0..100) to consider entry. */
    minScore: 55,
    /** Expected net profit (USD) must exceed this before entering. */
    minExpectedNetUsd: 5,
    /** Expected net must also exceed this multiple of fixed costs. */
    minNetToCostRatio: 1.5,
    /**
     * Share dilution model: fraction of pool TVL assumed to sit inside our
     * tight range (liquidity is concentrated around the active bin on hot
     * pools). Used to project our fee share: share = size / (tvl*inRangeFraction + size).
     */
    inRangeTvlFraction: 0.3,
    /** Max minutes to breakeven accepted (must recover fixed costs quickly). */
    maxBreakevenMinutes: 4,
  },

  risk: {
    /** Quote side whitelist — pools must be against one of these mints. */
    quoteWhitelist: [
      "So11111111111111111111111111111111111111112", // wSOL
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    ],
    /** Minimum holders of the non-quote token. */
    minHolders: 500,
    /** Minimum age of the pool (ms). Very young pools are sniper bait. */
    minPoolAgeMs: 30 * 60_000,
    /** Reject Token-2022 mints with a transfer fee above this many bps (checked on-chain in live mode). */
    maxTransferFeeBps: 0,

    rugcheck: {
      baseUrl: "https://api.rugcheck.xyz",
      /** Reject when normalized risk score exceeds this (RugCheck: higher = riskier). */
      maxScoreNormalised: 40,
      /** Any risk item at this level rejects the token outright. */
      rejectLevels: ["danger"],
      /** Cache TTL for verdicts (ms). */
      cacheTtlMs: 5 * 60_000,
      requestTimeoutMs: 8_000,
      /**
       * Fail-closed: when RugCheck is unreachable the token is treated as
       * unsafe. Never flip this to fail-open.
       */
      failClosed: true,
    },

    portfolio: {
      /** Max size of a single position as a fraction of capital. Raised to
       *  0.5 after the 24h paper run: $2.50 of fixed costs on a $250 position
       *  is a 1% hurdle before the first dollar of profit. */
      maxPositionPctOfCapital: 0.5,
      /** Hard cap per position (USD). */
      maxPositionUsd: 500,
      /** Minimum position size worth the fixed costs (USD). */
      minPositionUsd: 100,
      /** Max simultaneously open positions. */
      maxOpenPositions: 3,
      /** Max exposure to a single non-quote mint across positions (USD). */
      maxExposurePerTokenUsd: 500,
      /** SOL kept aside for tx fees / emergency exits — never deployed. */
      reserveSol: 0.05,
    },

    killSwitch: {
      /** Consecutive RPC/API failures before the kill switch trips. */
      maxConsecutiveErrors: 8,
      /** SOL price collapse vs entry-time reference (%) that trips the switch. */
      solDepegPct: 15,
    },
  },

  position: {
    /** SPOT range half-width in bins for DLMM (active ± N). Adapted to volatility between min/max. */
    binRangeMin: 3,
    binRangeMax: 10,
    /**
     * Target: range half-width ≈ realized 10-min price move * this multiplier,
     * translated into bins with the pool's bin_step. Clamped to [min,max].
     */
    rangeVolMultiplier: 1.5,
    /**
     * Optional max holding time (ms). null = no time-based exit: the position
     * stays open until take-profit, stop-loss, out-of-range or fee decay
     * triggers. Set a number (e.g. 10 * 60_000) to restore a hard timeout.
     */
    maxHoldMs: null as number | null,
    /**
     * Horizon (minutes) used by the ex-ante projection and range sizing.
     * Decoupled from maxHoldMs so projections stay bounded even without a
     * time-based exit.
     */
    projectionHorizonMinutes: 10,
    /** Monitoring loop period for open positions (ms). */
    monitorIntervalMs: 10_000,
    /** Claim fees at this interval while in position (ms). */
    claimIntervalMs: 60_000,

    exits: {
      /** Fee decay: derived fees/min below this fraction of entry rate... */
      feeDecayFraction: 0.35,
      /** ...for at least this long (ms) => exit. */
      feeDecayGraceMs: 45_000,
      /** Out of range: price beyond position bounds (or > drift bins) => immediate exit. */
      maxBinsDrift: 12,
      /** Stop-loss: total position value (tokens + fees) below entry − 6% => exit. */
      stopIlFraction: 0.06,
      /** Take profit: +6% of position size in net fees => exit and recycle. */
      takeProfitFraction: 0.06,
    },

    /** Fixed cost model used by projections and paper PnL (USD). */
    costs: {
      openUsd: 1.5, // priority fees + rent non-refundable part + ATA churn
      closeUsd: 1.0,
      /** One-way slippage applied on entry and exit in paper mode / projections (fraction). */
      slippageFraction: 0.003,
    },
  },

  paper: {
    /** Capital used by the simulator (USD). */
    capitalUsd: env.CAPITAL_USD,
  },

  backup: {
    /**
     * The bot commits its own state to git on this interval. The remote
     * environment restores containers from snapshots, so git is the only
     * storage that survives a rollback — and an external scheduler cannot be
     * relied on because it does not fire while the container is asleep.
     * Observed rollback period is under 30 minutes, so this is the bound on
     * how much of a run can be lost: keep it well below that.
     */
    intervalMs: 5 * 60_000,
    exportPath: "data/state-export.json",
    branch: "claude/best-bot-possible-cykt67",
    /** Opportunities newer than this are included in the export. */
    opportunityWindowMs: 48 * 3_600_000,
  },

  notifier: {
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID,
  },
} as const;

export type BotConfig = typeof config;
