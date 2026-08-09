"use client";

import { useCallback, useEffect, useState } from "react";
import { AmountFilter } from "@/components/AmountFilter";
import { ColumnPicker, useColumns } from "@/components/ColumnPicker";
import { MarketCards } from "@/components/MarketCards";
import { MarketTable, type SortKey } from "@/components/MarketTable";
import { Nav } from "@/components/Nav";
import { PoolDetail } from "@/components/PoolDetailLazy";
import { Select } from "@/components/Select";
import { useLiveRows } from "@/lib/useLiveRows";
import type { PoolsResponse } from "@/lib/api-types";

interface Filters {
  minTvl: number | null;
  maxTvl: number | null;
  minMcap: number | null;
  maxMcap: number | null;
  minHeat: number;
  protocol: "" | "dlmm" | "damm_v2";
  maxAgeMinutes: number | "";
}

const DEFAULT_FILTERS: Filters = {
  minTvl: 5_000,
  maxTvl: null,
  minMcap: null,
  maxMcap: null,
  minHeat: 0,
  protocol: "",
  maxAgeMinutes: "",
};

/** Valeurs proposées dans les deux champs TVL. La saisie reste libre. */
const TVL_PRESETS = [0, 500, 5_000, 50_000, 500_000, 5_000_000] as const;

/**
 * Paliers de market cap, calibrés sur la réalité memecoin et non sur les
 * catégories boursières : ici une « grosse » capitalisation commence vers
 * $100 M, pas $10 Md. Pas de curseur — l'échelle va de $100 k à $50 Md, donc
 * logarithmique, et un slider y serait imprécis là où ça compte le plus.
 */
const MCAP_PRESETS = [100_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000] as const;

