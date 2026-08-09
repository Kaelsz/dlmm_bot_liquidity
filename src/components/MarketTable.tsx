"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HeatCell } from "@/components/HeatCell";
import { Num, SignedNum , Tentative } from "@/components/Num";
import { SafetyBadge } from "@/components/SafetyBadge";
import { Sparkline } from "@/components/Sparkline";
import { TokenLinks } from "@/components/TokenLinks";
import { fmtAge, fmtInt, fmtPct, fmtPrice, fmtRate, fmtUsd, splitPairName } from "@/lib/format";
import { isRateReliable } from "@/data/metrics";
import type { PoolRow } from "@/lib/api-types";
import { COLUMNS, tableMinWidth, type ColumnKey } from "@/lib/columns";

export type SortKey =
  | "heat"
  | "rate"
  | "volumeRate"
  | "tvl"
  | "volume"
  | "mcap"
  | "age"
  | "accel";

const SORT_FOR_COL: Partial<Record<string, SortKey>> = {
  heat: "heat",
  rate: "rate",
  volumeRate: "volumeRate",
  accel: "accel",
  tvl: "tvl",
  mcap: "mcap",
  volume: "volume",
  age: "age",
};


/**
 * Ce que l'infobulle du volume doit dire, puisque la colonne a changé de sens.
 *
 * Trois choses qu'on ne peut pas deviner du chiffre seul : qu'il couvre tous
 * les DEX et pas seulement Meteora, qu'il est moyenné sur 5 minutes là où les
 * fees sont vraiment à la minute, et le volume de la pool — celui qui explique
 * les fees encaissées, et qui disparaîtrait sinon de l'interface.
 */
function tokenVolTitle(r: PoolRow): string {
  if (r.tokenVolumeUsdMin === null) return "volume du token pas encore mesuré";
  // Les totaux par fenêtre sont là pour le recoupement : GMGN et DexScreener
  // affichent des totaux, cette colonne un taux par minute. Sans eux, « 17 M$
  // sur GMGN » contre « 3 502 $/min » se lit comme une erreur — vérifié à
  // 0,2 % près contre un agrégateur indépendant, c'est la même donnée.
  const lines = [
    `volume du token, tous DEX — taux dérivé de la fenêtre 5 min`,
    `total 5 min  ${r.tokenVolume5m === null ? "—" : fmtUsd(r.tokenVolume5m)}`,
    `total 1 h    ${r.tokenVolume1h === null ? "—" : fmtUsd(r.tokenVolume1h)}`,
    `total 24 h   ${r.tokenVolume24h === null ? "—" : fmtUsd(r.tokenVolume24h)}   (mêmes chiffres que GMGN)`,
    `${r.tokenVolumePairs} paire${r.tokenVolumePairs > 1 ? "s" : ""}${r.tokenVolumeTruncated ? " (30 max atteint : somme partielle)" : ""}`,
    `cette pool seule : ${fmtRate(r.volumeRateUsdMin)} (dérivé à la minute)`,
  ];
  const share =
    r.tokenVolumeUsdMin > 0 ? (r.volumeRateUsdMin / r.tokenVolumeUsdMin) * 100 : null;
  // Le rapport peut dépasser 100 % sans que rien ne soit faux : la pool est
  // mesurée sur environ une minute, le token sur cinq. Une rafale récente
  // gonfle la première et se dilue dans la seconde. On le dit plutôt que de
  // masquer un chiffre qui passerait pour un bug.
  if (share !== null) {
    lines.push(
      share <= 100
        ? `soit ${share.toFixed(0)} % du flux du token`
        : `la pool dépasse la moyenne 5 min du token : rafale en cours`,
    );
  }
  return lines.join("\n");
}

/** Fenêtre pas encore remplie : la valeur s'affiche mais se lit avec réserve. */
const lowConf = (r: PoolRow): boolean => !isRateReliable(r);

