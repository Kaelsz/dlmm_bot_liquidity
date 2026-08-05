"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { HeatCell } from "@/components/HeatCell";
import { Num, SignedNum , Tentative } from "@/components/Num";
import { SafetyBadge } from "@/components/SafetyBadge";
import { Sparkline } from "@/components/Sparkline";
import { TokenLinks } from "@/components/TokenLinks";
import { fmtAge, fmtInt, fmtPct, fmtPrice, fmtRate, fmtUsd, splitPairName } from "@/lib/format";
import { isRateReliable } from "@/data/metrics";
import type { PoolRow } from "@/lib/api-types";

const COLS = [
  { key: "pool", label: "Pool", w: "min-w-[190px] w-[190px]", align: "left" },
  { key: "heat", label: "Heat %/h", w: "w-[92px]", align: "right", sortable: true },
  { key: "rate", label: "Fees/min", w: "w-[74px]", align: "right", sortable: true },
  { key: "volumeRate", label: "Vol/min", w: "w-[74px]", align: "right", sortable: true },
  { key: "spark", label: "Tendance", w: "w-[72px]", align: "left" },
  { key: "accel", label: "Accél.", w: "w-[76px]", align: "right", sortable: true },
  { key: "tvl", label: "TVL", w: "w-[74px]", align: "right", sortable: true },
  { key: "volume", label: "Vol 30m", w: "w-[74px]", align: "right", sortable: true },
  { key: "fees", label: "Fees 30m", w: "w-[74px]", align: "right" },
  { key: "fee", label: "Frais", w: "w-[74px]", align: "right" },
  { key: "price", label: "Prix", w: "w-[84px]", align: "right" },
  { key: "age", label: "Âge", w: "w-[56px]", align: "right", sortable: true },
  { key: "safety", label: "Sécu", w: "w-[64px]", align: "left" },
  { key: "links", label: "Liens", w: "w-[86px]", align: "left" },
] as const;

export type SortKey = "heat" | "rate" | "volumeRate" | "tvl" | "volume" | "age" | "accel";

const SORT_FOR_COL: Partial<Record<string, SortKey>> = {
  heat: "heat",
  rate: "rate",
  volumeRate: "volumeRate",
  accel: "accel",
  tvl: "tvl",
  volume: "volume",
  age: "age",
};


/** Fenêtre pas encore remplie : la valeur s'affiche mais se lit avec réserve. */
const lowConf = (r: PoolRow): boolean => !isRateReliable(r);

