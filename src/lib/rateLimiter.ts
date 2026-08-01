/**
 * Token-bucket rate limiter with a FIFO waiter queue.
 *
 * One instance per upstream API, since Meteora's two data APIs have very
 * different budgets (~30/s DLMM vs ~10/s DAMM v2).
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private readonly waiters: Array<() => void> = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly maxPerSec: number) {
    this.tokens = maxPerSec;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.maxPerSec, this.tokens + elapsedSec * this.maxPerSec);
    this.lastRefill = now;
  }

  private drain(): void {
    this.refill();
    while (this.waiters.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.waiters.shift()?.();
    }
    if (this.waiters.length === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.waiters.length === 0 && this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      if (!this.timer) {
        this.timer = setInterval(() => this.drain(), 50);
        // Never keep the process alive just for the limiter.
        this.timer.unref?.();
      }
    });
  }
}
