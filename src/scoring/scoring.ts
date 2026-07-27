import { config } from "../config/config.js";
import type { HeatSample } from "../scanner/scanner.js";
import { expectedIlUsd } from "../pnl/il.js";
import { expectedMoveFraction, type StabilityMetrics } from "./volatility.js";

/**
 * Composite opportunity scoring + ex-ante profitability projection.
 *
 * The score ranks candidates; the projection (expected fees vs expected IL vs
 * fixed costs over the projection horizon) gates the actual entry. Both are
 * persisted for every evaluation so parameters can be calibrated offline.
 */

export interface OpportunityEvaluation {
  sample: HeatSample;
  stability: StabilityMetrics;
  score: number;
  scoreParts: Record<string, number>;
  /** Position sizing chosen for the projection (USD). */
  positionSizeUsd: number;
  /** Half-width of the projected range (fraction of price). */
  rangeHalfWidth: number;
  /** DLMM: half-width in bins. */
  binRange: number;
  expectedFeesUsd: number;
  expectedIlUsd: number;
  fixedCostsUsd: number;
  expectedNetUsd: number;
  /** Minutes of current fee flow needed to cover fixed costs. */
  breakevenMinutes: number;
  enter: boolean;
  rejectReason: string | null;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Choose the SPOT half-width: wide enough for the projection-horizon move, clamped. */
export function chooseRange(sample: HeatSample, stability: StabilityMetrics): {
  rangeHalfWidth: number;
  binRange: number;
} {
  const horizonMin = config.position.projectionHorizonMinutes;
  const move = expectedMoveFraction(stability, horizonMin) * config.position.rangeVolMultiplier;
  const binStep = sample.pool.binStep ?? 20; // DAMM v2: virtual bins of 0.2% for width math
  const binWidth = binStep / 10_000;
  const bins = Math.round(move / binWidth);
  const binRange = Math.max(config.position.binRangeMin, Math.min(config.position.binRangeMax, bins));
  return { rangeHalfWidth: binRange * binWidth, binRange };
}

export function choosePositionSize(capitalUsd: number, openExposureUsd: number): number {
  const p = config.risk.portfolio;
  const available = Math.max(0, capitalUsd - openExposureUsd);
  return Math.min(p.maxPositionUsd, capitalUsd * p.maxPositionPctOfCapital, available);
}

export function evaluateOpportunity(
  sample: HeatSample,
  stability: StabilityMetrics,
  capitalUsd: number,
  openExposureUsd: number,
): OpportunityEvaluation {
  const s = config.scoring;
  const { pool } = sample;

  // --- composite score (0..100) ----------------------------------------
  const parts: Record<string, number> = {
    // Heat: saturates at 5x the entry threshold.
    instantHeat: clamp01(sample.instantHeatPctPerHour / (s.minInstantHeatPctPerHour * 5)),
    // Acceleration: positive is good, normalized by current rate.
    feeAcceleration: clamp01(
      0.5 + sample.feeAcceleration / Math.max(1, sample.instantFeeRateUsdPerMin),
    ),
    // Turnover: 30m volume / TVL, saturates at 5.
    turnover30m: clamp01(pool.tvl > 0 ? pool.volume["30m"] / pool.tvl / 5 : 0),
    // Dynamic fee surge (DLMM): dynamic fee well above base fee = surge in progress.
    dynamicFee:
      pool.dynamicFeePct !== undefined && pool.baseFeePct > 0
        ? clamp01(pool.dynamicFeePct / (pool.baseFeePct * 3))
        : 0.3,
    stability: stability.stabilityScore,
    feeTvl30m: clamp01((pool.feeTvlRatio["30m"] * 100) / 5),
  };
  const weights = s.weights as Record<string, number>;
  let totalW = 0;
  let acc = 0;
  for (const [k, w] of Object.entries(weights)) {
    totalW += w;
    acc += w * (parts[k] ?? 0);
  }
  const score = (acc / Math.max(1e-9, totalW)) * 100;

  // --- projection --------------------------------------------------------
  const { rangeHalfWidth, binRange } = chooseRange(sample, stability);
  const positionSizeUsd = choosePositionSize(capitalUsd, openExposureUsd);
  const horizonMin = config.position.projectionHorizonMinutes;

  // Fee share model with self-dilution: our share of in-range liquidity.
  const inRangeTvl = pool.tvl * s.inRangeTvlFraction;
  const share = positionSizeUsd > 0 ? positionSizeUsd / (inRangeTvl + positionSizeUsd) : 0;
  const expectedFees = sample.instantFeeRateUsdPerMin * horizonMin * share;

  const move = expectedMoveFraction(stability, horizonMin);
  const expIl = expectedIlUsd(positionSizeUsd, rangeHalfWidth, move);

  const c = config.position.costs;
  const fixedCosts = c.openUsd + c.closeUsd + positionSizeUsd * c.slippageFraction * 2;
  const expectedNet = expectedFees - expIl - fixedCosts;
  const feePerMin = sample.instantFeeRateUsdPerMin * share;
  const breakevenMinutes = feePerMin > 0 ? fixedCosts / feePerMin : Number.POSITIVE_INFINITY;

  // --- entry gate ---------------------------------------------------------
  let rejectReason: string | null = null;
  if (sample.sampleCount < 3) rejectReason = "not enough fast samples";
  else if (sample.instantHeatPctPerHour < s.minInstantHeatPctPerHour)
    rejectReason = `heat ${sample.instantHeatPctPerHour.toFixed(2)}%/h < ${s.minInstantHeatPctPerHour}`;
  else if (sample.instantFeeRateUsdPerMin < s.minInstantFeeRateUsdPerMin)
    rejectReason = `fee rate $${sample.instantFeeRateUsdPerMin.toFixed(1)}/min < ${s.minInstantFeeRateUsdPerMin}`;
  else if (sample.feeAcceleration < s.minFeeAcceleration)
    rejectReason = `fees decelerating (${sample.feeAcceleration.toFixed(2)}/min²)`;
  else if (stability.netDriftPct > s.maxNetDrift15mPct)
    rejectReason = `trending ${stability.netDriftPct.toFixed(1)}% > ${s.maxNetDrift15mPct}%`;
  else if (stability.volumePerPctDrift < s.minVolumePerPctDrift)
    rejectReason = `directional flow (vol/drift ${Math.round(stability.volumePerPctDrift)})`;
  else if (score < s.minScore) rejectReason = `score ${score.toFixed(0)} < ${s.minScore}`;
  else if (positionSizeUsd < config.risk.portfolio.minPositionUsd)
    rejectReason = `size $${positionSizeUsd.toFixed(0)} below minimum`;
  else if (expectedNet < s.minExpectedNetUsd)
    rejectReason = `expected net $${expectedNet.toFixed(2)} < $${s.minExpectedNetUsd}`;
  else if (expectedNet < fixedCosts * (s.minNetToCostRatio - 1))
    rejectReason = `net/cost ratio too low`;
  else if (breakevenMinutes > s.maxBreakevenMinutes)
    rejectReason = `breakeven ${breakevenMinutes.toFixed(1)}min > ${s.maxBreakevenMinutes}`;

  return {
    sample,
    stability,
    score,
    scoreParts: parts,
    positionSizeUsd,
    rangeHalfWidth,
    binRange,
    expectedFeesUsd: expectedFees,
    expectedIlUsd: expIl,
    fixedCostsUsd: fixedCosts,
    expectedNetUsd: expectedNet,
    breakevenMinutes,
    enter: rejectReason === null,
    rejectReason,
  };
}
