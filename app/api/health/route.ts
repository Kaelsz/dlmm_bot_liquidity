import { NextResponse } from "next/server";
import { getCollector } from "@/collector/collector";
import { config } from "@/config";
import { getDb } from "@/db";
import { kolListInfo, requestsPerPass } from "@/data/kol";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Operational view: collector liveness, request budget and DB size. The API
 * counters are what confirm we are staying under Meteora's rate limits.
 */
export async function GET(): Promise<NextResponse> {
  const status = config.collector.enabled ? getCollector().status() : null;
  const counts = getDb().counts();
  const uptimeSec = status?.startedAt ? Math.round((Date.now() - status.startedAt) / 1000) : 0;

  const perSec = (n: number): number =>
    uptimeSec > 0 ? Math.round((n / uptimeSec) * 100) / 100 : 0;

  return NextResponse.json(
    {
      ok: true,
      collectorEnabled: config.collector.enabled,
      uptimeSec,
      db: counts,
      kol: {
        listSize: kolListInfo.count,
        listFetchedAt: kolListInfo.fetchedAt,
        indexBuiltAt: getDb().kolIndexBuiltAt(),
        // The dominant Helius cost; see the arithmetic in config.kol.
        requestsPerPass: requestsPerPass(),
        projectedRequestsPerDay: Math.round(
          requestsPerPass() * ((24 * 3_600_000) / config.kol.refreshIntervalMs),
        ),
        refreshIntervalMin: Math.round(config.kol.refreshIntervalMs / 60_000),
      },
      collector: status,
      rates: status
        ? {
            dlmmReqPerSec: perSec(status.api.dlmm.requests),
            dammV2ReqPerSec: perSec(status.api.damm_v2.requests),
            limits: {
              dlmm: config.datapi.dlmmMaxReqPerSec,
              damm_v2: config.datapi.dammV2MaxReqPerSec,
            },
          }
        : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
