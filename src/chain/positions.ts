/**
 * Lecture des positions DLMM d'un wallet, côté serveur uniquement.
 *
 * Meteora n'expose aucune API de positions par wallet (vérifié : `dlmm-api`
 * répond 404 partout, le datapi ne sert que des données de pools). Il faut donc
 * lire la chaîne.
 *
 * Ce module ne tourne QUE côté serveur, pour deux raisons : la clé RPC ne doit
 * jamais atteindre le navigateur, et le SDK Meteora pèse trop lourd pour un
 * bundle client. Le navigateur n'envoie qu'une adresse publique.
 *
 * Aucune signature n'est demandée : tout est en lecture. Aucune clé privée
 * n'est manipulée nulle part, ni ici ni ailleurs.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "@/config";
import { apiFor } from "@/data/client";
import { isTrustedMint } from "@/data/rugcheck";
import { logger } from "@/lib/logger";
import type { PoolView } from "@/types/meteora";

export interface ChainPosition {
  positionAddress: string;
  poolAddress: string;
  owner: string;
  /** Valeur des tokens détenus, hors fees. */
  valueUsd: number;
  unclaimedFeeUsd: number;
  claimedFeeUsd: number;
  /** Somme des parts de liquidité : détecte dépôts et retraits. */
  totalShares: number;
  lowerBinId: number;
  upperBinId: number;
  /**
   * Bin où se trouve le prix maintenant. C'est lui qui situe la position à
   * l'intérieur de sa plage, information que `inRange` seul écrase : au centre
   * ou à un bin de la sortie, le booléen dit la même chose.
   */
  activeBinId: number;
  /** Le prix courant est-il dans la plage ? Hors plage, la position ne gagne rien. */
  inRange: boolean;
  /**
   * Bornes et prix courant, en prix de X exprimé en Y — la même convention que
   * `currentPrice` du datapi. Calculés ici parce que la conversion dépend du bin
   * step et des décimales des deux tokens : la refaire dans le navigateur
   * dupliquerait une règle métier et exigerait d'y envoyer ces paramètres.
   *
   * `0` quand le calcul est impossible (bin step absent) : l'infobulle se tait
   * alors, mais la barre reste juste, puisqu'elle se dessine en bins.
   */
  lowerPrice: number;
  upperPrice: number;
  currentPrice: number;
  poolName: string;
  /**
   * La pool a-t-elle pu être valorisée ? Certaines positions portent sur des
   * pools absentes du datapi. Les masquer serait pire que les montrer sans
   * chiffre : dans un portefeuille, une ligne manquante se remarque moins
   * qu'une ligne incomplète, et induit davantage en erreur.
   */
  valued: boolean;
}

let connection: Connection | null = null;

/** `null` quand aucun RPC n'est configuré — l'appelant doit le dire à l'UI. */
function getConnection(): Connection | null {
  if (!config.chain.rpcUrl) return null;
  connection ??= new Connection(config.chain.rpcUrl, "confirmed");
  return connection;
}

export function isChainConfigured(): boolean {
  return Boolean(config.chain.rpcUrl);
}

const toNum = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Valorise un montant brut de token dans la devise de cotation de la pool.
 *
 * Les positions sont libellées en deux tokens dont on n'a pas le prix en
 * dollars. Mais la pool donne le prix de X en Y, et le côté Y est presque
 * toujours SOL, USDC ou USDT — d'où `isTrustedMint`, déjà utilisé pour savoir
 * quel côté porte le risque. On valorise donc en Y, puis on convertit Y en
 * dollars via le TVL et les réserves de la pool, que le collecteur stocke déjà.
 */
function quoteToUsd(pool: PoolView): number {
  const xIsQuote = isTrustedMint(pool.tokenX.address) && !isTrustedMint(pool.tokenY.address);
  const reserveQuote = xIsQuote ? pool.reserveXAmount : pool.reserveYAmount;
  const reserveRisky = xIsQuote ? pool.reserveYAmount : pool.reserveXAmount;
  const priceRiskyInQuote = xIsQuote ? 1 / (pool.currentPrice || 1) : pool.currentPrice;

  // TVL = réserve_quote * prixQuote + réserve_risky * prixRisky, et
  // prixRisky = prixQuote * priceRiskyInQuote. D'où une seule inconnue.
  const denom = reserveQuote + reserveRisky * priceRiskyInQuote;
  if (denom <= 0 || pool.tvl <= 0) return 0;
  return pool.tvl / denom;
}

/**
 * Toutes les positions DLMM ouvertes d'un wallet.
 *
 * Les pools concernées ne sont pas forcément dans notre base — on ne suit que
 * ~1 200 pools sur ~250 000. Celles qui manquent sont récupérées à la demande
 * via le client datapi existant.
 */
