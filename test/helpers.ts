import type { PoolView, TimeWindows, TokenInfo } from "../src/types/datapi.js";
import type { HeatSample } from "../src/scanner/scanner.js";

export const windows = (v: number): TimeWindows => ({
  "30m": v,
  "1h": v * 2,
  "2h": v * 4,
  "4h": v * 8,
  "12h": v * 24,
  "24h": v * 48,
});

export const token = (overrides: Partial<TokenInfo> = {}): TokenInfo => ({
  address: "So11111111111111111111111111111111111111112",
  name: "Wrapped SOL",
  symbol: "SOL",
  decimals: 9,
  is_verified: true,
  holders: 1_000_000,
  freeze_authority_disabled: true,
  total_supply: 0,
  price: 150,
  market_cap: 0,
  ...overrides,
});

export const pool = (overrides: Partial<PoolView> = {}): PoolView => ({
  protocol: "dlmm",
  address: "PoolAddr1111111111111111111111111111111111111",
  name: "TEST-SOL",
  tokenX: token({
    address: "TokenXMint111111111111111111111111111111111",
    symbol: "TEST",
    decimals: 6,
    price: 0.01,
    holders: 5_000,
  }),
  tokenY: token(),
  createdAtMs: Date.now() - 24 * 3_600_000,
  binStep: 20,
  baseFeePct: 0.2,
  collectFeeMode: 0,
  hasActiveFeeScheduler: false,
  dynamicFeePct: 1.5,
  tvl: 50_000,
  currentPrice: 0.01,
  volume: windows(300_000),
  fees: windows(1_500),
  feeTvlRatio: windows(0.015),
  cumulativeFeesUsd: 100_000,
  cumulativeVolumeUsd: 10_000_000,
  isBlacklisted: false,
  launchpad: "",
  tags: [],
  ...overrides,
});

export const heatSample = (overrides: Partial<HeatSample> = {}): HeatSample => ({
  pool: pool(),
  instantFeeRateUsdPerMin: 200,
  instantHeatPctPerHour: 24,
  feeAcceleration: 1,
  sampleCount: 5,
  ...overrides,
});
