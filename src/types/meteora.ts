import { z } from "zod";
import type { Protocol } from "@/config";

/**
 * Schemas for the Meteora data APIs (dlmm.datapi.meteora.ag and
 * damm-v2.datapi.meteora.ag). Both share the same envelope and the same
 * per-window bucket shape. Verified live 2026-08-01.
 *
 * Two things the previous implementation of this project got wrong, both
 * confirmed against live responses — do not reintroduce them:
 *
 *  1. `fee_tvl_ratio` is ALREADY A PERCENTAGE, not a fraction. On SOL-USDC,
 *     fees24h/TVL*100 = 0.0885 and the API returns 0.08850115. Multiplying by
 *     100 inflates every heat reading a hundredfold.
 *
 *  2. `apr` is not an APR. It is exactly `fee_tvl_ratio["24h"]` — the 24h
 *     fee/TVL percentage. `apy` IS annualised, but overflows to the uint64
 *     sentinel 18446744073709552000 on young pools, so it must be clamped.
 */

/** Every metric bucket the API exposes. There is nothing shorter than 30m. */
export const TimeWindowsSchema = z.object({
  "30m": z.number().catch(0),
  "1h": z.number().catch(0),
  "2h": z.number().catch(0),
  "4h": z.number().catch(0),
  "12h": z.number().catch(0),
  "24h": z.number().catch(0),
});
export type TimeWindows = z.infer<typeof TimeWindowsSchema>;
export type WindowKey = keyof TimeWindows;
export const WINDOW_KEYS: WindowKey[] = ["30m", "1h", "2h", "4h", "12h", "24h"];

export const TokenInfoSchema = z.object({
  address: z.string(),
  name: z.string().catch(""),
  symbol: z.string().catch(""),
  decimals: z.number().int().catch(0),
  is_verified: z.boolean().catch(false),
  holders: z.number().catch(0),
  freeze_authority_disabled: z.boolean().catch(false),
  total_supply: z.number().catch(0),
  price: z.number().catch(0),
  market_cap: z.number().catch(0),
});

export const PoolConfigSchema = z.object({
  bin_step: z.number().optional(),
  base_fee_pct: z.number().catch(0),
  max_fee_pct: z.number().optional(),
  protocol_fee_pct: z.number().catch(0),
  collect_fee_mode: z.number().catch(0),
  // DAMM v2 specifics.
  base_fee_mode: z.number().optional(),
  dynamic_fee_initialized: z.boolean().optional(),
  concentrated_liquidity: z.boolean().optional(),
  min_price: z.number().optional(),
  max_price: z.number().optional(),
  activation_point: z.number().optional(),
  has_fee_scheduler: z.boolean().optional(),
  is_fee_scheduler_active: z.boolean().optional(),
});

export const ApiPoolSchema = z.object({
  address: z.string(),
  name: z.string().catch(""),
  token_x: TokenInfoSchema,
  token_y: TokenInfoSchema,
  created_at: z.number().catch(0), // epoch ms
  pool_config: PoolConfigSchema,
  dynamic_fee_pct: z.number().optional(),
  tvl: z.number().catch(0),
  current_price: z.number().catch(0),
  volume: TimeWindowsSchema,
  fees: TimeWindowsSchema,
  fee_tvl_ratio: TimeWindowsSchema, // already a percentage
  cumulative_metrics: z.object({
    volume: z.number().catch(0),
    fees: z.number().catch(0),
  }),
  is_blacklisted: z.boolean().catch(false),
  launchpad: z.string().nullish().catch(null),
  tags: z.array(z.string()).catch([]),

  // Fields the previous schema omitted. Reserves give real depth, which is
  // what tells you whether a 3-minute-old pool is tradeable at all.
  reserve_x: z.string().optional(),
  reserve_y: z.string().optional(),
  token_x_amount: z.number().catch(0),
  token_y_amount: z.number().catch(0),
  protocol_fees: TimeWindowsSchema.optional(),
  apr: z.number().catch(0),
  apy: z.number().catch(0),
  has_farm: z.boolean().catch(false),
  farm_apr: z.number().catch(0),
  farm_apy: z.number().catch(0),
});
export type ApiPool = z.infer<typeof ApiPoolSchema>;

export const PoolListResponseSchema = z.object({
  total: z.number().catch(0),
  pages: z.number().catch(0),
  current_page: z.number().catch(0),
  page_size: z.number().catch(0),
  data: z.array(z.unknown()),
});

export const OhlcvCandleSchema = z.object({
  timestamp: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().catch(0),
});
export type OhlcvCandle = z.infer<typeof OhlcvCandleSchema>;

export const OhlcvResponseSchema = z.object({ data: z.array(OhlcvCandleSchema) });

/** The API rejects anything shorter — there is no 1m timeframe. */
export type OhlcvTimeframe = "5m" | "30m" | "1h" | "2h" | "4h" | "12h" | "24h";

