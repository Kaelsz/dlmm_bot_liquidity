/**
 * Construction d'un Zap Out : retirer toute la liquidité, réclamer les fees,
 * fermer la position, puis ressortir en un seul token.
 *
 * CE MODULE NE SIGNE RIEN ET N'ENVOIE RIEN. Il construit des transactions non
 * signées, les simule, et les rend sérialisées. La signature a lieu dans le
 * portefeuille de l'utilisateur, jamais ici — aucune clé privée n'existe côté
 * serveur, et c'est une contrainte non négociable de ce projet.
 *
 * Deux transactions séparées plutôt qu'une seule : le retrait fait déjà 766
 * octets et consomme ~485 k unités de calcul (mesuré sur une position réelle),
 * y ajouter un swap dépasserait la taille maximale d'une transaction.
 *
 * Conséquence à assumer, et que l'interface doit afficher : si le retrait
 * passe et que le swap échoue, la position est fermée et l'utilisateur détient
 * les DEUX tokens. Ce n'est pas une perte, c'est un zap incomplet.
 */

import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { config } from "@/config";
import { isTrustedMint } from "@/data/rugcheck";
import { logger } from "@/lib/logger";

export interface ZapOutPlan {
  /** Transactions non signées, en base64, à envoyer DANS CET ORDRE. */
  transactions: string[];
  positionAddress: string;
  poolAddress: string;
  inputMint: string;
  outputMint: string;
  /** Montant attendu en sortie, en unités lisibles. */
  expectedOut: number;
  /** Plancher garanti par le slippage. En dessous, la transaction échoue. */
  minOut: number;
  priceImpactPct: number;
  /** Fees non réclamées qui seront récupérées au passage. */
  claimedFees: { x: number; y: number };
  warnings: string[];
}

const toUi = (raw: BN | bigint | string, decimals: number): number =>
  Number(raw.toString()) / 10 ** decimals;

/**
 * Construit le plan complet.
 *
 * `owner` est vérifié : on ne construit une transaction que pour une position
 * que ce portefeuille possède réellement, sinon on refuse.
 */
