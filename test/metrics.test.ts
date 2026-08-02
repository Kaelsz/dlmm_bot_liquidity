import { describe, expect, it } from "vitest";
import {
  annualisedPct,
  deriveMetrics,
  heatTier,
  pushFeePoint,
  type FeePoint,
} from "../src/data/metrics";

const M = 60_000;

/** Builds a history from [minutesFromStart, cumulativeFees] pairs.
 *  Cumulative volume trails fees by a constant factor unless a test overrides
 *  it, so fee assertions are unaffected by its presence. */
const hist = (pairs: Array<[number, number]>, tvl = 10_000): FeePoint[] =>
  pairs.map(([min, cumFees]) => ({ ts: min * M, cumFees, cumVolume: cumFees * 100, tvl }));

describe("pushFeePoint", () => {
  it("drops readings where cumulative fees go backwards", () => {
    const h = hist([
      [0, 100],
      [1, 150],
    ]);
    // A stale API read reports less than we already banked.
    expect(pushFeePoint(h, { ts: 2 * M, cumFees: 120, cumVolume: 12_000, tvl: 10_000 }, 20)).toBeUndefined();
    // A normal increase is accepted.
    expect(pushFeePoint(h, { ts: 2 * M, cumFees: 200, cumVolume: 20_000, tvl: 10_000 }, 20)).toHaveLength(3);
  });

  it("drops out-of-order timestamps", () => {
    const h = hist([[5, 100]]);
    expect(pushFeePoint(h, { ts: 4 * M, cumFees: 200, cumVolume: 20_000, tvl: 1 }, 20)).toBeUndefined();
  });

  it("caps the history and keeps the newest points", () => {
    let h: FeePoint[] = [];
    for (let i = 0; i < 10; i += 1) {
      h = pushFeePoint(h, { ts: i * M, cumFees: i * 10, cumVolume: i * 1_000, tvl: 1 }, 4)!;
    }
    expect(h).toHaveLength(4);
    expect(h[h.length - 1]!.cumFees).toBe(90);
  });

  it("does not mutate the input", () => {
    const h = hist([[0, 100]]);
    pushFeePoint(h, { ts: M, cumFees: 200, cumVolume: 20_000, tvl: 1 }, 20);
    expect(h).toHaveLength(1);
  });
});

describe("deriveMetrics", () => {
  it("needs at least two samples", () => {
    expect(deriveMetrics(hist([[0, 100]]))).toBeUndefined();
  });

  it("derives the volume rate from the last interval, like fees", () => {
    // $12k of volume over 2 minutes => $6k/min. The API's shortest bucket is
    // 30 minutes, so this resolution exists nowhere else.
    const h: FeePoint[] = [
      { ts: 0, cumFees: 0, cumVolume: 0, tvl: 10_000 },
      { ts: M, cumFees: 10, cumVolume: 5_000, tvl: 10_000 },
      { ts: 3 * M, cumFees: 40, cumVolume: 17_000, tvl: 10_000 },
    ];
    expect(deriveMetrics(h)!.volumeRateUsdPerMin).toBeCloseTo(6_000);
  });

  it("clamps a volume counter that goes backwards", () => {
    // Fees still advance, so the sample is kept; only the stale volume is
    // neutralised rather than reported as a negative rate.
    const h: FeePoint[] = [
      { ts: 0, cumFees: 0, cumVolume: 50_000, tvl: 10_000 },
      { ts: M, cumFees: 10, cumVolume: 40_000, tvl: 10_000 },
    ];
    const m = deriveMetrics(h)!;
    expect(m.volumeRateUsdPerMin).toBe(0);
    expect(m.feeRateUsdPerMin).toBeCloseTo(10);
  });

  it("computes the fee rate from the last interval", () => {
    // $60 earned over 2 minutes => $30/min.
    const m = deriveMetrics(hist([
      [0, 0],
      [2, 60],
    ]))!;
    expect(m.feeRateUsdPerMin).toBeCloseTo(30, 9);
  });

  it("expresses heat as a percentage of TVL per hour", () => {
    // $10/min on $10k TVL => $600/h => 6% of TVL per hour.
    const m = deriveMetrics(hist(
      [
        [0, 0],
        [1, 10],
      ],
      10_000,
    ))!;
    expect(m.heatPctPerHour).toBeCloseTo(6, 9);
  });

  it("reports acceleration when the rate increases", () => {
    // 10/min then 30/min over 1-minute steps => +20 per minute.
    const m = deriveMetrics(hist([
      [0, 0],
      [1, 10],
      [2, 40],
    ]))!;
    expect(m.feeRateUsdPerMin).toBeCloseTo(30, 9);
    expect(m.feeAccel).toBeCloseTo(20, 9);
  });

  it("reports negative acceleration when the burst fades", () => {
    const m = deriveMetrics(hist([
      [0, 0],
      [1, 100],
      [2, 110],
    ]))!;
    expect(m.feeAccel).toBeLessThan(0);
  });

  it("tracks the peak rate across the retained history", () => {
    const m = deriveMetrics(hist([
      [0, 0],
      [1, 500], // 500/min
      [2, 510], // 10/min
    ]))!;
    expect(m.peakRateUsdPerMin).toBeCloseTo(500, 9);
    expect(m.feeRateUsdPerMin).toBeCloseTo(10, 9);
  });

  it("counts a hot streak only while the rate stays above the threshold", () => {
    const m = deriveMetrics(
      hist([
        [0, 0],
        [1, 100], // 100/min  hot
        [2, 100], // 0/min    cold -> breaks the streak
        [3, 200], // 100/min  hot
        [4, 300], // 100/min  hot
      ]),
      50,
    )!;
    expect(m.hotStreak).toBe(2);
  });

  it("never yields a negative rate and survives a zero TVL", () => {
    const m = deriveMetrics(hist(
      [
        [0, 100],
        [1, 100],
      ],
      0,
    ))!;
    expect(m.feeRateUsdPerMin).toBe(0);
    expect(m.heatPctPerHour).toBe(0);
  });

  it("exposes one rate per interval for the sparkline", () => {
    const m = deriveMetrics(hist([
      [0, 0],
      [1, 10],
      [2, 20],
      [3, 30],
    ]))!;
    expect(m.rateSeries).toHaveLength(3);
  });
});

describe("heatTier", () => {
  it("maps the thermal scale by threshold", () => {
    expect(heatTier(0)).toBe("inert");
    expect(heatTier(0.49)).toBe("inert");
    expect(heatTier(0.5)).toBe("cool");
    expect(heatTier(1.9)).toBe("cool");
    expect(heatTier(2)).toBe("warm");
    expect(heatTier(5)).toBe("hot");
    expect(heatTier(15)).toBe("blazing");
    expect(heatTier(40)).toBe("nuclear");
    expect(heatTier(1e6)).toBe("nuclear");
  });

  it("treats non-finite input as inert rather than throwing", () => {
    expect(heatTier(Number.NaN)).toBe("inert");
  });
});

describe("annualisedPct", () => {
  it("reproduces the API's own apy from the 24h fee/TVL percentage", () => {
    // Verified live on SOL-USDC: fee_tvl_ratio 24h = 0.0885% -> apy 38.11%.
    expect(annualisedPct(0.08850115394372726)).toBeCloseTo(38.11, 1);
  });

  it("returns zero for non-positive or non-finite input", () => {
    expect(annualisedPct(0)).toBe(0);
    expect(annualisedPct(-1)).toBe(0);
    expect(annualisedPct(Number.NaN)).toBe(0);
  });
});
