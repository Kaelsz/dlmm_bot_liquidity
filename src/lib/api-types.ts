import { volumePerMinute } from "@/data/dexscreener";
import type { LeaderboardRow, RugcheckRow, SignalPoint } from "@/db";
import { isTrustedMint, verdictOf, type SafetyVerdict } from "@/data/rugcheck";
import type { OhlcvCandle, OhlcvTimeframe } from "@/types/meteora";

/**
 * The side of the pair that carries the risk — i.e. not SOL/USDC/USDT.
 *
 * Token order is not normalised by Meteora: `SOL-CTO` has SOL as token_x while
 * `TOM-SOL` has it as token_y. Assuming token_x is the interesting one sends
 * both the RugCheck lookup and the explorer links to SOL for half the pairs.
 */
export function riskyMintOf(r: { tokenXMint: string; tokenYMint: string }): string {
  return isTrustedMint(r.tokenXMint) && !isTrustedMint(r.tokenYMint) ? r.tokenYMint : r.tokenXMint;
}

/** Wire format for the table. Sparkline is decoded server-side so the client
 *  never parses JSON per row. */
export interface PoolRow {
  address: string;
  protocol: "dlmm" | "damm_v2";
  name: string;
  tokenXMint: string;
  tokenYMint: string;
  /** Non-quote side: what the safety badge and the explorer links point at. */
  riskyMint: string;
  binStep: number | null;
  baseFeePct: number;
  dynamicFeePct: number | null;
  createdAt: number;
  isBlacklisted: boolean;
  launchpad: string | null;
  /** Market cap du token risqué. 0 = inconnu. */
  marketCap: number;
  /** Attributes of the risky side — never of whichever token happens to be x. */
  holders: number;
  verified: boolean;
  freezeDisabled: boolean;
  ts: number;
  feeRateUsdMin: number;
  /**
   * Volume de la POOL par minute, dérivé comme les fees. Conservé pour
   * l'infobulle : c'est lui qui explique les fees encaissées, alors que le
   * volume du token décrit le marché.
   */
  volumeRateUsdMin: number;
  /**
   * Volume du TOKEN par minute, tous DEX confondus.
   *
   * `null` tant qu'aucune mesure n'existe — à ne pas confondre avec zéro, qui
   * signifierait un token sans échange. Moyenne sur 5 minutes et non taux
   * instantané : DexScreener n'expose pas de compteur cumulé (cf.
   * `src/data/dexscreener.ts`).
   */
  tokenVolumeUsdMin: number | null;
  /** Nombre de paires sommées, et somme partielle si le plafond est atteint. */
  tokenVolumePairs: number;
  tokenVolumeTruncated: boolean;
  /** Portée de la fenêtre ayant produit les taux, et nombre de sauts captés.
   *  L'UI s'en sert pour marquer une estimation encore peu étayée. */
  rateSpanMs: number;
  rateUpdates: number;
  heatPctHr: number;
  feeAccel: number;
  hotStreak: number;
  sampleCount: number;
  sparkline: number[];
  tvl: number;
  price: number;
  volume30m: number;
  fees30m: number;
  feeTvl30mPct: number;
  feeTvl24hPct: number;
  apyPct: number | null;
  // Safety, joined from the rugcheck cache. Always present so the UI never has
  // to distinguish "not loaded" from "no risk".
  safety: SafetyVerdict;
  rugcheckScore: number | null;
  lpLockedPct: number | null;
  rugcheckRisks: Array<{ name: string; level: string; description: string; score: number }>;
}

export interface PoolsResponse {
  rows: PoolRow[];
  generatedAt: number;
  counts: { pools: number; samples: number; metrics: number };
}

export type { SignalPoint };

/**
 * Payload of `/api/pool/[address]`.
 *
 * `timeframe` is null when the window is too long for the API's 100-candle
 * ceiling; `candles` is then empty and the panel says so rather than pretending
 * the pool never traded.
 */
