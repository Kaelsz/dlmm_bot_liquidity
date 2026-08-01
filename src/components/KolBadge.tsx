"use client";

import type { PoolRow } from "@/lib/api-types";

/**
 * How many labelled traders hold this token, and who.
 *
 * Placed with the momentum columns rather than the safety ones, deliberately.
 * A well-known wallet appearing in a memecoin is an attention signal: paid
 * promotion is routine on Solana, and a KOL entry is frequently the moment
 * distribution starts rather than a vote of confidence. The tooltip names them
 * so the number is a starting point for a look, not a verdict.
 *
 * A dash means "scanned, none found". An empty cell means "not scanned yet" —
 * the two must not look the same, or an unscanned launch reads as clean.
 */
export function KolBadge({ row }: { row: PoolRow }) {
  if (row.kolScannedAt === null) {
    return (
      <span title="pas encore analysé" className="block text-center text-fg-faint opacity-25">
        ·
      </span>
    );
  }
  if (row.kolCount === 0) {
    return (
      <span title="aucun trader connu parmi les détenteurs" className="block text-center text-fg-faint">
        —
      </span>
    );
  }

  const names = row.kolHolders.slice(0, 12).map((h) => (h.twitter ? `${h.name} (@${h.twitter})` : h.name));
  const extra = row.kolHolders.length - names.length;
  const tooltip = [
    `${row.kolCount} trader${row.kolCount > 1 ? "s" : ""} connu${row.kolCount > 1 ? "s" : ""} parmi les détenteurs :`,
    ...names.map((n) => `• ${n}`),
    extra > 0 ? `…et ${extra} de plus` : null,
    "",
    "Signal d'attention, pas de sécurité : la promotion payée est courante,",
    "et l'entrée d'un KOL marque souvent le début de la distribution.",
  ]
    .filter((l) => l !== null)
    .join("\n");

  // Three tiers only: one is noise, a handful is worth a look, many is a crowd.
  const cls =
    row.kolCount >= 5
      ? "bg-[#3d2a10] text-[#ffb020]"
      : row.kolCount >= 2
        ? "bg-[#14304a] text-[#4a9eff]"
        : "bg-line text-fg-dim";

  return (
    <span
      title={tooltip}
      className={`tnum inline-flex h-[16px] min-w-[18px] cursor-help items-center justify-center rounded-[2px] px-1 text-[10px] font-bold leading-none ${cls}`}
    >
      {row.kolCount}
    </span>
  );
}

/** Named list for the wider layout of the new-pools view. */
export function KolNames({ row }: { row: PoolRow }) {
  if (row.kolScannedAt === null || row.kolCount === 0) return <KolBadge row={row} />;
  const first = row.kolHolders[0];
  if (!first) return <KolBadge row={row} />;
  return (
    <div className="flex items-center gap-1 overflow-hidden">
      <KolBadge row={row} />
      <span className="truncate text-[10px] text-fg-dim" title={first.name}>
        {first.name}
        {row.kolCount > 1 ? ` +${row.kolCount - 1}` : ""}
      </span>
    </div>
  );
}
