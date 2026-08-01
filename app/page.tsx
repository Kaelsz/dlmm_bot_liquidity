import { MarketView } from "@/components/MarketView";
import { getDb } from "@/db";
import { riskyMintsOf, toPoolRows, type PoolsResponse } from "@/lib/api-types";

// The board reflects a collector that writes continuously; caching it would
// only ever serve stale numbers.
export const dynamic = "force-dynamic";

export default function Page() {
  const db = getDb();
  // Rendered server-side so the first paint already carries data, rather than
  // flashing an empty table while the client fetches.
  const rows = db.leaderboard({
    sort: "heat",
    limit: 100,
    minTvl: 5_000,
    excludeBlacklisted: true,
    freshWithinMs: 15 * 60_000,
  });
  const mints = riskyMintsOf(rows);
  const rug = db.rugcheckFor(mints);
  const kol = db.kolFor(mints);
  const kolIndexedAt = db.kolIndexBuiltAt();

  const initial: PoolsResponse = {
    rows: toPoolRows(rows, rug, kol, kolIndexedAt),
    generatedAt: Date.now(),
    counts: db.counts(),
  };

  return <MarketView initial={initial} />;
}
