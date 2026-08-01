import { describe, expect, it } from "vitest";
import {
  MAX_OHLCV_CANDLES,
  TIMEFRAME_SECONDS,
  timeframeForWindow,
  type OhlcvTimeframe,
} from "../src/types/meteora";

const H = 3_600;

/**
 * The 100-candle ceiling is silent: asking for 101 returns an empty array, not
 * an error. Every one of these cases guards against a window that would come
 * back blank and read on screen as "this pool never traded".
 */
describe("timeframeForWindow", () => {
  it("picks the finest timeframe that fits under the cap", () => {
    // 1h at 5m candles = 12, well inside the cap.
    expect(timeframeForWindow(1 * H)).toBe("5m");
    // 6h at 5m = 72 candles, still fits.
    expect(timeframeForWindow(6 * H)).toBe("5m");
    // 24h at 5m would be 288 — must step down to 30m (48 candles).
    expect(timeframeForWindow(24 * H)).toBe("30m");
    // 7d at 30m = 336, at 2h = 84.
    expect(timeframeForWindow(168 * H)).toBe("2h");
    // 30d at 12h = 60.
    expect(timeframeForWindow(720 * H)).toBe("12h");
  });

  it("never returns a timeframe that would exceed the cap", () => {
    for (const hours of [1, 2, 6, 12, 24, 48, 168, 336, 720, 1_440, 2_400]) {
      const tf = timeframeForWindow(hours * H);
      if (!tf) continue;
      expect((hours * H) / TIMEFRAME_SECONDS[tf]).toBeLessThanOrEqual(MAX_OHLCV_CANDLES);
    }
  });

  it("returns exactly the boundary timeframe at 100 candles", () => {
    // 500 minutes = 100 x 5m candles: right on the limit, still allowed.
    expect(timeframeForWindow(100 * TIMEFRAME_SECONDS["5m"])).toBe("5m");
    // One candle more and it has to coarsen.
    expect(timeframeForWindow(101 * TIMEFRAME_SECONDS["5m"])).toBe("30m");
  });

  it("gives up rather than silently truncating beyond 100 days", () => {
    expect(timeframeForWindow(101 * 24 * H)).toBeUndefined();
    expect(timeframeForWindow(100 * 24 * H)).toBe("24h");
  });

  it("covers every declared timeframe with a duration", () => {
    const declared: OhlcvTimeframe[] = ["5m", "30m", "1h", "2h", "4h", "12h", "24h"];
    for (const tf of declared) expect(TIMEFRAME_SECONDS[tf]).toBeGreaterThan(0);
  });
});