export async function readPositions(owner: string): Promise<ChainPosition[]> {
  const conn = getConnection();
  if (!conn) return [];

  let ownerKey: PublicKey;
  try {
    ownerKey = new PublicKey(owner);
  } catch {
    return [];
  }

  // Import différé : le SDK est lourd et son packaging fragile. Le charger au
  // démarrage faisait tomber l'application entière — collecteur compris — sur
  // une fonctionnalité qui n'est utilisée que sur une page.
  const { default: DLMM, getPriceOfBinByBinId } = await import("@meteora-ag/dlmm");
  const byPair = await DLMM.getAllLbPairPositionsByUser(conn, ownerKey);
  const out: ChainPosition[] = [];

  for (const [poolAddress, info] of byPair.entries()) {
    const activeBinId = info.lbPair.activeId;
    // Prix réel d'un bin = (1 + binStep/10000)^binId, ramené aux unités
    // affichées par les décimales des deux tokens — c'est exactement ce que
    // fait `fromPricePerLamport()` du SDK, mais l'instance DLMM n'est pas
    // construite ici : `getAllLbPairPositionsByUser` ne renvoie que des comptes.
    const binStep = info.lbPair.binStep;
    const decShift = 10 ** (info.tokenX.mint.decimals - info.tokenY.mint.decimals);
    const priceOfBin = (binId: number): number => {
      if (!binStep) return 0;
      const p = Number(getPriceOfBinByBinId(binId, binStep)) * decShift;
      return Number.isFinite(p) ? p : 0;
    };

    const pool = await apiFor("dlmm").getPool(poolAddress);
    if (!pool) {
      // Pool inconnue du datapi : on liste quand même les positions, sans
      // valeur, plutôt que de les faire disparaître du portefeuille.
      logger.warn({ poolAddress }, "pool de position introuvable côté datapi");
      for (const p of info.lbPairPositionsData) {
        const d = p.positionData;
        out.push({
          positionAddress: p.publicKey.toBase58(),
          poolAddress,
          owner,
          valueUsd: 0,
          unclaimedFeeUsd: 0,
          claimedFeeUsd: 0,
          totalShares: d.positionBinData.reduce(
            (s: number, b: { positionLiquidity: string }) => s + toNum(b.positionLiquidity),
            0,
          ),
          lowerBinId: d.lowerBinId,
          upperBinId: d.upperBinId,
          activeBinId,
          inRange: activeBinId >= d.lowerBinId && activeBinId <= d.upperBinId,
          lowerPrice: priceOfBin(d.lowerBinId),
          upperPrice: priceOfBin(d.upperBinId),
          currentPrice: priceOfBin(activeBinId),
          poolName: `${poolAddress.slice(0, 6)}…`,
          valued: false,
        });
      }
      continue;
    }
    const usdPerQuote = quoteToUsd(pool);
    const xIsQuote = isTrustedMint(pool.tokenX.address) && !isTrustedMint(pool.tokenY.address);
    const dx = pool.tokenX.decimals;
    const dy = pool.tokenY.decimals;
    // Prix de X exprimé en Y, tel que le donne la pool.
    const priceXinY = pool.currentPrice || 0;

    const inQuote = (rawX: unknown, rawY: unknown): number => {
      const x = toNum(rawX) / 10 ** dx;
      const y = toNum(rawY) / 10 ** dy;
      return xIsQuote ? x + (priceXinY > 0 ? y / priceXinY : 0) : y + x * priceXinY;
    };

    for (const p of info.lbPairPositionsData) {
      const d = p.positionData;
      const shares = d.positionBinData.reduce(
        (s: number, b: { positionLiquidity: string }) => s + toNum(b.positionLiquidity),
        0,
      );
      out.push({
        positionAddress: p.publicKey.toBase58(),
        poolAddress,
        owner,
        valueUsd: inQuote(d.totalXAmount, d.totalYAmount) * usdPerQuote,
        unclaimedFeeUsd: inQuote(d.feeX, d.feeY) * usdPerQuote,
        claimedFeeUsd:
          inQuote(d.totalClaimedFeeXAmount, d.totalClaimedFeeYAmount) * usdPerQuote,
        totalShares: shares,
        lowerBinId: d.lowerBinId,
        upperBinId: d.upperBinId,
        activeBinId,
        inRange: activeBinId >= d.lowerBinId && activeBinId <= d.upperBinId,
        lowerPrice: priceOfBin(d.lowerBinId),
        upperPrice: priceOfBin(d.upperBinId),
        // Prix du bin actif plutôt que celui du datapi : le curseur est posé sur
        // ce bin, l'étiquette doit désigner le même point. Les deux ne diffèrent
        // que d'un bin step, et le datapi a en plus quelques secondes de retard.
        currentPrice: priceOfBin(activeBinId),
        poolName: pool.name,
        valued: true,
      });
    }
  }
  return out;
}
