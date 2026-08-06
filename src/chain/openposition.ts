/**
 * Construction d'une ouverture de position DLMM.
 *
 * CE MODULE NE SIGNE RIEN ET N'ENVOIE RIEN, comme `zapout.ts`. Il rend une
 * transaction non signée, sérialisée. Aucune clé privée n'existe côté serveur.
 *
 * LA SUBTILITÉ PROPRE À L'OUVERTURE : `initializePosition` crée un compte neuf,
 * et un compte neuf doit être signé par sa propre paire de clés. La transaction
 * réclame donc DEUX signatures — celle du portefeuille et celle du compte de
 * position. Cette seconde paire est générée **dans le navigateur** ; le serveur
 * n'en reçoit que la clé publique et l'inscrit dans l'instruction. Il ne peut
 * donc pas fabriquer une transaction exécutable tout seul, ce qui préserve la
 * règle du projet.
 *
 * Le compte de position ne détient rien : la propriété tient au champ `owner`
 * de l'instruction, qui est l'adresse de l'utilisateur.
 *
 * Une seule transaction suffit pour 70 bins. `initializePositionAndAddLiquidityByStrategy`
 * encode la stratégie (bin min, bin max, type) au lieu des montants bin par bin,
 * donc sa taille ne dépend pas du nombre de bins — contrairement au chemin
 * `ByWeight`, seul concerné par le plafond de 26 bins par transaction.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { config } from "@/config";
import { apiFor } from "@/data/client";
import { logger } from "@/lib/logger";
import { strategyById, type StrategyPlan } from "@/strategies";

const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** Une position qui n'occupe aucun bin ne veut rien dire. */
const MIN_LAMPORTS = 1_000_000; // 0,001 SOL

export interface OpenPositionPlan {
  /** Transaction non signée, en base64. */
  transaction: string;
  /** Clé publique du compte de position, telle que fournie par le navigateur. */
  positionAddress: string;
  poolAddress: string;
  poolName: string;
  strategyId: string;
  strategyLabel: string;
  /** Bins occupés, et où se trouve le prix parmi eux. */
  minBinId: number;
  maxBinId: number;
  activeBinId: number;
  binCount: number;
  /** Bornes de la plage, en prix de X exprimé en Y — même convention qu'ailleurs. */
  lowerPrice: number;
  upperPrice: number;
  currentPrice: number;
  /** Ce qui est engagé, en SOL. */
  amountSol: number;
  /** Loyer des comptes créés, non récupérable tant que la position est ouverte. */
  rentSol: number;
  warnings: string[];
}

/**
 * Construit et simule l'ouverture.
 *
 * Rien n'est déduit de la base : la pool est relue sur la chaîne, parce qu'une
 * position se prend au prix courant et que notre collecteur a jusqu'à une
 * minute de retard.
 */
