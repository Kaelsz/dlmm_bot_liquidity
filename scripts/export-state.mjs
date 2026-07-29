// Dumps the small, precious tables (positions, pnl, events, opportunities)
// to data/state-export.json so it can be committed and pushed off-container.
// The bulky pool_snapshots time series is intentionally excluded.
import Database from "better-sqlite3";

const db = new Database(process.env.DB_PATH ?? "data/bot.db", { readonly: true });
const sinceMs = Date.now() - 48 * 3_600_000;

const state = {
  exportedAt: new Date().toISOString(),
  positions: db.prepare("SELECT * FROM positions ORDER BY id").all(),
  pnl: db.prepare("SELECT * FROM pnl ORDER BY position_id").all(),
  position_events: db.prepare("SELECT * FROM position_events ORDER BY id").all(),
  opportunities: db.prepare("SELECT * FROM opportunities WHERE ts >= ? ORDER BY id").all(sinceMs),
};

const { writeFileSync } = await import("node:fs");
writeFileSync("data/state-export.json", JSON.stringify(state));
console.log(
  `exported ${state.positions.length} positions, ${state.pnl.length} pnl rows, ` +
    `${state.position_events.length} events, ${state.opportunities.length} opportunities (48h)`,
);
