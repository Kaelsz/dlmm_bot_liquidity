/**
 * Impermanent-loss estimation for a tight symmetric range position.
 *
 * For a concentrated position on [P·(1-w), P·(1+w)] entered at price P with
 * a 50/50 value split, the position behaves like a leveraged constant-product
 * share: within the range the divergence loss vs holding is amplified by
 * roughly the concentration factor 1/w relative to a full-range position;
 * once the price crosses a bound the position is 100% one-sided and loses
 * linearly with the remaining move.
 *
 * We use the closed-form value of a uniform-liquidity (SPOT) range position:
 * with sqrt-price s = sqrt(P_t/P_0), bounds sa = sqrt(1-w), sb = sqrt(1+w)
 * (normalized), position value relative to entry:
 *
 *   V(s) = (2·(s - sa) + (1/s - 1/sb)·s·...)  — rather than carrying the full
 * algebra inline, we use the standard Uniswap-v3 style formulas on
 * normalized liquidity L for a position entered exactly at the middle.
 */

export interface RangePositionModel {
  /** Entry price. */
  entryPrice: number;
  /** Lower/upper bound of the range. */
  lowerPrice: number;
  upperPrice: number;
  /** Position size in quote USD at entry. */
  sizeUsd: number;
}

/** Normalized liquidity L for value = 1 USD deposited at entryPrice (50/50-ish split per SPOT). */
function liquidityForOneUsd(p0: number, pa: number, pb: number): number {
  const sp = Math.sqrt(p0);
  const sa = Math.sqrt(pa);
  const sb = Math.sqrt(pb);
  // amounts for L=1: x = (sb - sp)/(sp*sb), y = sp - sa ; value = x*p0 + y
  const x = (sb - sp) / (sp * sb);
  const y = sp - sa;
  const valuePerL = x * p0 + y;
  return valuePerL > 0 ? 1 / valuePerL : 0;
}

/** Current USD value of the range position at price p (fees excluded). */
export function rangePositionValueUsd(model: RangePositionModel, p: number): number {
  const { entryPrice: p0, lowerPrice: pa, upperPrice: pb, sizeUsd } = model;
  if (p0 <= 0 || pa <= 0 || pb <= pa || sizeUsd <= 0) return sizeUsd;
  const L = liquidityForOneUsd(p0, pa, pb) * sizeUsd;
  const sa = Math.sqrt(pa);
  const sb = Math.sqrt(pb);
  const sp = Math.sqrt(Math.min(Math.max(p, pa), pb));
  const x = (sb - sp) / (sp * sb); // token X per L
  const y = sp - sa; // token Y (quote) per L
  const effP = Math.max(p, 0);
  // Below range: all X valued at current price. Above range: all Y (quote).
  return L * (x * effP + y);
}

/**
 * IL in USD (>= 0) of the range position vs simply holding the entry basket,
 * where the entry basket is the 50/50-ish token split at entry.
 */
export function rangeIlUsd(model: RangePositionModel, currentPrice: number): number {
  const { entryPrice: p0, lowerPrice: pa, upperPrice: pb, sizeUsd } = model;
  if (p0 <= 0 || pa <= 0 || pb <= pa || sizeUsd <= 0) return 0;
  const L = liquidityForOneUsd(p0, pa, pb) * sizeUsd;
  const sa = Math.sqrt(pa);
  const sb = Math.sqrt(pb);
  const s0 = Math.sqrt(p0);
  const x0 = L * ((sb - s0) / (s0 * sb));
  const y0 = L * (s0 - sa);
  const holdValue = x0 * currentPrice + y0;
  const lpValue = rangePositionValueUsd(model, currentPrice);
  return Math.max(0, holdValue - lpValue);
}

/**
 * Expected IL (USD) for a symmetric range of half-width w (fraction) given an
 * expected absolute price move (fraction) over the horizon. Used ex-ante by
 * the scoring projection.
 */
export function expectedIlUsd(sizeUsd: number, halfWidthFraction: number, expectedMoveFraction: number): number {
  if (sizeUsd <= 0 || halfWidthFraction <= 0) return 0;
  const p0 = 1;
  const model: RangePositionModel = {
    entryPrice: p0,
    lowerPrice: p0 * (1 - halfWidthFraction),
    upperPrice: p0 * (1 + halfWidthFraction),
    sizeUsd,
  };
  // Symmetric move assumption: average of up-move and down-move IL.
  const up = rangeIlUsd(model, p0 * (1 + expectedMoveFraction));
  const down = rangeIlUsd(model, p0 * (1 - expectedMoveFraction));
  return (up + down) / 2;
}
