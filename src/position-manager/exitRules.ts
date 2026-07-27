import { config } from "../config/config.js";

/**
 * Exit rules — all evaluated in parallel on every monitoring tick, first
 * triggered wins. Pure functions: trivially unit-testable.
 */

export type ExitReason =
  | "FEE_DECAY"
  | "OUT_OF_RANGE"
  | "STOP_IL"
  | "TAKE_PROFIT"
  | "TIMEOUT"
  | "KILL_SWITCH";

export interface PositionMonitorState {
  openedAtMs: number;
  nowMs: number;
  entryPrice: number;
  currentPrice: number;
  lowerPrice: number;
  upperPrice: number;
  sizeUsd: number;
  /** Fee rate (USD/min for the whole pool) measured at entry. */
  entryFeeRateUsdPerMin: number;
  /** Latest derived pool fee rate (USD/min). */
  currentFeeRateUsdPerMin: number;
  /** Timestamp (ms) since when the fee rate has been continuously below the decay threshold; null if currently above. */
  feeDecaySinceMs: number | null;
  /** Current position value (tokens at current price, fees excluded), USD. */
  positionValueUsd: number;
  /** Fees earned so far (claimed + unclaimed), USD. */
  feesEarnedUsd: number;
  killSwitch: boolean;
}

export interface ExitDecision {
  exit: boolean;
  reason: ExitReason | null;
  detail: string;
}

export function evaluateExit(s: PositionMonitorState): ExitDecision {
  const ex = config.position.exits;

  if (s.killSwitch) return { exit: true, reason: "KILL_SWITCH", detail: "global kill switch" };

  // 2. Out of range — checked before fee decay: price leaving the range also
  // kills fee flow, but the correct label (and urgency) is OUT_OF_RANGE.
  if (s.currentPrice < s.lowerPrice || s.currentPrice > s.upperPrice) {
    return {
      exit: true,
      reason: "OUT_OF_RANGE",
      detail: `price ${s.currentPrice} outside [${s.lowerPrice}, ${s.upperPrice}]`,
    };
  }

  // 3. Stop IL: total position value incl. fees dropped too far below entry.
  const totalValue = s.positionValueUsd + s.feesEarnedUsd;
  const drawdown = (s.sizeUsd - totalValue) / s.sizeUsd;
  if (drawdown >= ex.stopIlFraction) {
    return {
      exit: true,
      reason: "STOP_IL",
      detail: `drawdown ${(drawdown * 100).toFixed(2)}% >= ${(ex.stopIlFraction * 100).toFixed(1)}%`,
    };
  }

  // 4. Take profit on net fees.
  if (s.feesEarnedUsd >= s.sizeUsd * ex.takeProfitFraction) {
    return {
      exit: true,
      reason: "TAKE_PROFIT",
      detail: `fees $${s.feesEarnedUsd.toFixed(2)} >= ${(ex.takeProfitFraction * 100).toFixed(1)}% of size`,
    };
  }

  // 1. Fee decay with grace period.
  if (s.feeDecaySinceMs !== null && s.nowMs - s.feeDecaySinceMs >= ex.feeDecayGraceMs) {
    return {
      exit: true,
      reason: "FEE_DECAY",
      detail: `fee rate ${s.currentFeeRateUsdPerMin.toFixed(2)}/min < ${(ex.feeDecayFraction * 100).toFixed(0)}% of entry ${s.entryFeeRateUsdPerMin.toFixed(2)}/min for ${Math.round((s.nowMs - s.feeDecaySinceMs) / 1000)}s`,
    };
  }

  // 5. Timeout — unconditional.
  if (s.nowMs - s.openedAtMs >= config.position.maxHoldMs) {
    return { exit: true, reason: "TIMEOUT", detail: `held ${Math.round((s.nowMs - s.openedAtMs) / 60_000)}min` };
  }

  return { exit: false, reason: null, detail: "" };
}

/** Helper maintaining the fee-decay clock across ticks. */
export function updateFeeDecayClock(
  prevSinceMs: number | null,
  entryRate: number,
  currentRate: number,
  nowMs: number,
): number | null {
  const below = currentRate < entryRate * config.position.exits.feeDecayFraction;
  if (!below) return null;
  return prevSinceMs ?? nowMs;
}
