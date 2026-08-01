"use client";

import dynamic from "next/dynamic";

/**
 * Recharts is ~125 kB — more than the entire rest of the client bundle — and
 * the panel it serves is only mounted once a row is clicked. Loading it eagerly
 * would double the cost of the first paint of a table that must feel instant.
 *
 * `ssr: false` because the panel is never part of the server-rendered page: it
 * has no existence until a click, and Recharts measures the DOM to lay itself
 * out anyway.
 */
export const PoolDetail = dynamic(
  () => import("@/components/PoolDetail").then((m) => m.PoolDetail),
  {
    ssr: false,
    loading: () => (
      <aside className="fixed right-0 top-0 z-50 flex h-dvh w-full max-w-[620px] flex-col items-center justify-center border-l border-line-strong bg-surface text-fg-faint shadow-2xl">
        chargement…
      </aside>
    ),
  },
);