export const TIMEFRAME_SECONDS: Record<OhlcvTimeframe, number> = {
  "5m": 300,
  "30m": 1_800,
  "1h": 3_600,
  "2h": 7_200,
  "4h": 14_400,
  "12h": 43_200,
  "24h": 86_400,
};

/**
 * Hard cap on candles per OHLCV request, found by bisection: 100 candles come
 * back fine, 101 returns an EMPTY ARRAY — not an error, not a truncated list.
 * A silent empty response is exactly the failure mode that looks like "this
 * pool has no trades", so any window must be sized against this.
 */
export const MAX_OHLCV_CANDLES = 100;

/**
 * Coarsest timeframe that still fills the window without exceeding the cap.
 * Returns undefined when even 24h candles would overflow (>100 days).
 */
export function timeframeForWindow(windowSeconds: number): OhlcvTimeframe | undefined {
  const order: OhlcvTimeframe[] = ["5m", "30m", "1h", "2h", "4h", "12h", "24h"];
  for (const tf of order) {
    if (windowSeconds / TIMEFRAME_SECONDS[tf] <= MAX_OHLCV_CANDLES) return tf;
  }
  return undefined;
}

/**
 * Sort fields accepted by `GET /pools?sort_by=<field>:<asc|desc>`.
 * Obtained verbatim from the API's own 400 error message. Note that
 * `apr_*` is listed but returns HTTP 500 — do not use it.
 */
export const SORT_FIELDS = [
  "fee_pct",
  "bin_step",
  "pool_created_at",
  "tvl",
  "volume_30m",
  "volume_1h",
  "volume_2h",
  "volume_4h",
  "volume_12h",
  "volume_24h",
  "fee_30m",
  "fee_1h",
  "fee_2h",
  "fee_4h",
  "fee_12h",
  "fee_24h",
  "fee_tvl_ratio_30m",
  "fee_tvl_ratio_1h",
  "fee_tvl_ratio_2h",
  "fee_tvl_ratio_4h",
  "fee_tvl_ratio_12h",
  "fee_tvl_ratio_24h",
  "base_token_market_cap",
  "quote_token_market_cap",
  "farm_apy",
] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export type SortSpec = `${SortField}:${"asc" | "desc"}`;

/** uint64 sentinel the API returns for `apy` on pools with almost no history. */
const APY_OVERFLOW_SENTINEL = 1e18;

/** Normalised, camel-cased shape everything downstream consumes. */
export interface PoolView {
  protocol: Protocol;
  address: string;
  name: string;
  tokenX: z.infer<typeof TokenInfoSchema>;
  tokenY: z.infer<typeof TokenInfoSchema>;
  createdAtMs: number;
  binStep: number | undefined;
  baseFeePct: number;
  collectFeeMode: number;
  hasActiveFeeScheduler: boolean;
  dynamicFeePct: number | undefined;
  tvl: number;
  currentPrice: number;
  volume: TimeWindows;
  fees: TimeWindows;
  /** Percentage, as returned by the API. Never multiply this by 100. */
  feeTvlRatioPct: TimeWindows;
  cumulativeFeesUsd: number;
  cumulativeVolumeUsd: number;
  reserveXAmount: number;
  reserveYAmount: number;
  /** Annualised yield in percent, or undefined when the API value overflowed. */
  apyPct: number | undefined;
  hasFarm: boolean;
  isBlacklisted: boolean;
  launchpad: string | null;
  tags: string[];
}

export function toPoolView(raw: ApiPool, protocol: Protocol): PoolView {
  return {
    protocol,
    address: raw.address,
    name: raw.name,
    tokenX: raw.token_x,
    tokenY: raw.token_y,
    createdAtMs: raw.created_at,
    binStep: raw.pool_config.bin_step,
    baseFeePct: raw.pool_config.base_fee_pct,
    collectFeeMode: raw.pool_config.collect_fee_mode,
    hasActiveFeeScheduler: raw.pool_config.is_fee_scheduler_active ?? false,
    dynamicFeePct: raw.dynamic_fee_pct,
    tvl: raw.tvl,
    currentPrice: raw.current_price,
    volume: raw.volume,
    fees: raw.fees,
    feeTvlRatioPct: raw.fee_tvl_ratio,
    cumulativeFeesUsd: raw.cumulative_metrics.fees,
    cumulativeVolumeUsd: raw.cumulative_metrics.volume,
    reserveXAmount: raw.token_x_amount,
    reserveYAmount: raw.token_y_amount,
    apyPct: raw.apy >= APY_OVERFLOW_SENTINEL || !Number.isFinite(raw.apy) ? undefined : raw.apy,
    hasFarm: raw.has_farm,
    isBlacklisted: raw.is_blacklisted,
    launchpad: raw.launchpad ?? null,
    tags: raw.tags,
  };
}
