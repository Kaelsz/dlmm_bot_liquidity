import { NextResponse } from "next/server";
import { config } from "@/config";
import { getDb } from "@/db";
import { toPoolRows, type PoolsResponse } from "@/lib/api-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const numParam = (v: string | null, fallback: number): number => {
  if (v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export async function GET(req: Request): Promise<NextResponse<PoolsResponse>> {
  const q = new URL(req.url).searchParams;
  const protocolParam = q.get("protocol");

  const db = getDb();
  const rows = db.newPools({
    maxAgeMinutes: numParam(q.get("maxAgeMinutes"), 180),
    minTvl: numParam(q.get("minTvl"), config.display.newPoolMinTvlUsd),
    minVolume30m: numParam(q.get("minVolume30m"), config.display.newPoolMinVolume30mUsd),
    limit: numParam(q.get("limit"), 100),
    ...(protocolParam === "dlmm" || protocolParam === "damm_v2" ? { protocol: protocolParam } : {}),
  });

  const rug = db.rugcheckFor([...new Set(rows.map((r) => r.tokenXMint))]);

  return NextResponse.json(
    { rows: toPoolRows(rows, rug), generatedAt: Date.now(), counts: db.counts() },
    { headers: { "cache-control": "no-store" } },
  );
}
