"use client";

import { useCallback, useEffect, useState } from "react";
import { MarketTable, type SortKey } from "@/components/MarketTable";
import { Nav } from "@/components/Nav";
import { PoolDetail } from "@/components/PoolDetailLazy";
import { Select } from "@/components/Select";
import { useLiveRows } from "@/lib/useLiveRows";
import type { PoolsResponse } from "@/lib/api-types";

interface Filters {
  minTvl: number;
  minHeat: number;
  protocol: "" | "dlmm" | "damm_v2";
  maxAgeMinutes: number | "";
}

const DEFAULT_FILTERS: Filters = { minTvl: 5_000, minHeat: 0, protocol: "", maxAgeMinutes: "" };

export function MarketView({ initial }: { initial: PoolsResponse }) {
  const [sort, setSort] = useState<SortKey>("heat");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);
  const closeDetail = useCallback(() => setSelected(null), []);

  const buildQuery = useCallback(() => {
    const q = new URLSearchParams({ sort, limit: "100" });
    if (filters.minTvl > 0) q.set("minTvl", String(filters.minTvl));
    if (filters.minHeat > 0) q.set("minHeat", String(filters.minHeat));
    if (filters.protocol) q.set("protocol", filters.protocol);
    if (filters.maxAgeMinutes !== "") q.set("maxAgeMinutes", String(filters.maxAgeMinutes));
    return q;
  }, [sort, filters]);

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
        <Select
          label="TVL min"
          value={filters.minTvl}
          onChange={(v) => setFilters((f) => ({ ...f, minTvl: Number(v) }))}
          options={[
            [0, "tout"],
            [500, "$500"],
            [5_000, "$5k"],
            [50_000, "$50k"],
            [500_000, "$500k"],
          ]}
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
        Heat = part du TVL versée en fees par heure, dérivée de Δfees cumulées entre deux
        échantillons. $/min = taux instantané. Les deux se calculent à la minute — les APIs Meteora
        n&apos;exposent rien de plus fin que 30 min.
      </footer>
    </div>
  );
}