export async function buildOpenPosition(opts: {
  owner: string;
  poolAddress: string;
  /** Clé publique du compte de position, générée par le navigateur. */
  positionPubKey: string;
  amountLamports: number;
  strategyId: string;
  /** Dérive tolérée du bin actif entre la construction et l'exécution. */
  maxBinDrift: number;
}): Promise<OpenPositionPlan> {
  if (!config.chain.rpcUrl) throw new Error("RPC_URL n'est pas configuré");

  const strategy = strategyById(opts.strategyId);
  if (!strategy) throw new Error(`stratégie inconnue : ${opts.strategyId}`);
  if (!Number.isInteger(opts.amountLamports) || opts.amountLamports < MIN_LAMPORTS) {
    throw new Error("montant trop faible : 0,001 SOL minimum");
  }

  const conn = new Connection(config.chain.rpcUrl, "confirmed");
  const owner = new PublicKey(opts.owner);
  const positionPubKey = new PublicKey(opts.positionPubKey);
  const pool = new PublicKey(opts.poolAddress);

  const { default: DLMM, getPriceOfBinByBinId } = await import("@meteora-ag/dlmm");
  const dlmm = await DLMM.create(conn, pool);

  const mintX = dlmm.tokenX.publicKey.toBase58();
  const mintY = dlmm.tokenY.publicKey.toBase58();
  const solIsX = mintX === WSOL_MINT;
  if (!solIsX && mintY !== WSOL_MINT) {
    throw new Error("cette pool ne comporte pas de SOL : la stratégie ne s'y applique pas");
  }

  const activeBin = await dlmm.getActiveBin();
  const activeBinId = activeBin.binId;
  const plan: StrategyPlan = strategy.plan({ activeBinId, solIsX });

  // Le montant part du côté que la stratégie a choisi ; l'autre reçoit zéro.
  // C'est ce couple (montant d'un seul côté, plage d'un seul côté du bin actif)
  // qui définit une position à sens unique.
  const amount = new BN(opts.amountLamports);
  const zero = new BN(0);
  const totalXAmount = plan.depositSide === "x" ? amount : zero;
  const totalYAmount = plan.depositSide === "y" ? amount : zero;

  const warnings: string[] = [];

  // Coût des comptes à créer. Il n'est pas perdu — il revient à la fermeture —
  // mais il est immobilisé, et il doit être affiché avant signature.
  let rentSol = 0;
  try {
    const quote = await dlmm.quoteCreatePosition({
      strategy: {
        minBinId: plan.minBinId,
        maxBinId: plan.maxBinId,
        strategyType: plan.strategyType,
      },
    });
    // ATTENTION AUX UNITÉS : `quoteCreatePosition` rend des SOL, pas des
    // lamports — vérifié en direct, `positionCost` vaut 0,0574 pour un compte
    // de position standard. Les diviser par 1e9 affichait « 0,00000 SOL », ce
    // qui aurait laissé croire qu'ouvrir ne coûte rien.
    rentSol =
      quote.positionCost +
      quote.positionReallocCost +
      quote.bitmapExtensionCost +
      quote.binArrayCost;
    if (quote.binArrayCost > 0) {
      warnings.push(
        `${quote.binArraysCount} bin array(s) à créer, ${quote.binArrayCost.toFixed(4)} SOL : personne n'a encore fourni de liquidité sur cette plage.`,
      );
    }
    // Le SDK annonce lui-même le nombre de transactions nécessaires. S'il en
    // annonce plus d'une, l'hypothèse « 70 bins tiennent en une transaction »
    // est fausse pour cette pool, et l'interface ne doit pas prétendre le
    // contraire.
    if (quote.transactionCount > 1) {
      warnings.push(
        `Cette plage demande ${quote.transactionCount} transactions selon le SDK, alors qu'une seule est construite. Vérifie le résultat après signature.`,
      );
    }
  } catch (err) {
    // Le devis est un confort, pas une condition : son échec ne doit pas
    // empêcher l'ouverture, mais l'utilisateur doit savoir qu'il signe sans.
    logger.debug({ err }, "devis de création indisponible");
    warnings.push("Le coût des comptes n'a pas pu être estimé.");
  }

  const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey,
    totalXAmount,
    totalYAmount,
    strategy: {
      minBinId: plan.minBinId,
      maxBinId: plan.maxBinId,
      strategyType: plan.strategyType,
      singleSidedX: plan.singleSidedX,
    },
    user: owner,
    // LE SLIPPAGE SE COMPTE EN BINS, PAS EN POURCENTS. Le SDK convertit ce
    // pourcentage par `ceil(slippage / (binStep / 100))` : sur une pool à bin
    // step 100, demander 1 % ne tolère qu'UN SEUL bin de mouvement, et
    // l'ouverture échoue sur `ExceededBinSlippageTolerance` dès que le prix
    // bouge — constaté en direct sur STONK-SOL. On fait donc le chemin inverse :
    // on part du nombre de bins acceptable et on en déduit le pourcentage, ce
    // qui donne la même tolérance réelle quelle que soit la pool.
    slippage: (opts.maxBinDrift * dlmm.lbPair.binStep) / 100,
  });

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;

  // Simulation sans vérification de signature : la transaction n'est signée par
  // personne à ce stade, c'est tout l'objet du module. Ce qu'on vérifie ici,
  // c'est que le programme accepte la position — solde insuffisant, plage
  // invalide, pool en pause remonteraient ici plutôt que devant l'utilisateur.
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    logger.warn(
      { err: sim.value.err, logs: sim.value.logs?.slice(-6) },
      "simulation de l'ouverture échouée",
    );
    throw new Error(explainSimulationError(sim.value.err, opts.maxBinDrift));
  }

  const decShift = 10 ** (dlmm.tokenX.mint.decimals - dlmm.tokenY.mint.decimals);
  const priceOfBin = (binId: number): number => {
    const p = Number(getPriceOfBinByBinId(binId, dlmm.lbPair.binStep)) * decShift;
    return Number.isFinite(p) ? p : 0;
  };

  warnings.push(
    plan.depositSide === "y"
      ? "La plage est SOUS le prix actuel : la position n'encaisse des fees que si le prix redescend."
      : "La plage est AU-DESSUS du prix actuel : la position n'encaisse des fees que si le prix monte.",
  );

  return {
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    positionAddress: opts.positionPubKey,
    poolAddress: opts.poolAddress,
    poolName: (await apiFor("dlmm").getPool(opts.poolAddress))?.name ?? `${opts.poolAddress.slice(0, 6)}…`,
    strategyId: strategy.id,
    strategyLabel: strategy.label,
    minBinId: plan.minBinId,
    maxBinId: plan.maxBinId,
    activeBinId,
    binCount: plan.binCount,
    lowerPrice: priceOfBin(plan.minBinId),
    upperPrice: priceOfBin(plan.maxBinId),
    currentPrice: priceOfBin(activeBinId),
    amountSol: opts.amountLamports / 1e9,
    rentSol,
    warnings,
  };
}

/** Code d'erreur Anchor porté par une erreur d'instruction, s'il y en a un. */
function anchorCode(err: unknown): number | null {
  const ix = (err as { InstructionError?: [number, { Custom?: number }] })?.InstructionError;
  return typeof ix?.[1]?.Custom === "number" ? ix[1].Custom : null;
}

/**
 * Traduit les échecs qu'un utilisateur peut réellement corriger.
 *
 * Un `{"InstructionError":[5,{"Custom":6004}]}` brut n'apprend rien à personne ;
 * or ces deux cas-là sont fréquents et ont chacun une action évidente.
 */
function explainSimulationError(err: unknown, maxBinDrift: number): string {
  switch (anchorCode(err)) {
    case 6004:
      return `le prix a bougé de plus de ${maxBinDrift} bins pendant la préparation : réessaie, ou attends que la pool se calme`;
    case 6007:
      return "liquidité nulle : le montant est trop faible pour être réparti sur 70 bins de cette pool";
    default:
      return `la simulation échoue : ${JSON.stringify(err)}`;
  }
}
