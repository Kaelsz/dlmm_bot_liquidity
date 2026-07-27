import { randomUUID } from "node:crypto";
import { config } from "../config/config.js";
import { logger } from "../utils/logger.js";
import { rangePositionValueUsd, type RangePositionModel } from "../pnl/il.js";
import type { Protocol } from "../types/datapi.js";
import type {
  ClaimResult,
  ClosePositionResult,
  IPositionExecutor,
  LivePositionStatus,
  MarketFeedFn,
  MarketSnapshot,
  OpenPositionParams,
  OpenPositionResult,
} from "./types.js";

/**
 * DRY_RUN executor. Simulates the full lifecycle on REAL market data:
 *  - value of the range position from the actual pool price
 *  - fee accrual = real pool fee rate (Δ cumulative fees) × our simulated
 *    share of in-range liquidity, only while the price is inside the range
 *  - entry/exit slippage and fixed costs from the config cost model
 */

interface PaperPosition {
  model: RangePositionModel;
  protocol: Protocol;
  poolAddress: string;
  share: number;
  accruedFeesUsd: number;
  claimedFeesUsd: number;
  lastAccrualMs: number;
  openCostUsd: number;
}

export class PaperExecutor implements IPositionExecutor {
  readonly mode = "PAPER" as const;
  private readonly positions = new Map<string, PaperPosition>();

  constructor(private readonly feed: MarketFeedFn) {}

  async open(params: OpenPositionParams): Promise<OpenPositionResult> {
    const snap = await this.feed(params.protocol, params.poolAddress);
    const c = config.position.costs;
    const slippage = params.sizeUsd * c.slippageFraction;
    const share =
      params.sizeUsd / (snap.tvl * config.scoring.inRangeTvlFraction + params.sizeUsd);
    const positionAddress = `paper-${randomUUID()}`;
    this.positions.set(positionAddress, {
      model: {
        entryPrice: snap.price,
        lowerPrice: params.lowerPrice,
        upperPrice: params.upperPrice,
        sizeUsd: params.sizeUsd - slippage,
      },
      protocol: params.protocol,
      poolAddress: params.poolAddress,
      share,
      accruedFeesUsd: 0,
      claimedFeesUsd: 0,
      lastAccrualMs: Date.now(),
      openCostUsd: c.openUsd,
    });
    logger.info(
      { pool: params.poolName, size: params.sizeUsd, share: share.toFixed(4) },
      "[PAPER] position opened",
    );
    // Entry slippage is modeled by shrinking the deposited principal, so the
    // reported open cost carries only the fixed part (fees + rent).
    return { positionAddress, txSignature: null, openCostUsd: c.openUsd };
  }

  private accrue(p: PaperPosition, snap: MarketSnapshot): void {
    const now = Date.now();
    const dtMin = (now - p.lastAccrualMs) / 60_000;
    p.lastAccrualMs = now;
    const inRange = snap.price >= p.model.lowerPrice && snap.price <= p.model.upperPrice;
    if (inRange && dtMin > 0) {
      p.accruedFeesUsd += snap.poolFeeRateUsdPerMin * p.share * dtMin;
    }
  }

  async status(protocol: Protocol, poolAddress: string, positionAddress: string): Promise<LivePositionStatus> {
    const p = this.get(positionAddress);
    const snap = await this.feed(protocol, poolAddress);
    this.accrue(p, snap);
    return {
      positionValueUsd: rangePositionValueUsd(p.model, snap.price),
      unclaimedFeesUsd: p.accruedFeesUsd,
      currentPrice: snap.price,
      inRange: snap.price >= p.model.lowerPrice && snap.price <= p.model.upperPrice,
    };
  }

  async claim(protocol: Protocol, poolAddress: string, positionAddress: string): Promise<ClaimResult> {
    const p = this.get(positionAddress);
    const snap = await this.feed(protocol, poolAddress);
    this.accrue(p, snap);
    const claimed = p.accruedFeesUsd;
    p.claimedFeesUsd += claimed;
    p.accruedFeesUsd = 0;
    return { claimedUsd: claimed, txSignature: null };
  }

  async close(protocol: Protocol, poolAddress: string, positionAddress: string): Promise<ClosePositionResult> {
    const p = this.get(positionAddress);
    const snap = await this.feed(protocol, poolAddress);
    this.accrue(p, snap);
    const c = config.position.costs;
    const gross = rangePositionValueUsd(p.model, snap.price);
    const slippage = gross * c.slippageFraction;
    const claimed = p.accruedFeesUsd;
    p.accruedFeesUsd = 0;
    this.positions.delete(positionAddress);
    // Exit slippage is netted from the recovered value; closeCostUsd carries
    // only the fixed part so PnL = recovered + fees - size - open - close
    // counts each cost exactly once.
    return {
      txSignature: null,
      recoveredUsd: gross - slippage,
      claimedUsd: claimed,
      closeCostUsd: c.closeUsd,
    };
  }

  private get(positionAddress: string): PaperPosition {
    const p = this.positions.get(positionAddress);
    if (!p) throw new Error(`unknown paper position ${positionAddress}`);
    return p;
  }
}
