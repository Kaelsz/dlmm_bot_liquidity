import { createServer } from "node:http";
import { config } from "../config/config.js";
import { logger } from "../utils/logger.js";
import type { BotDb } from "../db/database.js";
import { computeReport } from "../pnl/report.js";

/**
 * Minimal read-only dashboard (no framework, no build step): a single HTML
 * page polling two JSON endpoints backed by SQLite.
 */
export function startDashboard(db: BotDb, port = config.dashboard.port): void {
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api/state") {
        const open = db.openPositions();
        const opps = db.db
          .prepare(`SELECT * FROM opportunities ORDER BY ts DESC LIMIT 30`)
          .all();
        const closed = db.db
          .prepare(
            `SELECT p.*, n.net_pnl_usd, n.fees_claimed_usd, n.holding_minutes
             FROM positions p LEFT JOIN pnl n ON n.position_id=p.id
             WHERE p.status='CLOSED' ORDER BY p.closed_at DESC LIMIT 30`,
          )
          .all();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ open, opportunities: opps, closed, report: computeReport(db) }));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    } catch (err) {
      logger.error({ err }, "dashboard error");
      res.writeHead(500);
      res.end("error");
    }
  });
  server.listen(port, () => logger.info({ port }, `dashboard on http://localhost:${port}`));
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Meteora Fee Sniper</title>
<style>
body{font-family:ui-monospace,monospace;background:#0d1117;color:#c9d1d9;margin:20px}
h1{font-size:18px} h2{font-size:14px;color:#8b949e;margin-top:24px}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{border-bottom:1px solid #21262d;padding:4px 8px;text-align:right}
th{color:#8b949e} td:first-child,th:first-child{text-align:left}
.pos{color:#3fb950}.neg{color:#f85149}
.kpi{display:inline-block;margin-right:24px;padding:8px 16px;background:#161b22;border-radius:8px}
.kpi b{display:block;font-size:16px}
</style></head><body>
<h1>⚡ Meteora Fee Sniper — read-only dashboard</h1>
<div id="kpis"></div>
<h2>Open positions</h2><table id="open"></table>
<h2>Recent evaluations</h2><table id="opps"></table>
<h2>Closed positions</h2><table id="closed"></table>
<script>
const usd = v => (v==null?'—':(v<0?'-':'')+'$'+Math.abs(v).toFixed(2));
const cls = v => v>=0?'pos':'neg';
async function refresh(){
  const s = await (await fetch('/api/state')).json();
  const r = s.report;
  document.getElementById('kpis').innerHTML =
    '<span class="kpi">net PnL <b class="'+cls(r.totalNetUsd)+'">'+usd(r.totalNetUsd)+'</b></span>'+
    '<span class="kpi">positions <b>'+r.positions+'</b></span>'+
    '<span class="kpi">win rate <b>'+Math.round(r.winRate*100)+'%</b></span>'+
    '<span class="kpi">fees <b>'+usd(r.totalFeesUsd)+'</b></span>'+
    '<span class="kpi">avg hold <b>'+r.avgHoldingMinutes.toFixed(1)+'min</b></span>';
  document.getElementById('open').innerHTML =
    '<tr><th>pool</th><th>mode</th><th>size</th><th>entry</th><th>opened</th></tr>'+
    s.open.map(p=>'<tr><td>'+p.pool_name+'</td><td>'+p.mode+'</td><td>'+usd(p.size_usd)+'</td><td>'+p.entry_price.toPrecision(6)+'</td><td>'+new Date(p.opened_at).toLocaleTimeString()+'</td></tr>').join('');
  document.getElementById('opps').innerHTML =
    '<tr><th>pool</th><th>score</th><th>fee $/min</th><th>heat %/h</th><th>net est.</th><th>decision</th></tr>'+
    s.opportunities.map(o=>'<tr><td>'+o.pool_name+'</td><td>'+o.score.toFixed(0)+'</td><td>'+usd(o.instant_fee_rate_usd_min)+'</td><td>'+o.instant_heat_pct_hr.toFixed(2)+'</td><td class="'+cls(o.expected_net_usd)+'">'+usd(o.expected_net_usd)+'</td><td>'+(o.decision==='ENTER'?'✅':'—')+' '+(o.reject_reason||'')+'</td></tr>').join('');
  document.getElementById('closed').innerHTML =
    '<tr><th>pool</th><th>reason</th><th>hold</th><th>fees</th><th>net PnL</th></tr>'+
    s.closed.map(p=>'<tr><td>'+p.pool_name+'</td><td>'+(p.exit_reason||'')+'</td><td>'+(p.holding_minutes==null?'—':p.holding_minutes.toFixed(1)+'min')+'</td><td>'+usd(p.fees_claimed_usd)+'</td><td class="'+cls(p.net_pnl_usd||0)+'">'+usd(p.net_pnl_usd)+'</td></tr>').join('');
}
refresh(); setInterval(refresh, 10000);
</script></body></html>`;
