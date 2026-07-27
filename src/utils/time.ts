export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const nowMs = (): number => Date.now();

export const minutes = (ms: number): number => ms / 60_000;

export function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return "n/a";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(2)}`;
}

export function fmtPct(v: number, digits = 2): string {
  return Number.isFinite(v) ? `${v.toFixed(digits)}%` : "n/a";
}
