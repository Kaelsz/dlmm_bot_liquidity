import { NewPoolsView } from "@/components/NewPoolsView";
import { config } from "@/config";
import { getDb } from "@/db";
import { riskyMintsOf, toPoolRows, type PoolsResponse } from "@/lib/api-types";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Nouvelles pools — Meteora Pool Radar",
};

export default function Page() {
  const db = getDb();
  const rows = db.newPools({
    maxAgeMinutes: 180,
    minTvl: config.display.newPoolMinTvlUsd,
    minVolume30m: config.display.newPoolMinVolume30mUsd,
    limit: 100,
  });
  const mints = riskyMintsOf(rows);
  const rug = db.rugcheckFor(mints);
  const kol = db.kolFor(mints);

  const initial: PoolsResponse = {
    rows: toPoolRows(rows, rug, kol),
    generatedAt: Date.now(),
    counts: db.counts(),
  };

  return <NewPoolsView initial={initial} />;
}
