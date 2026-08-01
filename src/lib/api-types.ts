import type { LeaderboardRow } from "@/db";

/** Wire format for the table. Sparkline is decoded server-side so the client
 *  never parses JSON per row. */
export interface PoolRow {
  address: string;
  protocol: "dlmm" | "damm_v2";
  name: string;
  tokenXMint: string;
  binStep: number | null;
  baseFeePct: number;
  dynamicFeePct: number | null;
  createdAt: number;
  isBlacklisted: boolean;
  launchpad: string | null;
  tokenXHolders: number;
  tokenXVerified: boolean;
  tokenXFreezeDisabled: boolean;
  ts: number;
  feeRateUsdMin: number;
  heatPctHr: number;
  feeAccel: number;
  hotStreak: number;
  sampleCount: number;
  sparkline: number[];
  tvl: number;
  price: number;
  volume30m: number;
  fees30m: number;
  feeTvl30mPct: number;
  feeTvl24hPct: number;
  apyPct: number | null;
}

export interface PoolsResponse {
  rows: PoolRow[];
  generatedAt: number;
  counts: { pools: number; samples: number; metrics: number };
}

export function toPoolRow(r: LeaderboardRow): PoolRow {
  let sparkline: number[] = [];
  try {
    const parsed: unknown = JSON.parse(r.sparklineJson);
    if (Array.isArray(parsed)) sparkline = parsed.filter((n): n is number => typeof n === "number");
  } catch {
    // A malformed row should cost one sparkline, not the whole response.
  }
  return {
    address: r.address,
    protocol: r.protocol as "dlmm" | "damm_v2",
    name: r.name,
    tokenXMint: r.tokenXMint,
    binStep: r.binStep,
    baseFeePct: r.baseFeePct,
    dynamicFeePct: r.dynamicFeePct,
    createdAt: r.createdAt,
    isBlacklisted: r.isBlacklisted === 1,
    launchpad: r.launchpad,
    tokenXHolders: r.tokenXHolders,
    tokenXVerified: r.tokenXVerified === 1,
    tokenXFreezeDisabled: r.tokenXFreezeDisabled === 1,
    ts: r.ts,
    feeRateUsdMin: r.feeRateUsdMin,
    heatPctHr: r.heatPctHr,
    feeAccel: r.feeAccel,
    hotStreak: r.hotStreak,
    sampleCount: r.sampleCount,
    sparkline,
    tvl: r.tvl,
    price: r.price,
    volume30m: r.volume30m,
    fees30m: r.fees30m,
    feeTvl30mPct: r.feeTvl30mPct,
    feeTvl24hPct: r.feeTvl24hPct,
    apyPct: r.apyPct,
  };
}