export function MarketTable({
  rows,
  sort,
  onSortChange,
  selected,
  onSelect,
}: {
  rows: PoolRow[];
  sort: SortKey;
  onSortChange: (s: SortKey) => void;
  selected: string | null;
  onSelect: (address: string) => void;
}) {
  // Track which addresses are new since the last render so they can be
  // highlighted once on arrival.
  const known = useRef<Set<string>>(new Set());
  const [entering, setEntering] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fresh = new Set<string>();
    for (const r of rows) if (!known.current.has(r.address)) fresh.add(r.address);
    // The very first paint is not an "arrival" — everything would glow.
    if (known.current.size > 0 && fresh.size > 0) {
      setEntering(fresh);
      const t = setTimeout(() => setEntering(new Set()), 1300);
      for (const r of rows) known.current.add(r.address);
      return () => clearTimeout(t);
    }
    for (const r of rows) known.current.add(r.address);
  }, [rows]);

  // Clock for the age column, which has to keep ticking between data pushes.
  //
  // It starts as null rather than Date.now(): the server renders at one instant
  // and the client hydrates at another, so seeding from the wall clock makes
  // the two trees disagree and React throws away the server HTML. Until the
  // effect runs, ages are measured against each row's own metric timestamp,
  // which is identical on both sides.
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
        const isNew = entering.has(r.address);
        return (
          <tr
            key={r.address}
            onClick={() => onSelect(r.address)}
            className={`h-row cursor-pointer border-b border-line hover:bg-hover ${
              isNew ? "row-enter" : ""
            } ${selected === r.address ? "row-selected" : ""}`}
          >
            <td className="px-2">
              <div className="flex items-center gap-1.5 overflow-hidden">
                <span
                  className={`shrink-0 rounded-[2px] px-1 text-[9px] font-semibold uppercase leading-[14px] ${
                    r.protocol === "dlmm"
                      ? "bg-[#1a2c3d] text-[#63b3ed]"
                      : "bg-[#2d2439] text-[#b794f4]"
                  }`}
                  title={r.protocol === "dlmm" ? "DLMM" : "DAMM v2"}
                >
                  {r.protocol === "dlmm" ? "DL" : "D2"}
                </span>
                <span className="truncate font-medium text-fg" title={r.name}>
                  {base}
                </span>
                <span className="shrink-0 text-fg-faint">/{quote}</span>
                {r.binStep ? (
                  <span className="tnum shrink-0 text-[10px] text-fg-faint" title="bin step">
                    {r.binStep}
                  </span>
                ) : null}
              </div>
            </td>

            <td className="px-1">
              <Tentative low={lowConf(r)} spanMs={r.rateSpanMs} updates={r.rateUpdates}>
                <HeatCell value={r.heatPctHr} />
              </Tentative>
            </td>

            <td className="px-2">
              <Tentative low={lowConf(r)} spanMs={r.rateSpanMs} updates={r.rateUpdates}>
                <Num value={r.feeRateUsdMin} format={fmtRate} className="font-semibold text-fg" />
              </Tentative>
            </td>

            <td className="px-2">
              <Tentative low={lowConf(r)} spanMs={r.rateSpanMs} updates={r.rateUpdates}>
                <Num value={r.volumeRateUsdMin} format={fmtRate} className="text-fg-dim" />
              </Tentative>
            </td>

            <td className="px-2">
              <Sparkline points={r.sparkline} />
            </td>

            <td className="px-2">
              <SignedNum value={r.feeAccel} format={(v) => fmtRate(Math.abs(v ?? 0))} />
            </td>

            <td className="px-2">
              <Num value={r.tvl} format={fmtUsd} className="text-fg-dim" />
            </td>

            <td className="px-2">
              <Num value={r.volume30m} format={fmtUsd} className="text-fg-dim" />
            </td>

            <td className="px-2">
              <Num value={r.fees30m} format={fmtUsd} className="text-fg-dim" />
            </td>

            <td className="px-2">
              <span
                className="tnum block text-right text-fg-dim"
                title={
                  r.dynamicFeePct !== null
                    ? `frais de base ${r.baseFeePct} %, dynamique ${r.dynamicFeePct} %`
                    : `frais de base ${r.baseFeePct} %`
                }
              >
                {r.dynamicFeePct !== null && r.dynamicFeePct !== r.baseFeePct ? (
                  <span className="text-warn">{fmtPct(r.dynamicFeePct, 2)}</span>
                ) : (
                  fmtPct(r.baseFeePct, 2)
                )}
              </span>
            </td>

            <td className="px-2">
              <Num value={r.price} format={fmtPrice} className="text-fg-dim" />
            </td>

            <td className="px-2">
              <span
                className="tnum block text-right text-fg-dim"
                title={r.createdAt ? new Date(r.createdAt).toLocaleString("fr-FR") : ""}
              >
                {fmtAge(r.createdAt, now ?? r.ts)}
              </span>
            </td>

            <td className="px-2">
              <div className="flex items-center gap-1">
                <SafetyBadge row={r} />
                <SafetyIcons row={r} />
              </div>
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
      {/* hidden md:table : le tableau disparaît sous 768 px au profit de
          <MarketCards>. Bascule en CSS et non en JavaScript, pour que le rendu
          desktop reste exactement celui d'avant — aucun état React, aucun
          risque de décalage d'hydratation. */}
      <table className="hidden w-full border-collapse text-[12px] md:table">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-line-strong">
            {COLS.map((c) => {
              const sortKey = SORT_FOR_COL[c.key];
              const active = sortKey && sortKey === sort;
              return (
                <th
                  key={c.key}
                  className={`${c.w} px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide ${
                    c.align === "right" ? "text-right" : "text-left"
                  } ${sortKey ? "cursor-pointer select-none hover:text-fg" : ""} ${
                    active ? "text-accent" : "text-fg-faint"
                  }`}
                  onClick={sortKey ? () => onSortChange(sortKey) : undefined}
                >
                  {c.label}
                  {active ? " ↓" : ""}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>

      {rows.length === 0 ? (
        <div className="hidden px-4 py-10 text-center text-fg-faint md:block">
          Aucune pool ne correspond aux filtres.
        </div>
      ) : null}
    </div>
  );
}

/**
 * Compact risk glyphs. Absence of a warning is shown as a dim dot rather than
 * nothing, so a row where the data is simply missing does not read as safe.
 */
function SafetyIcons({ row }: { row: PoolRow }) {
  const items: Array<{ ok: boolean | null; label: string; glyph: string }> = [
    {
      ok: row.isBlacklisted ? false : true,
      label: row.isBlacklisted ? "blacklistée par Meteora" : "pas blacklistée",
      glyph: "⛔",
    },
    {
      ok: row.freezeDisabled ? true : false,
      label: row.freezeDisabled
        ? "freeze authority désactivée"
        : "freeze authority ACTIVE — le token peut être gelé",
      glyph: "❄",
    },
    {
      ok: row.holders >= 500 ? true : row.holders > 0 ? false : null,
      label: `${fmtInt(row.holders)} holders`,
      glyph: "👥",
    },
  ];
  return (
    <div className="flex items-center gap-1">
      {items.map((it, i) => (
        <span
          key={i}
          title={it.label}
          className={`text-[10px] leading-none ${
            it.ok === true ? "opacity-25" : it.ok === false ? "opacity-100" : "opacity-15"
          }`}
        >
          {it.ok === false ? it.glyph : "·"}
        </span>
      ))}
      {row.verified ? (
        <span title="token vérifié" className="text-[10px] leading-none text-accent">
          ✓
        </span>
      ) : null}
    </div>
  );
}
