import { describe, expect, it } from "vitest";
import { computeStability, expectedMoveFraction } from "../src/scoring/volatility.js";
import type { OhlcvCandle } from "../src/types/datapi.js";

const candle = (t: number, o: number, h: number, l: number, c: number, v = 10_000): OhlcvCandle => ({
  timestamp: t,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
});

describe("computeStability", () => {
  it("returns zeros without enough candles", () => {
    expect(computeStability([]).stabilityScore).toBe(0);
    expect(computeStability([candle(0, 1, 1, 1, 1)]).candleCount).toBe(1);
  });

  it("flags an oscillating range as stable", () => {
    // price ping-pongs between 99 and 101, net drift ~0
    const candles = Array.from({ length: 12 }, (_, i) =>
      candle(i * 300, i % 2 === 0 ? 99 : 101, 101.5, 98.5, i % 2 === 0 ? 101 : 99),
    );
    const m = computeStability(candles);
    expect(m.netDriftPct).toBeLessThan(3);
    expect(m.pathPct).toBeGreaterThan(10);
    expect(m.stabilityScore).toBeGreaterThan(0.5);
  });

  it("flags a one-way trend as unstable", () => {
    const candles = Array.from({ length: 12 }, (_, i) => {
      const p = 100 * 1.02 ** i;
      return candle(i * 300, p, p * 1.021, p * 0.999, p * 1.02);
    });
    const m = computeStability(candles);
    expect(m.netDriftPct).toBeGreaterThan(15);
    expect(m.stabilityScore).toBeLessThan(0.3);
  });

  it("expected move scales with sqrt of horizon", () => {
    const m = computeStability(
      Array.from({ length: 12 }, (_, i) =>
        candle(i * 300, 100, 101, 99, i % 2 === 0 ? 100.5 : 99.5),
      ),
    );
    const m10 = expectedMoveFraction(m, 10);
    const m40 = expectedMoveFraction(m, 40);
    expect(m40 / m10).toBeCloseTo(2, 6);
  });
});
