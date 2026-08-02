import { describe, expect, it } from "vitest";
import { MIN_SIGNAL_COVERAGE, signalCoverage } from "../src/data/metrics";
import { fmtAxisTime } from "../src/lib/format";

const HOUR = 3_600_000;

describe("signalCoverage", () => {
  it("reports nothing derivable below two points", () => {
    expect(signalCoverage([], 6 * HOUR)).toEqual({ spanMs: 0, ratio: 0 });
    expect(signalCoverage([{ ts: 1_000 }], 6 * HOUR)).toEqual({ spanMs: 0, ratio: 0 });
  });

  it("measures the span between first and last sample", () => {
    const c = signalCoverage([{ ts: 0 }, { ts: 60_000 }, { ts: 15 * 60_000 }], HOUR);
    expect(c.spanMs).toBe(15 * 60_000);
    expect(c.ratio).toBeCloseTo(0.25);
  });

  it("falls under the plot threshold for a short span on a long window", () => {
    // The case from the screenshots: 15 minutes of samples against 7 days.
    const c = signalCoverage([{ ts: 0 }, { ts: 15 * 60_000 }], 168 * HOUR);
    expect(c.ratio).toBeLessThan(MIN_SIGNAL_COVERAGE);
  });

  it("clears the threshold once the window matches the data", () => {
    const c = signalCoverage([{ ts: 0 }, { ts: 15 * 60_000 }], HOUR);
    expect(c.ratio).toBeGreaterThanOrEqual(MIN_SIGNAL_COVERAGE);
  });

  it("guards against a non-positive window", () => {
    expect(signalCoverage([{ ts: 0 }, { ts: 1_000 }], 0)).toEqual({ spanMs: 0, ratio: 0 });
  });
});

describe("fmtAxisTime", () => {
  const ts = Date.UTC(2026, 7, 2, 14, 30);

  it("shows the time of day within a day", () => {
    expect(fmtAxisTime(ts, 6 * HOUR)).toMatch(/^\d{2}:\d{2}$/);
    expect(fmtAxisTime(ts, 24 * HOUR)).toMatch(/^\d{2}:\d{2}$/);
  });

  it("switches to a date past a day, where the hour alone names no day", () => {
    expect(fmtAxisTime(ts, 168 * HOUR)).toMatch(/^\d{2}\/\d{2}$/);
  });
});
