"use client";

import type { SafetyVerdict } from "@/data/rugcheck";
import type { PoolRow } from "@/lib/api-types";

/**
 * RugCheck verdict as a compact gauge.
 *
 * Two things this deliberately does NOT do:
 *  - it never renders "unknown" as green. A missing report means nobody has
 *    looked, which on a two-minute-old token is the common case and is not
 *    reassuring.
 *  - it does not invert the score for display. RugCheck's scale is
 *    higher = riskier and the tooltip says so, because silently flipping it
 *    would make the raw number on rugcheck.xyz look like a contradiction.
 */
const VERDICT_STYLE: Record<SafetyVerdict, { cls: string; label: string }> = {
  safe: { cls: "bg-[#0e3d3a] text-up", label: "aucun risque majeur détecté" },
  caution: { cls: "bg-[#3d3410] text-warn", label: "risques mineurs" },
  danger: { cls: "bg-[#4a1420] text-down", label: "RISQUE ÉLEVÉ" },
  unknown: { cls: "bg-line text-fg-faint", label: "non analysé par RugCheck" },
};

const VERDICT_GLYPH: Record<SafetyVerdict, string> = {
  safe: "✓",
  caution: "!",
  danger: "✕",
  unknown: "?",
};

export function SafetyBadge({ row }: { row: PoolRow }) {
  const v = row.safety;
  const style = VERDICT_STYLE[v];
  const parts = [
    `RugCheck : ${style.label}`,
    row.rugcheckScore !== null ? `score ${row.rugcheckScore}/100 (plus haut = plus risqué)` : null,
    row.lpLockedPct !== null ? `LP verrouillée ${row.lpLockedPct.toFixed(1)} %` : "LP verrouillée inconnue",
    ...row.rugcheckRisks.slice(0, 4).map((r) => `• ${r.level} — ${r.name}`),
  ].filter(Boolean);

  return (
    <span
      title={parts.join("\n")}
      className={`tnum inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-[2px] px-1 text-[9px] font-bold leading-none ${style.cls}`}
    >
      {VERDICT_GLYPH[v]}
    </span>
  );
}

/**
 * Share of liquidity locked, the strongest single signal on a launch: an
 * unlocked LP can be pulled at any moment. Rendered as a small filled bar so a
 * column of them can be compared without reading the numbers.
 */
export function LpLockedBar({ pct }: { pct: number | null }) {
  if (pct === null) {
    return (
      <span title="LP verrouillée inconnue" className="text-[10px] text-fg-faint">
        —
      </span>
    );
  }
  const clamped = Math.max(0, Math.min(100, pct));
  const colour = clamped >= 80 ? "bg-up" : clamped >= 40 ? "bg-warn" : "bg-down";
  return (
    <div className="flex items-center gap-1" title={`LP verrouillée : ${pct.toFixed(1)} %`}>
      <div className="h-[6px] w-[28px] overflow-hidden rounded-[1px] bg-line">
        <div className={`h-full ${colour}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className="tnum text-[10px] text-fg-dim">{Math.round(clamped)}</span>
    </div>
  );
}
