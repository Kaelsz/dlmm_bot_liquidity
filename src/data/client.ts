import { config, type Protocol } from "@/config";
import { logger } from "@/lib/logger";
import { RateLimiter } from "@/lib/rateLimiter";
import {
  ApiPoolSchema,
  OhlcvResponseSchema,
  PoolListResponseSchema,
  toPoolView,
  type OhlcvCandle,
  type OhlcvTimeframe,
  type PoolView,
  type SortSpec,
} from "@/types/meteora";

/**
 * Client for the Meteora data APIs. Behaviour verified live 2026-08-01:
 *
 *   GET /pools?page=&page_size=&sort_by=<field>:<asc|desc>
 *   GET /pools/{address}
 *   GET /pools/{address}/ohlcv?timeframe=&start_time=&end_time=   (epoch SECONDS)
 *
 * `sort_by` must carry an explicit direction — `sort_by=tvl` alone returns 400
 * ("sort_by must be of form `<field>:<asc|desc>`"). An invalid field returns
 * 400 with the full list of valid ones, which is where SORT_FIELDS came from.
 */

export class NonRetryableError extends Error {}

interface ClientStats {
  requests: number;
  errors: number;
  rateLimited: number;
}

export class DataApiClient {
  private readonly baseUrl: string;
  private readonly limiter: RateLimiter;
  readonly stats: ClientStats = { requests: 0, errors: 0, rateLimited: 0 };

  constructor(readonly protocol: Protocol) {
    this.baseUrl =
      protocol === "dlmm" ? config.datapi.dlmmBaseUrl : config.datapi.dammV2BaseUrl;
    this.limiter = new RateLimiter(
      protocol === "dlmm" ? config.datapi.dlmmMaxReqPerSec : config.datapi.dammV2MaxReqPerSec,
    );
  }

  private async request(path: string): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      await this.limiter.acquire();
      try {
        this.stats.requests += 1;
        const res = await fetch(`${this.baseUrl}${path}`, {
          signal: AbortSignal.timeout(config.datapi.requestTimeoutMs),
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (res.status === 429) {
          this.stats.rateLimited += 1;
          throw new Error("HTTP 429");
        }
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new NonRetryableError(`HTTP ${res.status} on ${path}: ${body.slice(0, 200)}`);
        }
        return await res.json();
      } catch (err) {
        if (err instanceof NonRetryableError) {
          this.stats.errors += 1;
          throw err;
        }
        attempt += 1;
        if (attempt > config.datapi.maxRetries) {
          this.stats.errors += 1;
          throw err;
        }
        const delay = Math.min(
          config.datapi.backoffMaxMs,
          config.datapi.backoffBaseMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.3),
        );
        logger.debug({ protocol: this.protocol, path, attempt, err }, "datapi retry");
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  async listPools(params: {
    page?: number;
    pageSize?: number;
    sortBy: SortSpec;
  }): Promise<PoolView[]> {
    const q = new URLSearchParams();
    if (params.page) q.set("page", String(params.page));
    q.set("page_size", String(params.pageSize ?? 100));
    q.set("sort_by", params.sortBy);
    const raw = await this.request(`/pools?${q.toString()}`);
    const envelope = PoolListResponseSchema.parse(raw);
    const out: PoolView[] = [];
    for (const item of envelope.data) {
      const parsed = ApiPoolSchema.safeParse(item);
      if (parsed.success) out.push(toPoolView(parsed.data, this.protocol));
      else logger.debug({ protocol: this.protocol, issues: parsed.error.issues }, "pool parse skipped");
    }
    return out;
  }

  async getPool(address: string): Promise<PoolView | undefined> {
    try {
      const raw = await this.request(`/pools/${address}`);
      const parsed = ApiPoolSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ address, issues: parsed.error.issues }, "pool parse failed");
        return undefined;
      }
      return toPoolView(parsed.data, this.protocol);
    } catch (err) {
      logger.debug({ address, err }, "getPool failed");
      return undefined;
    }
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

export const dlmmApi = new DataApiClient("dlmm");
export const dammV2Api = new DataApiClient("damm_v2");
export const ALL_APIS = [dlmmApi, dammV2Api] as const;

export function apiFor(protocol: Protocol): DataApiClient {
  return protocol === "dlmm" ? dlmmApi : dammV2Api;
}
