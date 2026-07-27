import { describe, expect, it } from "vitest";
import { evaluateExit, updateFeeDecayClock, type PositionMonitorState } from "../src/position-manager/exitRules.js";
import { config } from "../src/config/config.js";

const base = (): PositionMonitorState => ({
  openedAtMs: Date.now() - 60_000,
  nowMs: Date.now(),
  entryPrice: 100,
  currentPrice: 100,
  lowerPrice: 95,
  upperPrice: 105,
  sizeUsd: 500,
  entryFeeRateUsdPerMin: 100,
  currentFeeRateUsdPerMin: 100,
  feeDecaySinceMs: null,
  positionValueUsd: 500,
  feesEarnedUsd: 0,
  killSwitch: false,
});

describe("exit rules", () => {
  it("holds when everything is healthy", () => {
    expect(evaluateExit(base()).exit).toBe(false);
  });

  it("kill switch wins over everything", () => {
    const d = evaluateExit({ ...base(), killSwitch: true });
    expect(d.reason).toBe("KILL_SWITCH");
  });

  it("exits immediately when out of range", () => {
    expect(evaluateExit({ ...base(), currentPrice: 94 }).reason).toBe("OUT_OF_RANGE");
    expect(evaluateExit({ ...base(), currentPrice: 106 }).reason).toBe("OUT_OF_RANGE");
  });

  it("stops on IL drawdown (fees included)", () => {
    const s = { ...base(), positionValueUsd: 470, feesEarnedUsd: 0 };
    expect(evaluateExit(s).reason).toBe("STOP_IL");
    // Smaller value loss with some fees (below the take-profit target) => no stop.
    const saved = { ...base(), positionValueUsd: 475, feesEarnedUsd: 20 };
    expect(evaluateExit(saved).exit).toBe(false);
  });

  it("takes profit on fee target", () => {
    const target = 500 * config.position.exits.takeProfitFraction;
    const d = evaluateExit({ ...base(), feesEarnedUsd: target + 1 });
    expect(d.reason).toBe("TAKE_PROFIT");
  });

  it("exits on fee decay only after the grace period", () => {
    const now = Date.now();
    const early = evaluateExit({
      ...base(),
      currentFeeRateUsdPerMin: 10,
      feeDecaySinceMs: now - config.position.exits.feeDecayGraceMs / 2,
    });
    expect(early.exit).toBe(false);
    const late = evaluateExit({
      ...base(),
      currentFeeRateUsdPerMin: 10,
      feeDecaySinceMs: now - config.position.exits.feeDecayGraceMs - 1,
    });
    expect(late.reason).toBe("FEE_DECAY");
  });

  it("has no time-based exit when maxHoldMs is null (TP/SL-driven)", () => {
    expect(config.position.maxHoldMs).toBeNull();
    // A healthy position held for hours stays open.
    const d = evaluateExit({ ...base(), openedAtMs: Date.now() - 5 * 3_600_000 });
    expect(d.exit).toBe(false);
  });
});

describe("fee decay clock", () => {
  it("starts when the rate falls below the threshold and resets above", () => {
    const now = 1_000_000;
    const entry = 100;
    const threshold = entry * config.position.exits.feeDecayFraction;
    expect(updateFeeDecayClock(null, entry, threshold + 1, now)).toBeNull();
    const started = updateFeeDecayClock(null, entry, threshold - 1, now);
    expect(started).toBe(now);
    // Keeps the original start while still below.
    expect(updateFeeDecayClock(started, entry, threshold - 1, now + 5_000)).toBe(now);
    // Resets when the rate recovers.
    expect(updateFeeDecayClock(started, entry, entry, now + 6_000)).toBeNull();
  });
});
