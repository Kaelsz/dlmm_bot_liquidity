import { config } from "../config/config.js";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/time.js";
import {
  ApiPoolSchema,
  OhlcvResponseSchema,
  PoolListResponseSchema,
  toPoolView,
  type OhlcvCandle,
  type OhlcvTimeframe,
  type PoolView,
  type Protocol,
} from "../types/datapi.js";
import { RateLimiter } from "./rateLimiter.js";

/**
 * Rate-limited client for the two Meteora data APIs.
 *
 * Verified live behaviour (2026-07):
 *  - list:   GET /pools?page=N&page_size=M&sort_by=<field>:<asc|desc>
 *            (e.g. sort_by=fee_tvl_ratio_30m:desc, volume_30m:desc)
 *  - single: GET /pools/{address}
 *  - ohlcv:  GET /pools/{address}/ohlcv?timeframe=5m&start_time=&end_time=
 *            accepted timeframes: 5m|30m|1h|2h|4h|12h|24h (no 1m)
 */
export class DataApiClient {
  private readonly limiter: RateLimiter;
  private readonly baseUrl: string;

  constructor(readonly protocol: Protocol) {
    this.baseUrl = protocol === "dlmm" ? config.datapi.dlmmBaseUrl : config.datapi.dammV2BaseUrl;
    this.limiter = new RateLimiter(
      protocol === "dlmm" ? config.datapi.dlmmMaxReqPerSec : config.datapi.dammV2MaxReqPerSec,
    );
  }

  private async request(path: string): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      await this.limiter.acquire();
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          signal: AbortSignal.timeout(config.datapi.requestTimeoutMs),
          headers: { accept: "application/json" },
        });
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`HTTP ${res.status}`);
        }
        if (!res.ok) {
          const body = await res.text();
          throw new NonRetryableError(`HTTP ${res.status} on ${path}: ${body.slice(0, 200)}`);
        }
        return (await res.json()) as unknown;
      } catch (err) {
        if (err instanceof NonRetryableError) throw err;
        attempt += 1;
        if (attempt > 5) throw err;
        const delay = Math.min(
          config.datapi.backoffMaxMs,
          config.datapi.backoffBaseMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.3),
        );
        logger.warn({ protocol: this.protocol, path, attempt, delay: Math.round(delay) }, "datapi retry");
        await sleep(delay);
      }
    }
  }

  /** Fetch one sorted page of pools. Invalid entries are skipped, not fatal. */
  async listPools(params: { page?: number; pageSize?: number; sortBy?: string }): Promise<PoolView[]> {
    const q = new URLSearchParams();
    if (params.page) q.set("page", String(params.page));
    q.set("page_size", String(params.pageSize ?? 100));
    if (params.sortBy) q.set("sort_by", params.sortBy);
    const raw = await this.request(`/pools?${q.toString()}`);
    const envelope = PoolListResponseSchema.parse(raw);
    const out: PoolView[] = [];
    for (const item of envelope.data) {
      const parsed = ApiPoolSchema.safeParse(item);
      if (parsed.success) out.push(toPoolView(parsed.data, this.protocol));
    }
    return out;
  }

  async getPool(address: string): Promise<PoolView | undefined> {
    const raw = await this.request(`/pools/${address}`);
    const parsed = ApiPoolSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ address, issues: parsed.error.issues.slice(0, 3) }, "pool parse failed");
      return undefined;
    }
    return toPoolView(parsed.data, this.protocol);
  }

  async getOhlcv(
    address: string,
    timeframe: OhlcvTimeframe,
    startTimeSec: number,
    endTimeSec: number,
  ): Promise<OhlcvCandle[]> {
    const q = new URLSearchParams({
      timeframe,
      start_time: String(Math.floor(startTimeSec)),
      end_time: String(Math.floor(endTimeSec)),
    });
    const raw = await this.request(`/pools/${address}/ohlcv?${q.toString()}`);
    return OhlcvResponseSchema.parse(raw).data;
  }
}

export class NonRetryableError extends Error {}

export const dlmmApi = new DataApiClient("dlmm");
export const dammV2Api = new DataApiClient("damm_v2");

export function apiFor(protocol: Protocol): DataApiClient {
  return protocol === "dlmm" ? dlmmApi : dammV2Api;
}
