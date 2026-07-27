import type { Protocol } from "../types/datapi.js";

/**
 * Common execution interface implemented by the paper simulator and by the
 * live DLMM / DAMM v2 executors. The position manager only talks to this.
 */

export interface TokenRef {
  mint: string;
  decimals: number;
  priceUsd: number;
}

export interface OpenPositionParams {
  protocol: Protocol;
  poolAddress: string;
  poolName: string;
  sizeUsd: number;
  currentPrice: number;
  lowerPrice: number;
  upperPrice: number;
  binRange: number;
  tokenX: TokenRef;
  tokenY: TokenRef;
}

/** Live market data injected into executors (built from datapi + scanner). */
export interface MarketSnapshot {
  price: number;
  tvl: number;
  /** Whole-pool fee rate, USD/min, derived from cumulative fee deltas. */
  poolFeeRateUsdPerMin: number;
  tokenXPriceUsd: number;
  tokenYPriceUsd: number;
  tokenXDecimals: number;
  tokenYDecimals: number;
}

export type MarketFeedFn = (protocol: Protocol, poolAddress: string) => Promise<MarketSnapshot>;

export interface OpenPositionResult {
  /** On-chain position address (or synthetic id in paper mode). */
  positionAddress: string;
  txSignature: string | null;
  /** Actual USD cost paid to open (fees + rent + slippage estimate). */
  openCostUsd: number;
}

export interface ClaimResult {
  claimedUsd: number;
  txSignature: string | null;
}

export interface ClosePositionResult {
  txSignature: string | null;
  /** USD value recovered (tokens swapped/valued at exit). */
  recoveredUsd: number;
  /** Fees claimed as part of the close, USD. */
  claimedUsd: number;
  closeCostUsd: number;
}

export interface LivePositionStatus {
  /** Present value of position tokens at current price (fees excluded), USD. */
  positionValueUsd: number;
  /** Unclaimed fees, USD. */
  unclaimedFeesUsd: number;
  currentPrice: number;
  inRange: boolean;
}

export interface IPositionExecutor {
  readonly mode: "PAPER" | "LIVE";
  open(params: OpenPositionParams): Promise<OpenPositionResult>;
  status(protocol: Protocol, poolAddress: string, positionAddress: string): Promise<LivePositionStatus>;
  claim(protocol: Protocol, poolAddress: string, positionAddress: string): Promise<ClaimResult>;
  close(protocol: Protocol, poolAddress: string, positionAddress: string): Promise<ClosePositionResult>;
}
