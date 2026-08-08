/**
 * Volume d'un token sur l'ensemble des DEX, via DexScreener.
 *
 * POURQUOI CETTE SOURCE. Le datapi Meteora ne connaît que ses propres pools.
 * Or un token vit ailleurs : mesuré sur CATE, Meteora ne portait que 46 % du
 * volume, le reste passant par PumpSwap. La colonne « volume » ne montrait donc
 * que la moitié de l'activité réelle.
 *
 * LA LIMITE À ASSUMER, et la raison pour laquelle ce chiffre n'a pas la même
 * nature que les fees dérivées : DexScreener n'expose **aucun compteur cumulé**
 * de volume, seulement des fenêtres glissantes (`m5`, `h1`, `h6`, `h24`).
 * Impossible donc de dériver Δ/Δt comme le fait `src/data/metrics.ts`. Le mieux
 * possible est `m5 / 5` — une moyenne sur les cinq dernières minutes. C'est plus
 * grossier que le signal fees/minute, et l'interface doit le dire plutôt que de
 * laisser croire à la même précision.
 *
 * Aucune source gratuite ne fait mieux : Birdeye exige une clé payante et
 * GeckoTerminal ne descend à la minute que par pool, pas par token.
 */

import { RateLimiter } from "@/lib/rateLimiter";
import { logger } from "@/lib/logger";

/** DexScreener plafonne sa réponse ; au-delà la somme est partielle. */
export const MAX_PAIRS = 30;

/** La fenêtre la plus fine qu'expose l'API, en minutes. */
export const WINDOW_MIN = 5;

export interface TokenVolume {
  mint: string;
  /** Volume USD de la fenêtre de 5 minutes, sommé sur les paires. */
  volumeM5Usd: number;
  /**
   * Les mêmes sommes sur des fenêtres plus larges.
   *
   * Elles ne servent pas au taux affiché mais au recoupement : GMGN et
   * DexScreener présentent des TOTAUX par fenêtre, là où la colonne montre un
   * taux par minute. Sans ces chiffres, un utilisateur qui compare « 17 M$ sur
   * GMGN » à « 3 502 $/min » conclut à un bug — vérifié, c'est la même donnée.
   */
  volumeH1Usd: number;
  volumeH24Usd: number;
  /** Nombre de paires prises en compte. */
  pairs: number;
  /**
   * Le plafond de 30 paires a-t-il été atteint ? Si oui la somme est un
   * minorant, et l'interface ne doit pas la présenter comme un total.
   */
  truncated: boolean;
  /** La mesure a échoué : la valeur ne veut rien dire et ne doit pas s'afficher. */
  unavailable: boolean;
  checkedAt: number;
}

interface DexPair {
  chainId?: string;
  dexId?: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
}

/**
 * Somme le volume des paires où le token est le **jeton de base**.
 *
 * Filtrer sur le côté base n'est pas un détail : interrogé sur un mint,
 * DexScreener renvoie aussi les paires où ce mint est la devise de cotation. On
 * n'interroge jamais que le côté risqué d'une pool — jamais SOL ni USDC — donc
 * en pratique il est toujours en base ; le filtre garantit qu'une exception ne
 * gonfle pas silencieusement le chiffre.
 */
export function sumTokenVolume(
  pairs: readonly DexPair[],
  mint: string,
  now = Date.now(),
): TokenVolume {
  const mine = pairs.filter((p) => p.baseToken?.address === mint);
  const sum = (pick: (v: NonNullable<DexPair["volume"]>) => number | undefined): number => {
    let total = 0;
    for (const p of mine) {
      const v = p.volume ? pick(p.volume) : undefined;
      if (typeof v === "number" && Number.isFinite(v) && v > 0) total += v;
    }
    return total;
  };
  return {
    mint,
    volumeM5Usd: sum((v) => v.m5),
    volumeH1Usd: sum((v) => v.h1),
    volumeH24Usd: sum((v) => v.h24),
    pairs: mine.length,
    // Le plafond porte sur la réponse entière, pas sur les seules paires
    // retenues : c'est bien `pairs.length` qu'il faut comparer.
    truncated: pairs.length >= MAX_PAIRS,
    unavailable: false,
    checkedAt: now,
  };
}

/** Volume moyen par minute, tel qu'affiché. */
export function volumePerMinute(v: Pick<TokenVolume, "volumeM5Usd">): number {
  return v.volumeM5Usd / WINDOW_MIN;
}

// DexScreener ne documente pas de quota pour cet endpoint et n'en renvoie aucun
// en-tête. Mesuré : 12 requêtes en 3,2 s sans refus. On se tient volontairement
// bas — la réponse porte `cache-control: max-age=30`, donc sonder plus vite
// qu'une fois par demi-minute ne rendrait de toute façon rien de neuf.
const limiter = new RateLimiter(3);

export async function fetchTokenVolume(mint: string): Promise<TokenVolume> {
  await limiter.acquire();
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      logger.debug({ mint, status: res.status }, "dexscreener : réponse non-OK");
      return unavailable(mint);
    }
    const body = (await res.json()) as { pairs?: DexPair[] | null };
    return sumTokenVolume(body.pairs ?? [], mint);
  } catch (err) {
    logger.debug({ mint, err }, "dexscreener : requête échouée");
    return unavailable(mint);
  }
}

/**
 * Échec enregistré plutôt que silencieux.
 *
 * Rendre `null` laissait le mint en tête de la file « jamais mesuré » à chaque
 * cycle : quelques tokens inconnus de DexScreener suffisaient à consommer tout
 * le budget et à affamer les autres.
 */
function unavailable(mint: string): TokenVolume {
  return {
    mint,
    volumeM5Usd: 0,
    volumeH1Usd: 0,
    volumeH24Usd: 0,
    pairs: 0,
    truncated: false,
    unavailable: true,
    checkedAt: Date.now(),
  };
}
