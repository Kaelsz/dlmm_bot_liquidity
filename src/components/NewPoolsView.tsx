"use client";

import { useCallback, useEffect, useState } from "react";
import { Nav } from "@/components/Nav";
import { NewPoolsTable } from "@/components/NewPoolsTable";
import { PoolDetail } from "@/components/PoolDetailLazy";
import { Select } from "@/components/Select";
import { useLiveRows } from "@/lib/useLiveRows";
import type { PoolsResponse } from "@/lib/api-types";

interface Filters {
  maxAgeMinutes: number;
  minTvl: number;
  minVolume30m: number;
  protocol: "" | "dlmm" | "damm_v2";
}

const DEFAULT_FILTERS: Filters = {
  maxAgeMinutes: 180,
  minTvl: 500,
  minVolume30m: 1_000,
  protocol: "",
};

export function NewPoolsView({ initial }: { initial: PoolsResponse }) {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);
  const closeDetail = useCallback(() => setSelected(null), []);

  const buildQuery = useCallback(() => {
    const q = new URLSearchParams({
      limit: "100",
      maxAgeMinutes: String(filters.maxAgeMinutes),
      minTvl: String(filters.minTvl),
      minVolume30m: String(filters.minVolume30m),
    });
    if (filters.protocol) q.set("protocol", filters.protocol);
    return q;
  }, [filters]);

  const { rows, counts, lastUpdate, live, error, now, refresh } = useLiveRows(
    "/api/new-pools",
    buildQuery,
    initial,
  );

  useEffect(() => {
    void refresh();
  }, [filters, refresh]);

  return (
    <div className="flex h-full flex-col">
      <Nav counts={counts} lastUpdate={lastUpdate} live={live} now={now} />

      <div className="flex items-center gap-3 border-b border-line bg-app px-3 py-1.5 text-[11px]">
        <Select
          label="Créées depuis"
          value={filters.maxAgeMinutes}
          onChange={(v) => setFilters((f) => ({ ...f, maxAgeMinutes: Number(v) }))}
          options={[
            [15, "15 min"],
            [60, "1 h"],
            [180, "3 h"],
            [720, "12 h"],
            [1440, "24 h"],
          ]}
        />
        <Select
          label="TVL min"
          value={filters.minTvl}
          onChange={(v) => setFilters((f) => ({ ...f, minTvl: Number(v) }))}
          options={[
            [0, "tout"],
            [200, "$200"],
            [500, "$500"],
            [2_000, "$2k"],
            [10_000, "$10k"],
          ]}
        />
        <Select
          label="ou Vol 30m min"
          value={filters.minVolume30m}
          onChange={(v) => setFilters((f) => ({ ...f, minVolume30m: Number(v) }))}
          options={[
            [0, "tout"],
            [500, "$500"],
            [1_000, "$1k"],
            [10_000, "$10k"],
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
        <span className="text-fg-faint">
          {rows.length} pool{rows.length > 1 ? "s" : ""}
        </span>
        {error ? <span className="ml-auto text-down">⚠ {error}</span> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <NewPoolsTable rows={rows} selected={selected} onSelect={setSelected} />
      </div>

      {selected ? <PoolDetail address={selected} onClose={closeDetail} /> : null}

      <footer className="border-t border-line bg-surface px-3 py-1 text-[10px] text-fg-faint">
        Détection en moins de 20 s via <code className="text-fg-dim">pool_created_at:desc</code>. Le
        filtre est une disjonction — TVL <em>ou</em> volume — parce qu&apos;une pool de trois minutes
        peut n&apos;avoir presque pas de liquidité tout en tradant fort, ou l&apos;inverse. Sans
        plancher, la vue serait noyée : la plupart des ~250 000 pools listées sont de la poussière.
      </footer>
    </div>
  );
}
