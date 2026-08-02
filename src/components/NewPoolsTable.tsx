"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { HeatCell } from "@/components/HeatCell";
import { Num } from "@/components/Num";
import { LpLockedBar, SafetyBadge } from "@/components/SafetyBadge";
import { Sparkline } from "@/components/Sparkline";
import { TokenLinks } from "@/components/TokenLinks";
import { fmtAge, fmtInt, fmtRate, fmtUsd, splitPairName } from "@/lib/format";
import type { PoolRow } from "@/lib/api-types";

/**
 * The launch view. It answers one question: this pool is four minutes old,
 * do I go in?
 *
 * That splits cleanly in two, and the columns are grouped to match rather than
 * being ordered by importance:
 *   - IS IT PRINTING — age, fee rate, heat, TVL, volume, sample count
 *   - IS IT SAFE     — RugCheck verdict, LP locked, holders, freeze authority
 *
 * `n` (sample count) is exposed because on a pool this young the derived rate
 * may rest on two or three readings, and a number built from two points
 * deserves less trust than the same number built from thirty.
 */
export function NewPoolsTable({
  rows,
  selected,
  onSelect,
}: {
  rows: PoolRow[];
  selected: string | null;
  onSelect: (address: string) => void;
}) {
  const known = useRef<Set<string>>(new Set());
  const [entering, setEntering] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fresh = new Set<string>();
    for (const r of rows) if (!known.current.has(r.address)) fresh.add(r.address);
    if (known.current.size > 0 && fresh.size > 0) {
      setEntering(fresh);
      const t = setTimeout(() => setEntering(new Set()), 1300);
      for (const r of rows) known.current.add(r.address);
      return () => clearTimeout(t);
    }
    for (const r of rows) known.current.add(r.address);
  }, [rows]);

  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const body = useMemo(
    () =>
      rows.map((r) => {
        const { base, quote } = splitPairName(r.name);
        const ageMin = ((now ?? r.ts) - r.createdAt) / 60_000;
        return (
          <tr
            key={r.address}
            onClick={() => onSelect(r.address)}
            className={`h-row cursor-pointer border-b border-line hover:bg-hover ${
              entering.has(r.address) ? "row-enter" : ""
            } ${selected === r.address ? "row-selected" : ""}`}
          >
            <td className="px-2">
              <span
                className={`tnum block text-right font-semibold ${
                  ageMin < 10 ? "text-accent" : ageMin < 60 ? "text-fg" : "text-fg-dim"
                }`}
                title={r.createdAt ? new Date(r.createdAt).toLocaleString("fr-FR") : ""}
              >
                {fmtAge(r.createdAt, now ?? r.ts)}
              </span>
            </td>

            <td className="px-2">
              <div className="flex items-center gap-1.5 overflow-hidden">
                <span
                  className={`shrink-0 rounded-[2px] px-1 text-[9px] font-semibold uppercase leading-[14px] ${
                    r.protocol === "dlmm"
                      ? "bg-[#1a2c3d] text-[#63b3ed]"
                      : "bg-[#2d2439] text-[#b794f4]"
                  }`}
                >
                  {r.protocol === "dlmm" ? "DL" : "D2"}
                </span>
                <span className="truncate font-medium text-fg" title={r.name}>
                  {base}
                </span>
                <span className="shrink-0 text-fg-faint">/{quote}</span>
                {r.launchpad ? (
                  <span
                    className="shrink-0 rounded-[2px] bg-raised px-1 text-[9px] uppercase text-fg-faint"
                    title={`lancée via ${r.launchpad}`}
                  >
                    {r.launchpad.slice(0, 8)}
                  </span>
                ) : null}
              </div>
            </td>

            {/* ---- ça imprime ? ---- */}
            <td className="px-1">
              <HeatCell value={r.heatPctHr} />
            </td>
            <td className="px-2">
              <Num value={r.feeRateUsdMin} format={fmtRate} className="font-semibold text-fg" />
            </td>
            <td className="px-2">
              <Num value={r.volumeRateUsdMin} format={fmtRate} className="text-fg-dim" />
            </td>
            <td className="px-2">
              <Sparkline points={r.sparkline} />
            </td>
            <td className="px-2">
              <Num value={r.tvl} format={fmtUsd} className="text-fg-dim" />
            </td>
            <td className="px-2">
              <Num value={r.volume30m} format={fmtUsd} className="text-fg-dim" />
            </td>
            <td className="px-2">
              <span
                className={`tnum block text-right ${
                  r.sampleCount >= 5 ? "text-fg-faint" : "text-warn"
                }`}
                title={`${r.sampleCount} échantillons — en dessous de 5, le taux dérivé est peu fiable`}
              >
                {r.sampleCount}
              </span>
            </td>

            {/* ---- c'est safe ? ---- */}
            <td className="border-l border-line px-2">
              <SafetyBadge row={r} />
            </td>
            <td className="px-2">
              <LpLockedBar pct={r.lpLockedPct} />
            </td>
            <td className="px-2">
              <span
                className={`tnum block text-right ${
                  r.holders >= 500 ? "text-fg-dim" : "text-warn"
                }`}
                title={`${fmtInt(r.holders)} holders`}
              >
                {fmtInt(r.holders)}
              </span>
            </td>
            <td className="px-2">
              <span
                className="text-[10px]"
                title={
                  r.freezeDisabled
                    ? "freeze authority désactivée"
                    : "freeze authority ACTIVE — le token peut être gelé"
                }
              >
                {r.freezeDisabled ? (
                  <span className="text-fg-faint opacity-30">·</span>
                ) : (
                  <span className="text-down">❄</span>
                )}
              </span>
            </td>

            <td className="px-2">
              <TokenLinks mint={r.riskyMint} poolAddress={r.address} />
            </td>
          </tr>
        );
      }),
    [rows, entering, now, selected, onSelect],
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="text-[9px] uppercase tracking-wide text-fg-faint">
            <th colSpan={2} className="border-b border-line px-2 pt-1.5 text-left" />
            <th colSpan={6} className="border-b border-line px-2 pt-1.5 text-left text-up">
              ça imprime ?
            </th>
            <th colSpan={4} className="border-b border-line border-l px-2 pt-1.5 text-left text-warn">
              c&apos;est safe ?
            </th>
          </tr>
          <tr className="border-b border-line-strong text-[10px] font-semibold uppercase tracking-wide text-fg-faint">
            <th className="w-[56px] px-2 py-1.5 text-right">Âge</th>
            <th className="w-[190px] px-2 py-1.5 text-left">Pool</th>
            <th className="w-[92px] px-2 py-1.5 text-right">Heat %/h</th>
            <th className="w-[74px] px-2 py-1.5 text-right">Fees/min</th>
            <th className="w-[74px] px-2 py-1.5 text-right">Vol/min</th>
            <th className="w-[72px] px-2 py-1.5 text-left">Tendance</th>
            <th className="w-[74px] px-2 py-1.5 text-right">TVL</th>
            <th className="w-[74px] px-2 py-1.5 text-right">Vol 30m</th>
            <th className="w-[40px] px-2 py-1.5 text-right" title="nombre d'échantillons">
              n
            </th>
            <th className="w-[48px] border-l border-line px-2 py-1.5 text-left">Rug</th>
            <th className="w-[72px] px-2 py-1.5 text-left">LP 🔒</th>
            <th className="w-[64px] px-2 py-1.5 text-right">Holders</th>
            <th className="w-[36px] px-2 py-1.5 text-left" title="freeze authority">
              ❄
            </th>
            <th className="w-[86px] px-2 py-1.5 text-left">Liens</th>
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>

      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-fg-faint">
          Aucune pool récente ne dépasse le seuil anti-poussière. Élargis la fenêtre ou baisse les
          minimums.
        </div>
      ) : null}
    </div>
  );
}
