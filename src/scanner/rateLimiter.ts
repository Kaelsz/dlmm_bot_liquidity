/**
 * Simple token-bucket rate limiter. `acquire()` resolves when a token is
 * available, guaranteeing we never exceed `maxPerSec` requests per second.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private readonly queue: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly maxPerSec: number) {
    this.tokens = maxPerSec;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.schedule();
    });
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.maxPerSec, this.tokens + elapsed * this.maxPerSec);
      this.lastRefill = now;
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.refill();
      while (this.tokens >= 1 && this.queue.length > 0) {
        this.tokens -= 1;
        const next = this.queue.shift();
        next?.();
      }
      if (this.queue.length === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, 50);
    // Don't keep the process alive just for the limiter.
    this.timer.unref();
  }
}
