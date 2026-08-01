import { NextResponse } from "next/server";
import { apiFor } from "@/data/client";
import { getDb } from "@/db";
import { riskyMintOf, toPoolRow, type PoolDetailResponse } from "@/lib/api-types";
import { logger } from "@/lib/logger";
import { timeframeForWindow, type OhlcvCandle } from "@/types/meteora";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WINDOWS: Record<string, number> = { "1h": 1, "6h": 6, "24h": 24, "7d": 168, "30d": 720 };

export async function GET(
  req: Request,
  ctx: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  const { address } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const windowHours = WINDOWS[q.get("window") ?? "6h"] ?? 6;

  const db = getDb();
  const row = db.poolByAddress(address);
  if (!row) return NextResponse.json({ error: "pool inconnue" }, { status: 404 });

  const mint = riskyMintOf(row);
  const rug = db.rugcheckFor([mint]).get(mint);
  const pool = toPoolRow(row, rug);

  const windowSeconds = windowHours * 3_600;
  // Never ask for more than the API's silent 100-candle ceiling.
  const timeframe = timeframeForWindow(windowSeconds) ?? null;

  let candles: OhlcvCandle[] = [];
  if (timeframe) {
    const endSec = Math.floor(Date.now() / 1000);
    try {
      candles = await apiFor(pool.protocol).getOhlcv(
        address,
        timeframe,
        endSec - windowSeconds,
        endSec,
      );
    } catch (err) {
      // A chart that fails to load must not take the whole panel with it.
      logger.debug({ address, timeframe, err }, "ohlcv fetch failed");
    }
  }

  return NextResponse.json(
    {
      pool,
      candles,
      timeframe,
      signal: db.signalHistory(address, Date.now() - windowSeconds * 1000),
      windowHours,
      generatedAt: Date.now(),
    } satisfies PoolDetailResponse,
    { headers: { "cache-control": "no-store" } },
  );
}