export function MarketView({ initial }: { initial: PoolsResponse }) {
  const [sort, setSort] = useState<SortKey>("heat");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Sélection des colonnes, retenue par appareil (cf. ColumnPicker).
  const { visible, toggle, reset } = useColumns();
  const closeDetail = useCallback(() => setSelected(null), []);

  const buildQuery = useCallback(() => {
    const q = new URLSearchParams({ sort, limit: "100" });
    if (filters.minTvl !== null && filters.minTvl > 0) q.set("minTvl", String(filters.minTvl));
    if (filters.maxTvl !== null) q.set("maxTvl", String(filters.maxTvl));
    if (filters.minMcap !== null) q.set("minMcap", String(filters.minMcap));
    if (filters.maxMcap !== null) q.set("maxMcap", String(filters.maxMcap));
    if (filters.minHeat > 0) q.set("minHeat", String(filters.minHeat));
    if (filters.protocol) q.set("protocol", filters.protocol);
    if (filters.maxAgeMinutes !== "") q.set("maxAgeMinutes", String(filters.maxAgeMinutes));
    return q;
  }, [sort, filters]);

  // Un intervalle vide renverrait zéro ligne sans rien expliquer : mieux vaut
  // dire pourquoi le tableau est vide que laisser croire à une panne.
  const inverted =
    filters.maxTvl !== null && filters.minTvl !== null && filters.maxTvl < filters.minTvl;

  const controls = (
    <>
      <AmountFilter
        label="TVL min"
        value={filters.minTvl}
        onCommit={(v) => setFilters((f) => ({ ...f, minTvl: v }))}
        presets={[...TVL_PRESETS]}
      />
      <AmountFilter
        label="TVL max"
        value={filters.maxTvl}
        onCommit={(v) => setFilters((f) => ({ ...f, maxTvl: v }))}
        presets={[...TVL_PRESETS].slice(1)}
      />
      <AmountFilter
        label="Mcap min"
        value={filters.minMcap}
        onCommit={(v) => setFilters((f) => ({ ...f, minMcap: v }))}
        presets={[...MCAP_PRESETS]}
      />
      <AmountFilter
        label="Mcap max"
        value={filters.maxMcap}
        onCommit={(v) => setFilters((f) => ({ ...f, maxMcap: v }))}
        presets={[...MCAP_PRESETS]}
      />
      <Select
        label="Heat min"
        value={filters.minHeat}
        onChange={(v) => setFilters((f) => ({ ...f, minHeat: Number(v) }))}
        options={[
          [0, "tout"],
          [0.5, "0,5 %/h"],
          [2, "2 %/h"],
          [5, "5 %/h"],
          [15, "15 %/h"],
        ]}
      />
      <Select
        label="Protocole"
        value={filters.protocol}
        onChange={(v) => setFilters((f) => ({ ...f, protocol: v as Filters["protocol"] }))}
        options={[
          ["", "les deux"],
          ["dlmm", "DLMM"],
          ["damm_v2", "DAMM v2"],
        ]}
      />
      <Select
        label="Âge max"
        value={filters.maxAgeMinutes}
        onChange={(v) => setFilters((f) => ({ ...f, maxAgeMinutes: v === "" ? "" : Number(v) }))}
        options={[
          ["", "tout"],
          [60, "1 h"],
          [360, "6 h"],
          [1440, "24 h"],
        ]}
      />
    </>
  );

  const activeCount = [
    filters.minTvl !== null && filters.minTvl > 0,
    filters.maxTvl !== null,
    filters.minMcap !== null,
    filters.maxMcap !== null,
    filters.minHeat > 0,
    filters.protocol !== "",
    filters.maxAgeMinutes !== "",
  ].filter(Boolean).length;

  const { rows, counts, lastUpdate, live, error, now, refresh } = useLiveRows(
    "/api/pools",
    buildQuery,
    initial,
  );

  useEffect(() => {
    void refresh();
  }, [sort, filters, refresh]);

  return (
    <div className="flex h-full flex-col">
      <Nav counts={counts} lastUpdate={lastUpdate} live={live} now={now} />

      {/* Les contrôles sont définis une fois et rendus dans deux enveloppes :
          la barre desktop, inchangée, et le panneau dépliant mobile. */}
      <div className="hidden items-center gap-3 border-b border-line bg-app px-3 py-1.5 text-[11px] md:flex">
        {controls}
        {inverted ? (
          <span className="text-warn" title="Aucune pool ne peut satisfaire les deux bornes">
            ⚠ intervalle inversé
          </span>
        ) : null}
        {error ? <span className="ml-auto text-down">⚠ {error}</span> : null}
        <span className={error ? "" : "ml-auto"}>
          {visible ? <ColumnPicker visible={visible} onToggle={toggle} onReset={reset} /> : null}
        </span>
      </div>

      {/* Mobile : les filtres tiendraient sur trois lignes et mangeraient la
          moitié de l'écran. Ils sont donc repliés derrière un bouton qui
          annonce combien de critères sont actifs. */}
      <div className="border-b border-line bg-app md:hidden">
        <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
          <button
            onClick={() => setFiltersOpen((o) => !o)}
            className="min-h-[44px] rounded-[3px] bg-raised px-4 text-accent active:bg-hover"
          >
            Filtres{activeCount > 0 ? ` (${activeCount})` : ""} {filtersOpen ? "▲" : "▼"}
          </button>
          {/* Le sélecteur vaut autant sur téléphone : c'est là que la place
              manque le plus, et le stockage local donne à l'appareil sa propre
              vue sans configuration partagée. */}
          {visible ? <ColumnPicker visible={visible} onToggle={toggle} onReset={reset} /> : null}
          {inverted ? <span className="text-warn">⚠ intervalle inversé</span> : null}
          {error ? <span className="ml-auto text-down">⚠ {error}</span> : null}
        </div>
        {filtersOpen ? (
          <div className="flex flex-col gap-2.5 px-3 pb-3 text-[12px]">
            {controls}
            {/* Sur mobile les en-têtes de colonnes disparaissent avec le
                tableau : sans ce sélecteur, le tri deviendrait inatteignable. */}
            <Select
              label="Trier par"
              value={sort}
              onChange={(v) => setSort(v as SortKey)}
              options={[
                ["heat", "Heat %/h"],
                ["rate", "Fees/min"],
                ["volumeRate", "Vol/min"],
                ["accel", "Accélération"],
                ["tvl", "TVL"],
                ["mcap", "Market cap"],
                ["volume", "Volume 30 m"],
                ["age", "Âge"],
              ]}
            />
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {/* `visible` est null au premier rendu, le temps que localStorage soit
            lisible côté client. Rendre le jeu par défaut en attendant ferait
            clignoter les colonnes masquées à chaque chargement. */}
        {visible ? (
          <>
            <MarketTable
              rows={rows}
              sort={sort}
              onSortChange={setSort}
              selected={selected}
              onSelect={setSelected}
              visible={visible}
            />
            <MarketCards
              rows={rows}
              selected={selected}
              onSelect={setSelected}
              now={now}
              visible={visible}
            />
          </>
        ) : null}
      </div>

      {selected ? <PoolDetail address={selected} onClose={closeDetail} /> : null}

      <footer className="hidden border-t border-line bg-surface px-3 py-1 text-[10px] text-fg-faint md:block">
        Heat = part du TVL versée en fees par heure, dérivée de Δfees cumulées sur une fenêtre
        glissante. Le compteur de Meteora ne bouge que par sauts (~1/min) : la fenêtre remonte
        jusqu&apos;à en capter trois, donc elle se resserre sur une pool active et s&apos;étire sur une
        pool calme. Les valeurs grisées reposent sur une fenêtre encore incomplète. Résolution bien
        au-delà des 30 min, seul pas exposé par les APIs.
      </footer>
    </div>
  );
}
