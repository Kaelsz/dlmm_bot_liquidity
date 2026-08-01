"use client";

/**
 * Quick jumps to the tools you actually check before touching a pool.
 *
 * One letter each, kept dim until hover: at 28px rows a row of colourful icons
 * would compete with the heat column, which is the thing that should pull the
 * eye. Every link opens in a new tab with `noreferrer` so the destination
 * cannot reach back into this page.
 */
const TOOLS = [
  {
    id: "gmgn",
    label: "G",
    title: "GMGN — graphique, holders, flux de swaps",
    href: (mint: string) => `https://gmgn.ai/sol/token/${mint}`,
  },
  {
    id: "padre",
    label: "P",
    title: "Padre Terminal — trading",
    href: (mint: string) => `https://trade.padre.gg/trade/solana/${mint}`,
  },
  {
    id: "rugcheck",
    label: "R",
    title: "RugCheck — audit du token, LP verrouillée, autorités",
    href: (mint: string) => `https://rugcheck.xyz/tokens/${mint}`,
  },
  {
    id: "bubblemaps",
    label: "B",
    title: "Bubblemaps — liens entre wallets, concentration",
    href: (mint: string) => `https://app.bubblemaps.io/sol/token/${mint}`,
  },
  {
    id: "meteora",
    label: "M",
    title: "Meteora — ouvrir une position sur cette pool",
    href: (_mint: string, pool?: string) => `https://app.meteora.ag/dlmm/${pool ?? ""}`,
  },
] as const;

export function TokenLinks({
  mint,
  poolAddress,
  compact = true,
}: {
  mint: string;
  poolAddress?: string;
  compact?: boolean;
}) {
  return (
    <div className="flex items-center gap-px">
      {TOOLS.map((t) => (
        <a
          key={t.id}
          href={t.href(mint, poolAddress)}
          target="_blank"
          rel="noopener noreferrer"
          title={t.title}
          // Stop the click from also selecting the row once row selection lands.
          onClick={(e) => e.stopPropagation()}
          className={`flex items-center justify-center rounded-[2px] text-[9px] font-bold leading-none text-fg-faint transition-colors hover:bg-raised hover:text-accent ${
            compact ? "h-[16px] w-[14px]" : "h-[20px] w-[20px] text-[11px]"
          }`}
        >
          {t.label}
        </a>
      ))}
    </div>
  );
}

/** Same targets, spelled out — for the detail panel where there is room. */
export function TokenLinksVerbose({ mint, poolAddress }: { mint: string; poolAddress?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {TOOLS.map((t) => (
        <a
          key={t.id}
          href={t.href(mint, poolAddress)}
          target="_blank"
          rel="noopener noreferrer"
          title={t.title}
          className="rounded-[3px] border border-line bg-raised px-2 py-0.5 text-[10px] uppercase tracking-wide text-fg-dim transition-colors hover:border-accent hover:text-accent"
        >
          {t.id}
        </a>
      ))}
    </div>
  );
}
