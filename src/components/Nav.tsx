"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { fmtInt, fmtSince } from "@/lib/format";

const TABS = [
  { href: "/", label: "Marché" },
  { href: "/positions", label: "Positions" },
] as const;

/** Shared header: identity, view switcher, and live status on the right. */
export function Nav({
  counts,
  lastUpdate,
  live,
  now,
}: {
  // Optionnels : la vue Positions n'a ni compteur de collecte ni flux SSE,
  // et afficher « hors ligne » y serait un faux signal d'alerte.
  counts?: { pools: number; samples: number; metrics: number } | null;
  lastUpdate?: number | null;
  live?: boolean;
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
              // Cible tactile de 40 px sur téléphone : à 18 px de haut, changer
              // d'onglet au pouce ratait une fois sur deux. Les classes md:
              // remettent exactement les dimensions d'origine sur desktop.
              // md:inline restaure le display d'origine d'un <a> : en flex, la
              // hauteur viendrait du contenu et non de la ligne, ce qui
              // décalerait l'en-tête desktop de quelques pixels.
              className={`flex min-h-[40px] items-center rounded-[3px] px-3 text-[12px] uppercase tracking-wide transition-colors md:inline md:min-h-0 md:px-2 md:py-0.5 md:text-[11px] ${
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

      {counts && lastUpdate ? (
        <div className="ml-auto hidden items-center gap-4 text-[11px] text-fg-faint sm:flex">
          <span title="pools suivies · mesures stockées">
            <span className="tnum text-fg-dim">{fmtInt(counts.metrics)}</span> pools ·{" "}
            <span className="tnum text-fg-dim">{fmtInt(counts.samples)}</span> mesures
          </span>
          <span className="tnum">{fmtSince(lastUpdate, now ?? lastUpdate)}</span>
          <span
            className="flex items-center gap-1.5"
            title={live ? "flux live actif" : "flux interrompu"}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${live ? "bg-up" : "bg-down"}`}
            />
            {live ? "live" : "hors ligne"}
          </span>
        </div>
      ) : null}
    </header>
  );
}