export function MarketTable({
  rows,
  sort,
  onSortChange,
  selected,
  onSelect,
  visible,
}: {
  rows: PoolRow[];
  sort: SortKey;
  onSortChange: (s: SortKey) => void;
  selected: string | null;
  onSelect: (address: string) => void;
  visible: ReadonlySet<ColumnKey>;
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

  // Une cellule par clé de colonne, plutôt qu'une suite de <td> figée.
  //
  // C'est ce qui rend la sélection possible sans risque : l'en-tête et le corps
  // sont engendrés par la MÊME liste filtrée, donc ils ne peuvent pas se
  // désynchroniser. Avec quinze <td> écrits à la main, masquer une colonne
  // décalait silencieusement toutes les suivantes.
  const cellFor = useCallback(
    (key: ColumnKey, r: PoolRow, nowMs: number | null) => {
      switch (key) {
        case "pool": {
          const { base, quote } = splitPairName(r.name);
          return (
            <div className="flex items-center gap-1.5 overflow-hidden">
              <span
                className={`shrink-0 rounded-[2px] px-1 text-[9px] font-semibold uppercase leading-[14px] ${
                  r.protocol === "dlmm" ? "bg-[#1a2c3d] text-[#63b3ed]" : "bg-[#2d2439] text-[#b794f4]"
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
          );
        }
        case "heat":
          return (
            <Tentative low={lowConf(r)} spanMs={r.rateSpanMs} updates={r.rateUpdates}>
              <HeatCell value={r.heatPctHr} />
            </Tentative>
          );
        case "rate":
          return (
            <Tentative low={lowConf(r)} spanMs={r.rateSpanMs} updates={r.rateUpdates}>
              <Num value={r.feeRateUsdMin} format={fmtRate} className="font-semibold text-fg" />
            </Tentative>
          );
        case "volumeRate":
          // Volume du TOKEN, pas de la pool. Sans <Tentative> : ce marqueur
          // décrit la fenêtre de dérivation des fees, qui n'a rien à voir avec
          // cette mesure — l'afficher ici mentirait sur sa fiabilité.
          return (
            <span className="tnum block whitespace-nowrap text-right text-fg-dim" title={tokenVolTitle(r)}>
              {r.tokenVolumeUsdMin === null ? "—" : fmtRate(r.tokenVolumeUsdMin)}
            </span>
          );
        case "spark":
          return <Sparkline points={r.sparkline} />;
        case "accel":
          return <SignedNum value={r.feeAccel} format={(v) => fmtRate(Math.abs(v ?? 0))} />;
        case "tvl":
          return <Num value={r.tvl} format={fmtUsd} className="text-fg-dim" />;
        case "mcap":
          // 0 = market cap inconnu, pas minuscule : un tiret plutôt que « $0 »,
          // qui se lirait comme une mesure.
          return (
            <span className="tnum block whitespace-nowrap text-right text-fg-dim">
              {r.marketCap > 0 ? fmtUsd(r.marketCap) : "—"}
            </span>
          );
        case "volume":
          return <Num value={r.volume30m} format={fmtUsd} className="text-fg-dim" />;
        case "fees":
          return <Num value={r.fees30m} format={fmtUsd} className="text-fg-dim" />;
        case "fee":
          return (
            <span
              className="tnum block whitespace-nowrap text-right text-fg-dim"
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
          );
        case "price":
          return <Num value={r.price} format={fmtPrice} className="text-fg-dim" />;
        case "age":
          return (
            <span
              className="tnum block whitespace-nowrap text-right text-fg-dim"
              title={r.createdAt ? new Date(r.createdAt).toLocaleString("fr-FR") : ""}
            >
              {fmtAge(r.createdAt, nowMs ?? r.ts)}
            </span>
          );
        case "safety":
          return (
            <div className="flex items-center gap-1">
              <SafetyBadge row={r} />
              <SafetyIcons row={r} />
            </div>
          );
        case "links":
          return <TokenLinks mint={r.riskyMint} poolAddress={r.address} />;
      }
    },
    [],
  );

  const cols = useMemo(() => COLUMNS.filter((c) => visible.has(c.key)), [visible]);
  const minWidth = useMemo(() => tableMinWidth(visible), [visible]);

  const body = useMemo(
    () =>
      rows.map((r) => {
        const isNew = entering.has(r.address);
        return (
          <tr
            key={r.address}
            onClick={() => onSelect(r.address)}
            className={`h-row cursor-pointer border-b border-line hover:bg-hover ${
              isNew ? "row-enter" : ""
            } ${selected === r.address ? "row-selected" : ""}`}
          >
            {cols.map((c) => (
              <td key={c.key} className={c.key === "heat" ? "px-1" : "px-2"}>
                {cellFor(c.key, r, now)}
              </td>
            ))}
          </tr>
        );
      }),
    [rows, entering, now, selected, onSelect, cols, cellFor],
  );

  return (
    <div className="overflow-x-auto">
      {/* hidden md:table : le tableau disparaît sous 768 px au profit de
          <MarketCards>. Bascule en CSS et non en JavaScript, pour qu'aucun état
          React ne s'interpose entre le rendu serveur et le rendu client.

          minWidth = somme des colonnes VISIBLES. Sans elle, `w-full` laissait
          le navigateur comprimer les colonnes sous leur largeur nominale : en
          dessous de ~1 150 px le texte passait sur deux lignes et débordait de
          la cellule Heat, dont la hauteur est fixe. Le conteneur défile
          désormais au lieu d'écraser, et masquer des colonnes recule d'autant
          le seuil de défilement. */}
      <table
        className="hidden w-full border-collapse text-[12px] md:table"
        style={{ minWidth }}
      >
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-line-strong">
            {cols.map((c) => {
              const sortKey = SORT_FOR_COL[c.key];
              const active = sortKey && sortKey === sort;
              return (
                <th
                  key={c.key}
                  style={{ width: c.width }}
                  className={`whitespace-nowrap px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide ${
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
