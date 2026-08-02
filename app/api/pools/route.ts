import { NextResponse } from "next/server";
import { getDb, type LeaderboardFilters } from "@/db";
import { riskyMintsOf, toPoolRows, type PoolsResponse } from "@/lib/api-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const numParam = (v: string | null): number | undefined => {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export async function GET(req: Request): Promise<NextResponse<PoolsResponse>> {
  const url = new URL(req.url);
  const q = url.searchParams;

  const sortParam = q.get("sort");
  const sort = (["heat", "rate", "volumeRate", "tvl", "volume", "age", "accel"] as const).find(
    (s) => s === sortParam,
  );

  const protocolParam = q.get("protocol");
  const protocol = protocolParam === "dlmm" || protocolParam === "damm_v2" ? protocolParam : undefined;

  const filters: LeaderboardFilters = {
    minTvl: numParam(q.get("minTvl")),
    maxTvl: numParam(q.get("maxTvl")),
    minHeat: numParam(q.get("minHeat")),
    maxAgeMinutes: numParam(q.get("maxAgeMinutes")),
    protocol,
    excludeBlacklisted: q.get("excludeBlacklisted") !== "false",
    // A pool whose metrics have not been refreshed in a while is stale data,
    // not a live signal — keep it out of the board by default.
    freshWithinMs: numParam(q.get("freshWithinMs")) ?? 15 * 60_000,
    sort,
    limit: numParam(q.get("limit")),
  };

  const db = getDb();
  const rows = db.leaderboard(filters);
  const mints = riskyMintsOf(rows);
  const rug = db.rugcheckFor(mints);

  return NextResponse.json(
    { rows: toPoolRows(rows, rug), generatedAt: Date.now(), counts: db.counts() },
    { headers: { "cache-control": "no-store" } },
  );
}
