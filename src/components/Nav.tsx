"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { fmtInt, fmtSince } from "@/lib/format";

const TABS = [
  { href: "/", label: "Marché" },
  { href: "/nouvelles", label: "Nouvelles pools" },
] as const;

/** Shared header: identity, view switcher, and live status on the right. */
export function Nav({
  counts,
  lastUpdate,
  live,
  now,
}: {
  counts: { pools: number; samples: number; metrics: number };
  lastUpdate: number;
  live: boolean;
  now: number | null;
}) {
  const pathname = usePathname();

  return (
    <header className="flex items-center gap-4 border-b border-line-strong bg-surface px-3 py-2">
      <span className="text-[13px] font-semibold tracking-tight text-fg">
        METEORA <span className="text-accent">POOL RADAR</span>
      </span>

      <nav className="flex items-center gap-1">
        {TABS.map((t) => {
          const active = pathname === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`rounded-[3px] px-2 py-0.5 text-[11px] uppercase tracking-wide transition-colors ${
                active
                  ? "bg-raised text-accent"
                  : "text-fg-faint hover:bg-raised hover:text-fg-dim"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-4 text-[11px] text-fg-faint">
        <span title="pools suivies · mesures stockées">
          <span className="tnum text-fg-dim">{fmtInt(counts.metrics)}</span> pools ·{" "}
          <span className="tnum text-fg-dim">{fmtInt(counts.samples)}</span> mesures
        </span>
        <span className="tnum">{fmtSince(lastUpdate, now ?? lastUpdate)}</span>
        <span
          className="flex items-center gap-1.5"
          title={live ? "flux live actif" : "flux interrompu"}
        >
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${live ? "bg-up" : "bg-down"}`} />
          {live ? "live" : "hors ligne"}
        </span>
      </div>
    </header>
  );
}
