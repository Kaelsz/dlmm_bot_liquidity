import type { BotDb } from "../db/database.js";
import { fmtUsd } from "../utils/time.js";

/** Aggregated performance report computed from SQLite. */

export interface PerformanceReport {
  positions: number;
  wins: number;
  losses: number;
  winRate: number;
  totalFeesUsd: number;
  totalIlUsd: number;
  totalCostsUsd: number;
  totalNetUsd: number;
  avgHoldingMinutes: number;
  byExitReason: Record<string, { count: number; netUsd: number }>;
}

export function computeReport(db: BotDb, sinceMs = 0): PerformanceReport {
  const rows = db.db
    .prepare(
      `SELECT p.exit_reason, n.fees_claimed_usd, n.il_usd, n.tx_costs_usd, n.net_pnl_usd, n.holding_minutes
       FROM positions p JOIN pnl n ON n.position_id = p.id
       WHERE p.status='CLOSED' AND p.closed_at >= ?`,
    )
    .all(sinceMs) as Array<{
    exit_reason: string | null;
    fees_claimed_usd: number;
    il_usd: number;
    tx_costs_usd: number;
    net_pnl_usd: number;
    holding_minutes: number;
  }>;

  const report: PerformanceReport = {
    positions: rows.length,
    wins: 0,
    losses: 0,
    winRate: 0,
    totalFeesUsd: 0,
    totalIlUsd: 0,
    totalCostsUsd: 0,
    totalNetUsd: 0,
    avgHoldingMinutes: 0,
    byExitReason: {},
  };
  for (const r of rows) {
    if (r.net_pnl_usd >= 0) report.wins += 1;
    else report.losses += 1;
    report.totalFeesUsd += r.fees_claimed_usd;
    report.totalIlUsd += r.il_usd;
    report.totalCostsUsd += r.tx_costs_usd;
    report.totalNetUsd += r.net_pnl_usd;
    report.avgHoldingMinutes += r.holding_minutes;
    const reason = r.exit_reason ?? "UNKNOWN";
    const bucket = (report.byExitReason[reason] ??= { count: 0, netUsd: 0 });
    bucket.count += 1;
    bucket.netUsd += r.net_pnl_usd;
  }
  if (rows.length > 0) {
    report.winRate = report.wins / rows.length;
    report.avgHoldingMinutes /= rows.length;
  }
  return report;
}

export function formatReport(r: PerformanceReport, title: string): string {
  const lines = [
    `── ${title} ──`,
    `positions: ${r.positions}  (W ${r.wins} / L ${r.losses}, win rate ${(r.winRate * 100).toFixed(0)}%)`,
    `fees claimed : ${fmtUsd(r.totalFeesUsd)}`,
    `value loss/IL: ${fmtUsd(-r.totalIlUsd)}`,
    `tx costs     : ${fmtUsd(-r.totalCostsUsd)}`,
    `NET PnL      : ${fmtUsd(r.totalNetUsd)}`,
    `avg holding  : ${r.avgHoldingMinutes.toFixed(1)} min`,
  ];
  for (const [reason, b] of Object.entries(r.byExitReason)) {
    lines.push(`  ${reason.padEnd(12)} x${b.count}  net ${fmtUsd(b.netUsd)}`);
  }
  return lines.join("\n");
}
