import { z } from "zod";

/**
 * Zod schemas for the Meteora data APIs
 * (https://dlmm.datapi.meteora.ag and https://damm-v2.datapi.meteora.ag).
 *
 * Schemas were frozen against live responses (2026-07): both APIs share the
 * same envelope `{total, pages, current_page, page_size, data: []}` and the
 * same per-window buckets. Unknown fields are tolerated (passthrough-free
 * parsing with .catch/.optional where the APIs are inconsistent).
 */

export const TimeWindowsSchema = z.object({
  "30m": z.number().catch(0),
  "1h": z.number().catch(0),
  "2h": z.number().catch(0),
  "4h": z.number().catch(0),
  "12h": z.number().catch(0),
  "24h": z.number().catch(0),
});
export type TimeWindows = z.infer<typeof TimeWindowsSchema>;

export const TokenInfoSchema = z.object({
  address: z.string(),
  name: z.string().catch(""),
  symbol: z.string().catch("?"),
  decimals: z.number().int(),
  is_verified: z.boolean().catch(false),
  holders: z.number().catch(0),
  freeze_authority_disabled: z.boolean().catch(false),
  total_supply: z.number().catch(0),
  price: z.number().catch(0),
  market_cap: z.number().catch(0),
});
export type TokenInfo = z.infer<typeof TokenInfoSchema>;

/** DLMM pool_config (bin_step present) vs DAMM v2 pool_config (fee scheduler flags). */
export const PoolConfigSchema = z
  .object({
    bin_step: z.number().optional(),
    base_fee_pct: z.number().catch(0),
    max_fee_pct: z.number().optional(),
    protocol_fee_pct: z.number().catch(0),
    collect_fee_mode: z.number().catch(0),
    // DAMM v2 specifics
    base_fee_mode: z.number().optional(),
    dynamic_fee_initialized: z.boolean().optional(),
    concentrated_liquidity: z.boolean().optional(),
    min_price: z.number().optional(),
    max_price: z.number().optional(),
    activation_point: z.number().optional(),
    has_fee_scheduler: z.boolean().optional(),
    is_fee_scheduler_active: z.boolean().optional(),
  })
  .partial({ base_fee_pct: true, protocol_fee_pct: true, collect_fee_mode: true });
export type PoolConfig = z.infer<typeof PoolConfigSchema>;

export const ApiPoolSchema = z.object({
  address: z.string(),
  name: z.string().catch(""),
  token_x: TokenInfoSchema,
  token_y: TokenInfoSchema,
  created_at: z.number().catch(0), // epoch ms
  pool_config: PoolConfigSchema.catch({}),
  dynamic_fee_pct: z.number().optional().catch(undefined),
  tvl: z.number().catch(0),
  current_price: z.number().catch(0),
  volume: TimeWindowsSchema,
  fees: TimeWindowsSchema,
  fee_tvl_ratio: TimeWindowsSchema,
  cumulative_metrics: z
    .object({ volume: z.number().catch(0), fees: z.number().catch(0) })
    .catch({ volume: 0, fees: 0 }),
  is_blacklisted: z.boolean().catch(false),
  launchpad: z.string().catch(""),
  tags: z.array(z.string()).catch([]),
});
export type ApiPool = z.infer<typeof ApiPoolSchema>;

export const PoolListResponseSchema = z.object({
  total: z.number(),
  pages: z.number(),
  current_page: z.number(),
  page_size: z.number(),
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

export const OhlcvResponseSchema = z.object({
  data: z.array(OhlcvCandleSchema).catch([]),
});

/** Timeframes actually accepted by /ohlcv (verified live — there is no 1m). */
export type OhlcvTimeframe = "5m" | "30m" | "1h" | "2h" | "4h" | "12h" | "24h";

export type Protocol = "dlmm" | "damm_v2";

/** Normalized pool view shared by scanner/scoring regardless of protocol. */
export interface PoolView {
  protocol: Protocol;
  address: string;
  name: string;
  tokenX: TokenInfo;
  tokenY: TokenInfo;
  createdAtMs: number;
  binStep: number | undefined; // DLMM only
  baseFeePct: number;
  collectFeeMode: number;
  hasActiveFeeScheduler: boolean; // DAMM v2 only
  dynamicFeePct: number | undefined;
  tvl: number;
  currentPrice: number;
  volume: TimeWindows;
  fees: TimeWindows;
  feeTvlRatio: TimeWindows;
  cumulativeFeesUsd: number;
  cumulativeVolumeUsd: number;
  isBlacklisted: boolean;
  launchpad: string;
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
    baseFeePct: raw.pool_config.base_fee_pct ?? 0,
    collectFeeMode: raw.pool_config.collect_fee_mode ?? 0,
    hasActiveFeeScheduler: raw.pool_config.is_fee_scheduler_active ?? false,
    dynamicFeePct: raw.dynamic_fee_pct,
    tvl: raw.tvl,
    currentPrice: raw.current_price,
    volume: raw.volume,
    fees: raw.fees,
    feeTvlRatio: raw.fee_tvl_ratio,
    cumulativeFeesUsd: raw.cumulative_metrics.fees,
    cumulativeVolumeUsd: raw.cumulative_metrics.volume,
    isBlacklisted: raw.is_blacklisted,
    launchpad: raw.launchpad,
    tags: raw.tags,
  };
}
