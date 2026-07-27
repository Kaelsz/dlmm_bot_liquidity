import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/scanner/rateLimiter.js";

describe("RateLimiter", () => {
  it("lets a burst through up to the per-second budget", async () => {
    const limiter = new RateLimiter(10);
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) await limiter.acquire();
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("throttles beyond the budget", async () => {
    const limiter = new RateLimiter(10);
    const t0 = Date.now();
    for (let i = 0; i < 15; i++) await limiter.acquire();
    // 5 extra tokens at 10/s ≈ 500ms minimum
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
  });
});
