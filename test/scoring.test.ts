import { describe, expect, it } from "vitest";
import { chooseRange, evaluateOpportunity } from "../src/scoring/scoring.js";
import { config } from "../src/config/config.js";
import type { StabilityMetrics } from "../src/scoring/volatility.js";
import { heatSample } from "./helpers.js";

const stableMetrics = (overrides: Partial<StabilityMetrics> = {}): StabilityMetrics => ({
  netDriftPct: 1,
  pathPct: 12,
  realizedVolPerMinPct: 0.15,
  totalVolume: 500_000,
  volumePerPctDrift: 500_000,
  stabilityScore: 0.9,
  candleCount: 12,
  ...overrides,
});

describe("chooseRange", () => {
  it("clamps to configured bin bounds", () => {
    const calm = chooseRange(heatSample(), stableMetrics({ realizedVolPerMinPct: 0.001 }));
    expect(calm.binRange).toBe(config.position.binRangeMin);
    const wild = chooseRange(heatSample(), stableMetrics({ realizedVolPerMinPct: 5 }));
    expect(wild.binRange).toBe(config.position.binRangeMax);
  });

  it("half width follows binRange * binStep", () => {
    const { rangeHalfWidth, binRange } = chooseRange(heatSample(), stableMetrics());
    expect(rangeHalfWidth).toBeCloseTo((binRange * 20) / 10_000, 9);
  });
});

describe("evaluateOpportunity", () => {
  const capital = 1_000;

  it("accepts a violent, stable printer", () => {
    const ev = evaluateOpportunity(heatSample(), stableMetrics(), capital, 0);
    expect(ev.rejectReason).toBeNull();
    expect(ev.enter).toBe(true);
    expect(ev.expectedNetUsd).toBeGreaterThan(0);
    expect(ev.breakevenMinutes).toBeLessThanOrEqual(config.scoring.maxBreakevenMinutes);
  });

  it("rejects insufficient heat", () => {
    const ev = evaluateOpportunity(
      heatSample({ instantHeatPctPerHour: config.scoring.minInstantHeatPctPerHour / 2 }),
      stableMetrics(),
      capital,
      0,
    );
    expect(ev.enter).toBe(false);
    expect(ev.rejectReason).toContain("heat");
  });

  it("rejects decelerating fees", () => {
    const ev = evaluateOpportunity(heatSample({ feeAcceleration: -50 }), stableMetrics(), capital, 0);
    expect(ev.enter).toBe(false);
    expect(ev.rejectReason).toContain("decelerating");
  });

  it("rejects violent trends (IL machine)", () => {
    const ev = evaluateOpportunity(
      heatSample(),
      stableMetrics({ netDriftPct: 20, volumePerPctDrift: 1_000 }),
      capital,
      0,
    );
    expect(ev.enter).toBe(false);
  });

  it("rejects when too few fast samples exist", () => {
    const ev = evaluateOpportunity(heatSample({ sampleCount: 2 }), stableMetrics(), capital, 0);
    expect(ev.enter).toBe(false);
    expect(ev.rejectReason).toContain("samples");
  });

  it("models self-dilution: bigger pools give smaller share but real fees", () => {
    const ev = evaluateOpportunity(heatSample(), stableMetrics(), capital, 0);
    const inRange = ev.sample.pool.tvl * config.scoring.inRangeTvlFraction;
    const share = ev.positionSizeUsd / (inRange + ev.positionSizeUsd);
    expect(ev.expectedFeesUsd).toBeCloseTo(
      ev.sample.instantFeeRateUsdPerMin * config.position.projectionHorizonMinutes * share,
      6,
    );
  });

  it("respects available capital for sizing", () => {
    const ev = evaluateOpportunity(heatSample(), stableMetrics(), capital, capital - 50);
    expect(ev.positionSizeUsd).toBeLessThanOrEqual(50);
    expect(ev.enter).toBe(false); // below min position size
  });
});
