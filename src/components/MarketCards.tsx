"use client";

import { HeatCell } from "@/components/HeatCell";
import { Num, Tentative } from "@/components/Num";
import { SafetyBadge } from "@/components/SafetyBadge";
import { Sparkline } from "@/components/Sparkline";
import { TokenLinks } from "@/components/TokenLinks";
import { isRateReliable } from "@/data/metrics";
import { fmtAge, fmtPct, fmtRate, fmtUsd, splitPairName } from "@/lib/format";
import type { PoolRow } from "@/lib/api-types";

/**
 * Rendu mobile de la vue Marché.
 *
 * Le tableau desktop fait ~1 165 px de largeur minimale : il ne peut pas tenir
 * sur un téléphone, et le réduire en gardant sa structure produirait des
 * colonnes illisibles. D'où une carte par pool.
 *
 * CE COMPOSANT NE S'AFFICHE JAMAIS AU-DESSUS DE `md`. La bascule est faite en
 * CSS (`md:hidden` ici, `hidden md:table` sur le tableau) et non en JavaScript :
 * c'est la seule façon de garantir que le chemin desktop reste exactement le
 * code d'avant, sans dépendre d'un état React ni risquer un décalage
 * d'hydratation. Les deux arbres coexistent dans le DOM ; `display:none` ne
 * coûte ni calcul de mise en page ni peinture.
 *
 * Tout le vocabulaire visuel vient des composants déjà utilisés par le tableau
 * — même échelle thermique, mêmes formateurs, mêmes badges — pour qu'aucune
 * divergence de style ne s'installe entre les deux rendus.
 */
export function MarketCards({
  rows,
  selected,
  onSelect,
  now,
}: {
  rows: PoolRow[];
  selected: string | null;
  onSelect: (address: string) => void;
  now: number | null;
}) {
  if (rows.length === 0) {
    return <p className="px-3 py-8 text-center text-fg-faint">Aucune pool ne correspond aux filtres.</p>;
  }

  return (
    <ul className="md:hidden">
      {rows.map((r) => {
        const { base, quote } = splitPairName(r.name);
        const low = !isRateReliable(r);
        return (
          <li
            key={r.address}
            onClick={() => onSelect(r.address)}
            // min-h-[64px] : une cible tactile confortable au pouce. Les 28 px
            // du tableau sont conçus pour la souris, pas pour le doigt.
            className={`flex min-h-[64px] cursor-pointer flex-col justify-center gap-1 border-b border-line px-3 py-2 text-[13px] active:bg-hover ${
              selected === r.address ? "row-selected" : ""
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`shrink-0 rounded-[2px] px-1 text-[9px] font-semibold uppercase leading-[14px] ${
                  r.protocol === "dlmm" ? "bg-[#1a2c3d] text-[#63b3ed]" : "bg-[#2d2439] text-[#b794f4]"
                }`}
              >
                {r.protocol === "dlmm" ? "DL" : "D2"}
              </span>
              <span className="truncate font-medium text-fg">{base}</span>
              <span className="shrink-0 text-fg-faint">/{quote}</span>
              <span className="ml-auto shrink-0">
                <Tentative low={low} spanMs={r.rateSpanMs} updates={r.rateUpdates}>
                  <HeatCell value={r.heatPctHr} />
                </Tentative>
              </span>
            </div>

            <div className="flex items-center gap-3">
              <Metric label="fees/min">
                <Tentative low={low} spanMs={r.rateSpanMs} updates={r.rateUpdates}>
                  <Num value={r.feeRateUsdMin} format={fmtRate} className="font-semibold text-fg" />
                </Tentative>
              </Metric>
              <Metric label="vol/min">
                <Tentative low={low} spanMs={r.rateSpanMs} updates={r.rateUpdates}>
                  <Num value={r.volumeRateUsdMin} format={fmtRate} className="text-fg-dim" />
                </Tentative>
              </Metric>
              <span className="ml-auto shrink-0">
                <Sparkline points={r.sparkline} />
              </span>
            </div>

            <div className="flex items-center gap-3 text-[11px] text-fg-faint">
              <span>
                TVL <span className="tnum text-fg-dim">{fmtUsd(r.tvl)}</span>
              </span>
              <span>
                MCAP{" "}
                <span className="tnum text-fg-dim">
                  {r.marketCap > 0 ? fmtUsd(r.marketCap) : "—"}
                </span>
              </span>
              <span>
                <span className="tnum text-fg-dim">{fmtPct(r.baseFeePct, 2)}</span>
              </span>
              <span className="tnum">{fmtAge(r.createdAt, now ?? r.ts)}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                <SafetyBadge row={r} />
                <TokenLinks mint={r.riskyMint} poolAddress={r.address} />
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-[9px] uppercase tracking-wide text-fg-faint">{label}</span>
      {children}
    </span>
  );
}
