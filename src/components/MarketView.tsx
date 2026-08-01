"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MarketTable, type SortKey } from "@/components/MarketTable";
import { fmtInt, fmtSince } from "@/lib/format";
import type { PoolRow, PoolsResponse } from "@/lib/api-types";

interface Filters {
  minTvl: number;
  minHeat: number;
  protocol: "" | "dlmm" | "damm_v2";
  maxAgeMinutes: number | "";
}

const DEFAULT_FILTERS: Filters = { minTvl: 5_000, minHeat: 0, protocol: "", maxAgeMinutes: "" };

export function MarketView({ initial }: { initial: PoolsResponse }) {
  const [rows, setRows] = useState<PoolRow[]>(initial.rows);
  const [counts, setCounts] = useState(initial.counts);
  const [sort, setSort] = useState<SortKey>("heat");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [lastUpdate, setLastUpdate] = useState<number>(initial.generatedAt);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Kept in a ref so the SSE handler always fetches with current settings
  // without having to tear down and rebuild the connection.
  const queryRef = useRef({ sort, filters });
  queryRef.current = { sort, filters };

  const refresh = useCallback(async () => {
    const { sort: s, filters: f } = queryRef.current;
    const q = new URLSearchParams({ sort: s, limit: "100" });
    if (f.minTvl > 0) q.set("minTvl", String(f.minTvl));
    if (f.minHeat > 0) q.set("minHeat", String(f.minHeat));
    if (f.protocol) q.set("protocol", f.protocol);
    if (f.maxAgeMinutes !== "") q.set("maxAgeMinutes", String(f.maxAgeMinutes));
    try {
      const res = await fetch(`/api/pools?${q.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as PoolsResponse;
      setRows(data.rows);
      setCounts(data.counts);
      setLastUpdate(data.generatedAt);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "erreur réseau");
    }
  }, []);

  // Re-query whenever the user changes what they are looking at.
  useEffect(() => {
    void refresh();
  }, [sort, filters, refresh]);

  // Live updates. EventSource reconnects by itself, so there is no retry
  // logic here — only a flag so the header can show the real state.
  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.addEventListener("hello", () => setLive(true));
    es.addEventListener("update", () => void refresh());
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [refresh]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-line-strong bg-surface px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold tracking-tight text-fg">
            METEORA <span className="text-accent">POOL RADAR</span>
          </span>
          <span className="text-[10px] uppercase tracking-wide text-fg-faint">marché</span>
        </div>

        <div className="ml-auto flex items-center gap-4 text-[11px] text-fg-faint">
          <span title="pools suivies / échantillons stockés">
            <span className="tnum text-fg-dim">{fmtInt(counts.metrics)}</span> pools ·{" "}
            <span className="tnum text-fg-dim">{fmtInt(counts.samples)}</span> mesures
          </span>
          <span className="tnum">{fmtSince(lastUpdate, now)}</span>
          <span className="flex items-center gap-1.5" title={live ? "flux live actif" : "flux interrompu"}>
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                live ? "bg-up" : "bg-down"
              }`}
            />
            {live ? "live" : "hors ligne"}
          </span>
        </div>
      </header>

      <div className="flex items-center gap-3 border-b border-line bg-app px-3 py-1.5 text-[11px]">
        <Field label="TVL min">
          <select
            value={filters.minTvl}
            onChange={(e) => setFilters((f) => ({ ...f, minTvl: Number(e.target.value) }))}
            className="bg-raised px-1 py-0.5 text-fg outline-none focus:ring-1 focus:ring-accent"
          >
            <option value={0}>tout</option>
            <option value={500}>$500</option>
            <option value={5_000}>$5k</option>
            <option value={50_000}>$50k</option>
            <option value={500_000}>$500k</option>
          </select>
        </Field>

        <Field label="Heat min">
          <select
            value={filters.minHeat}
            onChange={(e) => setFilters((f) => ({ ...f, minHeat: Number(e.target.value) }))}
            className="bg-raised px-1 py-0.5 text-fg outline-none focus:ring-1 focus:ring-accent"
          >
            <option value={0}>tout</option>
            <option value={0.5}>0,5 %/h</option>
            <option value={2}>2 %/h</option>
            <option value={5}>5 %/h</option>
            <option value={15}>15 %/h</option>
          </select>
        </Field>

        <Field label="Protocole">
          <select
            value={filters.protocol}
            onChange={(e) =>
              setFilters((f) => ({ ...f, protocol: e.target.value as Filters["protocol"] }))
            }
            className="bg-raised px-1 py-0.5 text-fg outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">les deux</option>
            <option value="dlmm">DLMM</option>
            <option value="damm_v2">DAMM v2</option>
          </select>
        </Field>

        <Field label="Âge max">
          <select
            value={filters.maxAgeMinutes}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                maxAgeMinutes: e.target.value === "" ? "" : Number(e.target.value),
              }))
            }
            className="bg-raised px-1 py-0.5 text-fg outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">tout</option>
            <option value={60}>1 h</option>
            <option value={360}>6 h</option>
            <option value={1440}>24 h</option>
          </select>
        </Field>

        {error ? <span className="ml-auto text-down">⚠ {error}</span> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <MarketTable rows={rows} sort={sort} onSortChange={setSort} />
      </div>

      <footer className="border-t border-line bg-surface px-3 py-1 text-[10px] text-fg-faint">
        Heat = part du TVL versée en fees par heure, dérivée de Δfees cumulées entre deux
        échantillons. $/min = taux instantané. Les deux se calculent à la minute — les APIs
        Meteora n&apos;exposent rien de plus fin que 30 min.
      </footer>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="uppercase tracking-wide text-fg-faint">{label}</span>
      {children}
    </label>
  );
}
