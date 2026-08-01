"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PoolRow, PoolsResponse } from "@/lib/api-types";

/**
 * Fetches a board and keeps it current from the collector's SSE stream.
 *
 * The query is held in a ref rather than a dependency of the effect so that
 * changing a filter does not tear down and re-open the EventSource — the
 * stream is about *when* to refetch, never about *what*.
 */
export function useLiveRows(
  endpoint: string,
  buildQuery: () => URLSearchParams,
  initial: PoolsResponse,
) {
  const [rows, setRows] = useState<PoolRow[]>(initial.rows);
  const [counts, setCounts] = useState(initial.counts);
  const [lastUpdate, setLastUpdate] = useState(initial.generatedAt);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queryRef = useRef(buildQuery);
  queryRef.current = buildQuery;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${endpoint}?${queryRef.current().toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as PoolsResponse;
      setRows(data.rows);
      setCounts(data.counts);
      setLastUpdate(data.generatedAt);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "erreur réseau");
    }
  }, [endpoint]);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.addEventListener("hello", () => setLive(true));
    es.addEventListener("update", () => void refresh());
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [refresh]);

  // Wall-clock tick for relative timestamps. Starts null so the server and the
  // client render the same thing before hydration.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  return { rows, counts, lastUpdate, live, error, now, refresh };
}
