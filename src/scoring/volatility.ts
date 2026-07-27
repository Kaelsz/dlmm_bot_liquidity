import type { OhlcvCandle } from "../types/datapi.js";

/**
 * Volatility / stability metrics from OHLCV candles.
 *
 * The finest timeframe the data API serves is 5m (verified live — no 1m),
 * so realized volatility is measured on 5m candles and scaled.
 */

export interface StabilityMetrics {
  /** Net |price drift| over the window, percent. */
  netDriftPct: number;
  /** Sum of candle ranges (high-low)/close, percent — "path travelled". */
  pathPct: number;
  /** Realized per-minute log-return volatility, percent. */
  realizedVolPerMinPct: number;
  /** Total candle volume over the window (USD-ish, quote units of the API). */
  totalVolume: number;
  /**
   * USD volume per 1% of net drift. High = churn in a range (great for LP),
   * low = directional flow (IL machine). Infinity when drift ~ 0.
   */
  volumePerPctDrift: number;
  /** 0..1 stability score used by the composite. */
  stabilityScore: number;
  candleCount: number;
}

export function computeStability(candles: OhlcvCandle[], candleMinutes = 5): StabilityMetrics {
  const empty: StabilityMetrics = {
    netDriftPct: 0,
    pathPct: 0,
    realizedVolPerMinPct: 0,
    totalVolume: 0,
    volumePerPctDrift: 0,
    stabilityScore: 0,
    candleCount: candles.length,
  };
  if (candles.length < 2) return empty;

  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (first.open <= 0 || last.close <= 0) return empty;

  const netDriftPct = Math.abs((last.close - first.open) / first.open) * 100;

  let pathPct = 0;
  let totalVolume = 0;
  const logReturns: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    if (c.close > 0) pathPct += ((c.high - c.low) / c.close) * 100;
    totalVolume += c.volume;
    if (i > 0) {
      const prev = sorted[i - 1]!;
      if (prev.close > 0 && c.close > 0) logReturns.push(Math.log(c.close / prev.close));
    }
  }

  const mean = logReturns.reduce((s, r) => s + r, 0) / Math.max(1, logReturns.length);
  const variance =
    logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, logReturns.length - 1);
  const volPerCandle = Math.sqrt(Math.max(0, variance));
  const realizedVolPerMinPct = (volPerCandle / Math.sqrt(candleMinutes)) * 100;

  const volumePerPctDrift = netDriftPct > 0.05 ? totalVolume / netDriftPct : totalVolume * 20;

  // Stability: lots of path & volume relative to net drift = oscillation.
  // pathPct / max(netDrift, eps) > 4 is a healthy range regime.
  const churnRatio = pathPct / Math.max(0.1, netDriftPct);
  const stabilityScore = Math.max(0, Math.min(1, (churnRatio - 1) / 6));

  return {
    netDriftPct,
    pathPct,
    realizedVolPerMinPct,
    totalVolume,
    volumePerPctDrift,
    stabilityScore,
    candleCount: candles.length,
  };
}

/** Expected |price move| (fraction, not %) over `minutes` from realized vol. */
export function expectedMoveFraction(m: StabilityMetrics, horizonMinutes: number): number {
  return (m.realizedVolPerMinPct / 100) * Math.sqrt(Math.max(0, horizonMinutes));
}