export interface PoolDetailResponse {
  pool: PoolRow;
  candles: OhlcvCandle[];
  timeframe: OhlcvTimeframe | null;
  /** Derived fee-rate series from our own samples, oldest first. */
  signal: SignalPoint[];
  windowHours: number;
  generatedAt: number;
}

export function toPoolRow(r: LeaderboardRow, rug?: RugcheckRow): PoolRow {
  let sparkline: number[] = [];
  try {
    const parsed: unknown = JSON.parse(r.sparklineJson);
    if (Array.isArray(parsed)) sparkline = parsed.filter((n): n is number => typeof n === "number");
  } catch {
    // A malformed row should cost one sparkline, not the whole response.
  }

  let risks: PoolRow["rugcheckRisks"] = [];
  if (rug) {
    try {
      const parsed: unknown = JSON.parse(rug.risksJson);
      if (Array.isArray(parsed)) risks = parsed as PoolRow["rugcheckRisks"];
    } catch {
      // Same reasoning: degrade one field, not the response.
    }
  }
  const riskyIsX = riskyMintOf(r) === r.tokenXMint;
  const report = rug
    ? {
        mint: rug.mint,
        checkedAt: rug.checkedAt,
        score: rug.score,
        lpLockedPct: rug.lpLockedPct,
        risks,
        unavailable: rug.unavailable === 1,
      }
    : null;
  return {
    address: r.address,
    protocol: r.protocol as "dlmm" | "damm_v2",
    name: r.name,
    tokenXMint: r.tokenXMint,
    tokenYMint: r.tokenYMint,
    riskyMint: riskyMintOf(r),
    binStep: r.binStep,
    baseFeePct: r.baseFeePct,
    dynamicFeePct: r.dynamicFeePct,
    createdAt: r.createdAt,
    isBlacklisted: r.isBlacklisted === 1,
    launchpad: r.launchpad,
    marketCap: r.marketCap,
    holders: riskyIsX ? r.tokenXHolders : r.tokenYHolders,
    verified: (riskyIsX ? r.tokenXVerified : r.tokenYVerified) === 1,
    freezeDisabled: (riskyIsX ? r.tokenXFreezeDisabled : r.tokenYFreezeDisabled) === 1,
    ts: r.ts,
    feeRateUsdMin: r.feeRateUsdMin,
    volumeRateUsdMin: r.volumeRateUsdMin,
    tokenVolumeUsdMin:
      r.tokenVolumeM5 === null || r.tokenVolumeM5 === undefined
        ? null
        : volumePerMinute({ volumeM5Usd: r.tokenVolumeM5 }),
    tokenVolumePairs: r.tokenPairs ?? 0,
    tokenVolumeTruncated: r.tokenVolumeTruncated === 1,
    rateSpanMs: r.rateSpanMs,
    rateUpdates: r.rateUpdates,
    heatPctHr: r.heatPctHr,
    feeAccel: r.feeAccel,
    hotStreak: r.hotStreak,
    sampleCount: r.sampleCount,
    sparkline,
    tvl: r.tvl,
    price: r.price,
    volume30m: r.volume30m,
    fees30m: r.fees30m,
    feeTvl30mPct: r.feeTvl30mPct,
    feeTvl24hPct: r.feeTvl24hPct,
    apyPct: r.apyPct,
    safety: verdictOf(report),
    rugcheckScore: report?.score ?? null,
    lpLockedPct: report?.lpLockedPct ?? null,
    rugcheckRisks: risks,
  };
}

/** Attaches cached RugCheck reports to a batch, keyed on the risky side. */
export function toPoolRows(rows: LeaderboardRow[], rug: Map<string, RugcheckRow>): PoolRow[] {
  return rows.map((r) => toPoolRow(r, rug.get(riskyMintOf(r))));
}

/** Mints to look up for a batch — the deduplicated risky sides. */
export function riskyMintsOf(rows: LeaderboardRow[]): string[] {
  return [...new Set(rows.map(riskyMintOf))];
}
