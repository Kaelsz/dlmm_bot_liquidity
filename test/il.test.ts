import { describe, expect, it } from "vitest";
import { expectedIlUsd, rangeIlUsd, rangePositionValueUsd } from "../src/pnl/il.js";

const model = { entryPrice: 100, lowerPrice: 95, upperPrice: 105, sizeUsd: 1_000 };

describe("range position value", () => {
  it("is worth the deposit at entry price", () => {
    expect(rangePositionValueUsd(model, 100)).toBeCloseTo(1_000, 6);
  });

  it("decreases vs hold when price moves either way (divergence loss)", () => {
    expect(rangeIlUsd(model, 103)).toBeGreaterThan(0);
    expect(rangeIlUsd(model, 97)).toBeGreaterThan(0);
    expect(rangeIlUsd(model, 100)).toBeCloseTo(0, 9);
  });

  it("becomes one-sided outside the range", () => {
    // Below the range the position is fully in token X, so its value falls
    // linearly with price.
    const at90 = rangePositionValueUsd(model, 90);
    const at80 = rangePositionValueUsd(model, 80);
    expect(at90).toBeLessThan(1_000);
    expect(at80 / at90).toBeCloseTo(80 / 90, 2);
    // Above the range the position is fully in quote: value is flat.
    expect(rangePositionValueUsd(model, 110)).toBeCloseTo(rangePositionValueUsd(model, 120), 9);
  });

  it("IL grows with the move and shrinks with wider ranges", () => {
    expect(rangeIlUsd(model, 104)).toBeGreaterThan(rangeIlUsd(model, 102));
    const wide = { ...model, lowerPrice: 80, upperPrice: 125 };
    expect(rangeIlUsd(wide, 104)).toBeLessThan(rangeIlUsd(model, 104));
  });
});

describe("expectedIlUsd", () => {
  it("is zero for zero expected move", () => {
    expect(expectedIlUsd(1_000, 0.05, 0)).toBeCloseTo(0, 9);
  });
  it("increases with expected move", () => {
    const small = expectedIlUsd(1_000, 0.05, 0.01);
    const big = expectedIlUsd(1_000, 0.05, 0.04);
    expect(big).toBeGreaterThan(small);
    expect(small).toBeGreaterThanOrEqual(0);
  });
});