export async function buildZapOut(opts: {
  owner: string;
  positionAddress: string;
  slippageBps: number;
}): Promise<ZapOutPlan> {
  if (!config.chain.rpcUrl) throw new Error("RPC_URL n'est pas configuré");
  const conn = new Connection(config.chain.rpcUrl, "confirmed");
  const owner = new PublicKey(opts.owner);

  const { default: DLMM } = await import("@meteora-ag/dlmm");
  const { Zap } = await import("@meteora-ag/zap-sdk");

  // Cette lecture VALIDE la propriété : une position qui n'appartient pas à
  // `owner` n'apparaît tout simplement pas ici.
  const byPair = await DLMM.getAllLbPairPositionsByUser(conn, owner);
  let poolAddress: string | undefined;
  let position: { publicKey: PublicKey; positionData: Record<string, never> } | undefined;
  for (const [pair, info] of byPair.entries()) {
    const hit = info.lbPairPositionsData.find(
      (p: { publicKey: PublicKey }) => p.publicKey.toBase58() === opts.positionAddress,
    );
    if (hit) {
      poolAddress = pair;
      position = hit as never;
      break;
    }
  }
  if (!poolAddress || !position) {
    throw new Error("position introuvable pour ce portefeuille");
  }
  const d = position.positionData as unknown as {
    lowerBinId: number;
    upperBinId: number;
    totalXAmount: string;
    totalYAmount: string;
    feeX: BN;
    feeY: BN;
  };

  const dlmm = await DLMM.create(conn, new PublicKey(poolAddress));
  const mintX = dlmm.tokenX.publicKey;
  const mintY = dlmm.tokenY.publicKey;
  const decX = dlmm.tokenX.mint.decimals;
  const decY = dlmm.tokenY.mint.decimals;

  // Le côté risqué est celui qu'on veut vendre ; la devise de cotation est ce
  // qu'on veut recevoir. Même règle que partout ailleurs dans le projet.
  const xIsQuote = isTrustedMint(mintX.toBase58()) && !isTrustedMint(mintY.toBase58());
  const swapForY = !xIsQuote; // on vend X contre Y quand X est le risqué

  const warnings: string[] = [];
  if (isTrustedMint(mintX.toBase58()) === isTrustedMint(mintY.toBase58())) {
    warnings.push(
      "Aucun des deux tokens n'est une devise de cotation connue : le sens du swap est un choix par défaut.",
    );
  }

  // 1. Retrait total + réclamation des fees + fermeture de la position.
  const removeTxs: Transaction[] = await dlmm.removeLiquidity({
    user: owner,
    position: position.publicKey,
    fromBinId: d.lowerBinId,
    toBinId: d.upperBinId,
    bps: new BN(10_000),
    shouldClaimAndClose: true,
    // Documenté par le SDK comme nécessaire avec le zap-sdk, pour que le
    // montant de SOL à zapper reste exact.
    skipUnwrapSOL: true,
  });

  // 2. Ce qu'on aura en main du côté risqué : la liquidité retirée plus les
  //    fees non réclamées de ce côté.
  const rawIn = swapForY
    ? new BN(d.totalXAmount.split(".")[0] ?? "0").add(new BN(d.feeX.toString()))
    : new BN(d.totalYAmount.split(".")[0] ?? "0").add(new BN(d.feeY.toString()));

  const inputMint = swapForY ? mintX : mintY;
  const outputMint = swapForY ? mintY : mintX;
  const decIn = swapForY ? decX : decY;
  const decOut = swapForY ? decY : decX;

  let expectedOut = 0;
  let minOut = 0;
  let priceImpactPct = 0;
  const txs = [...removeTxs];

  if (rawIn.isZero()) {
    warnings.push("Rien à vendre de ce côté : seul le retrait sera effectué.");
  } else {
    const binArrays = await dlmm.getBinArrayForSwap(swapForY);
    const quote = dlmm.swapQuote(rawIn, swapForY, new BN(opts.slippageBps), binArrays);
    expectedOut = toUi(quote.outAmount, decOut);
    minOut = toUi(quote.minOutAmount, decOut);
    priceImpactPct = Number(quote.priceImpact.toString());

    if (priceImpactPct > 5) {
      warnings.push(
        `Impact prix de ${priceImpactPct.toFixed(1)} % : la pool est mince, sortir par elle coûte cher.`,
      );
    }

    const zap = new Zap(conn);
    const swapTx = await zap.zapOutThroughDlmm({
      user: owner,
      lbPairAddress: new PublicKey(poolAddress),
      inputMint,
      outputMint,
      inputTokenProgram: dlmm.tokenX.owner,
      outputTokenProgram: dlmm.tokenY.owner,
      amountIn: rawIn,
      minimumSwapAmountOut: quote.minOutAmount,
      maxSwapAmount: rawIn,
      // Pourcentage du solde RÉEL au moment de l'exécution : c'est ce qui
      // permet de swapper le bon montant alors qu'on ignore, à la
      // construction, ce que le retrait aura précisément produit.
      percentageToZapOut: 100,
    });
    txs.push(swapTx);
  }

  // 3. Blockhash frais et payeur, sur toutes les transactions.
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  for (const tx of txs) {
    tx.recentBlockhash = blockhash;
    tx.feePayer = owner;
  }

  // 4. Simulation du retrait. C'est la transaction qui touche à la position ;
  //    si elle échoue, rien ne doit être proposé à la signature. Le swap, lui,
  //    ne peut pas être simulé utilement : les tokens ne sont pas encore dans
  //    le portefeuille tant que le retrait n'a pas été exécuté.
  const sim = await conn.simulateTransaction(txs[0]!);
  if (sim.value.err) {
    logger.warn({ err: sim.value.err, logs: sim.value.logs?.slice(-5) }, "simulation du retrait échouée");
    throw new Error(`la simulation du retrait échoue : ${JSON.stringify(sim.value.err)}`);
  }

  if (txs.length > 1) {
    warnings.push(
      "Deux transactions à signer. Si la seconde échoue, la position sera fermée et tu détiendras les deux tokens.",
    );
  }

  return {
    transactions: txs.map((t) => t.serialize({ requireAllSignatures: false }).toString("base64")),
    positionAddress: opts.positionAddress,
    poolAddress,
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    expectedOut,
    minOut,
    priceImpactPct,
    claimedFees: { x: toUi(d.feeX, decX), y: toUi(d.feeY, decY) },
    warnings,
  };
}
