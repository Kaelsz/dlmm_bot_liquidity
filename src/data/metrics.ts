/**
 * Derivation of the high-frequency fee signal.
 *
 * This is the product's differentiator. The Meteora list endpoints expose
 * nothing shorter than a 30-minute bucket, which is far too coarse to see a
 * pool start printing. But every row carries `cumulative_metrics.fees`, a
 * monotonically increasing counter — so sampling it and differentiating gives
 * a fee rate at whatever resolution we poll at.
 *
 * Everything here is pure so it can be unit-tested without network or DB.
 *
 * UNITS — the trap that bit the previous implementation:
 *   - `feeRateUsdPerMin` is USD/minute, derived by us.
 *   - `heatPctPerHour` converts a FRACTION (rate*60/tvl) to a percentage, so
 *     the *100 here is correct.
 *   - The API's own `fee_tvl_ratio` is ALREADY a percentage and must never be
 *     multiplied by 100. Do not confuse the two.
 */

export interface FeePoint {
  ts: number;
  /** `cumulative_metrics.fees` — monotonically increasing. */
  cumFees: number;
  tvl: number;
}

export interface DerivedMetrics {
  /** USD of fees per minute, from the most recent pair of samples. */
  feeRateUsdPerMin: number;
  /** Percent of TVL paid out as fees per hour, at the current rate. */
  heatPctPerHour: number;
  /** Second derivative: change in fee rate per minute. Positive = accelerating. */
  feeAccel: number;
  /** How many usable samples back the estimate. Below 2, nothing is derivable. */
  sampleCount: number;
  /** Highest rate seen in the retained history. */
  peakRateUsdPerMin: number;
  /** Consecutive most-recent samples whose rate stayed above `hotThreshold`. */
  hotStreak: number;
  /** Per-interval rates, oldest first — feeds the sparkline. */
  rateSeries: number[];
}

/**
 * Append a sample, dropping it when the cumulative counter goes backwards.
 *
 * Cumulative fees only ever increase; a lower reading means the API served a
 * stale value. Keeping it would produce a negative rate and, worse, a fake
 * spike on the following sample once the counter catches up.
 *
 * Returns the new history (the input is not mutated), or `undefined` when the
 * point was rejected.
 */
export function pushFeePoint(
  history: readonly FeePoint[],
  point: FeePoint,
  maxPoints: number,
): FeePoint[] | undefined {
  const last = history[history.length - 1];
  if (last) {
    if (point.cumFees < last.cumFees) return undefined;
    if (point.ts <= last.ts) return undefined;
  }
  const next = [...history, point];
  return next.length > maxPoints ? next.slice(next.length - maxPoints) : next;
}

/** Fee rate in USD/min between two samples. */
function rateBetween(a: FeePoint, b: FeePoint): number {
  const dtMin = (b.ts - a.ts) / 60_000;
  if (dtMin <= 0) return 0;
  const rate = (b.cumFees - a.cumFees) / dtMin;
  return rate > 0 ? rate : 0;
}

export function deriveMetrics(
  history: readonly FeePoint[],
  hotThreshold = 0,
): DerivedMetrics | undefined {
  if (history.length < 2) return undefined;

  const rateSeries: number[] = [];
  for (let i = 1; i < history.length; i += 1) {
    rateSeries.push(rateBetween(history[i - 1]!, history[i]!));
  }

  const curr = history[history.length - 1]!;
  const feeRateUsdPerMin = rateSeries[rateSeries.length - 1] ?? 0;

  const tvl = curr.tvl > 0 ? curr.tvl : 0;
  const heatPctPerHour = tvl > 0 ? ((feeRateUsdPerMin * 60) / tvl) * 100 : 0;

  let feeAccel = 0;
  if (rateSeries.length >= 2) {
    const prevRate = rateSeries[rateSeries.length - 2]!;
    const dtMin = (curr.ts - history[history.length - 2]!.ts) / 60_000;
    if (dtMin > 0) feeAccel = (feeRateUsdPerMin - prevRate) / dtMin;
  }

  const peakRateUsdPerMin = rateSeries.reduce((m, r) => (r > m ? r : m), 0);

  let hotStreak = 0;
  for (let i = rateSeries.length - 1; i >= 0; i -= 1) {
    if (rateSeries[i]! > hotThreshold) hotStreak += 1;
    else break;
  }

  return {
    feeRateUsdPerMin,
    heatPctPerHour,
    feeAccel,
    sampleCount: history.length,
    peakRateUsdPerMin,
    hotStreak,
    rateSeries,
  };
}

/**
 * Thermal tiers for the heat cell. Thresholds are in percent of TVL per hour.
 * `inert` covers pools that are technically alive but not worth a glance.
 */
export type HeatTier = "inert" | "cool" | "warm" | "hot" | "blazing" | "nuclear";

export function heatTier(heatPctPerHour: number): HeatTier {
  if (!Number.isFinite(heatPctPerHour) || heatPctPerHour < 0.5) return "inert";
  if (heatPctPerHour < 2) return "cool";
  if (heatPctPerHour < 5) return "warm";
  if (heatPctPerHour < 15) return "hot";
  if (heatPctPerHour < 40) return "blazing";
  return "nuclear";
}

/**
 * Annualised yield from the API's 24h fee/TVL percentage, compounded daily.
 * Reproduces the API's own `apy` (verified: SOL-USDC 0.0885% -> 38.11%) but
 * without the uint64 overflow it returns on young pools.
 */
export function annualisedPct(feeTvlRatio24hPct: number): number {
  if (!Number.isFinite(feeTvlRatio24hPct) || feeTvlRatio24hPct <= 0) return 0;
  return ((1 + feeTvlRatio24hPct / 100) ** 365 - 1) * 100;
}
