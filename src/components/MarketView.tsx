"use client";

import { useCallback, useEffect, useState } from "react";
import { AmountFilter } from "@/components/AmountFilter";
import { MarketTable, type SortKey } from "@/components/MarketTable";
import { Nav } from "@/components/Nav";
import { PoolDetail } from "@/components/PoolDetailLazy";
import { Select } from "@/components/Select";
import { useLiveRows } from "@/lib/useLiveRows";
import type { PoolsResponse } from "@/lib/api-types";

interface Filters {
  minTvl: number | null;
  maxTvl: number | null;
  minHeat: number;
  protocol: "" | "dlmm" | "damm_v2";
  maxAgeMinutes: number | "";
}

const DEFAULT_FILTERS: Filters = {
  minTvl: 5_000,
  maxTvl: null,
  minHeat: 0,
  protocol: "",
  maxAgeMinutes: "",
};

/** Valeurs proposées dans les deux champs TVL. La saisie reste libre. */
const TVL_PRESETS = [0, 500, 5_000, 50_000, 500_000, 5_000_000] as const;

export function MarketView({ initial }: { initial: PoolsResponse }) {
  const [sort, setSort] = useState<SortKey>("heat");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);
  const closeDetail = useCallback(() => setSelected(null), []);

  const buildQuery = useCallback(() => {
    const q = new URLSearchParams({ sort, limit: "100" });
    if (filters.minTvl !== null && filters.minTvl > 0) q.set("minTvl", String(filters.minTvl));
    if (filters.maxTvl !== null) q.set("maxTvl", String(filters.maxTvl));
    if (filters.minHeat > 0) q.set("minHeat", String(filters.minHeat));
    if (filters.protocol) q.set("protocol", filters.protocol);
    if (filters.maxAgeMinutes !== "") q.set("maxAgeMinutes", String(filters.maxAgeMinutes));
    return q;
  }, [sort, filters]);

  // Un intervalle vide renverrait zéro ligne sans rien expliquer : mieux vaut
  // dire pourquoi le tableau est vide que laisser croire à une panne.
  const inverted =
    filters.maxTvl !== null && filters.minTvl !== null && filters.maxTvl < filters.minTvl;

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

      <div className="flex items-center gap-3 border-b border-line bg-app px-3 py-1.5 text-[11px]">
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
          onChange={(v) =>
            setFilters((f) => ({ ...f, maxAgeMinutes: v === "" ? "" : Number(v) }))
          }
          options={[
            ["", "tout"],
            [60, "1 h"],
            [360, "6 h"],
            [1440, "24 h"],
          ]}
        />
        {inverted ? (
          <span className="text-warn" title="Aucune pool ne peut satisfaire les deux bornes">
            ⚠ TVL max inférieur au min
          </span>
        ) : null}
        {error ? <span className="ml-auto text-down">⚠ {error}</span> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <MarketTable
          rows={rows}
          sort={sort}
          onSortChange={setSort}
          selected={selected}
          onSelect={setSelected}
        />
      </div>

      {selected ? <PoolDetail address={selected} onClose={closeDetail} /> : null}

      <footer className="border-t border-line bg-surface px-3 py-1 text-[10px] text-fg-faint">
        Heat = part du TVL versée en fees par heure, dérivée de Δfees cumulées sur une fenêtre
        glissante. Le compteur de Meteora ne bouge que par sauts (~1/min) : la fenêtre remonte
        jusqu&apos;à en capter trois, donc elle se resserre sur une pool active et s&apos;étire sur une
        pool calme. Les valeurs grisées reposent sur une fenêtre encore incomplète. Résolution bien
        au-delà des 30 min, seul pas exposé par les APIs.
      </footer>
    </div>
  );
}
