/**
 * Vérifie la construction d'une ouverture de position, SANS RIEN SIGNER.
 *   RPC_URL=… pnpm probe:open <pool> <owner> [<montant SOL>]
 *
 * La transaction produite est jetée. Ce que la sonde contrôle : que le
 * programme accepte la position (simulation), qu'elle tient en une seule
 * transaction sous la taille maximale, et que les deux signatures attendues
 * sont bien celles du portefeuille et du compte de position.
 */
import { Keypair } from "@solana/web3.js";
import { buildOpenPosition } from "../src/chain/openposition";

const MAX_TX_BYTES = 1232;

async function main(): Promise<void> {
  const [pool, owner, amount = "0.1"] = process.argv.slice(2);
  if (!pool || !owner) {
    console.error("usage : pnpm probe:open <pool> <owner> [montant SOL]");
    process.exit(1);
  }

  // Le navigateur génère cette paire en conditions réelles ; ici on l'imite.
  const position = Keypair.generate();

  const plan = await buildOpenPosition({
    owner,
    poolAddress: pool,
    positionPubKey: position.publicKey.toBase58(),
    amountLamports: Math.round(Number(amount) * 1e9),
    strategyId: "spot70-sol",
    maxBinDrift: 5,
  });

  const raw = Buffer.from(plan.transaction, "base64");
  console.log(`\n${plan.poolName}  —  ${plan.strategyLabel}`);
  console.log(`  bins        ${plan.minBinId} → ${plan.maxBinId} (${plan.binCount}), actif ${plan.activeBinId}`);
  console.log(`  prix        ${plan.lowerPrice.toPrecision(6)} → ${plan.upperPrice.toPrecision(6)}, courant ${plan.currentPrice.toPrecision(6)}`);
  console.log(`  engagé      ${plan.amountSol} SOL, loyer ${plan.rentSol.toFixed(5)} SOL`);
  console.log(`  taille tx   ${raw.length} octets / ${MAX_TX_BYTES} ${raw.length <= MAX_TX_BYTES ? "OK" : "DÉPASSE"}`);
  for (const w of plan.warnings) console.log(`  ⚠ ${w}`);

  // Contrôle des signatures attendues : la transaction doit réclamer le
  // portefeuille ET le compte de position, et personne d'autre.
  const { Transaction } = await import("@solana/web3.js");
  const tx = Transaction.from(raw);
  const signers = tx.signatures.map((s) => s.publicKey.toBase58());
  console.log(`  signataires ${signers.join(", ")}`);
  console.log(`    portefeuille attendu : ${signers.includes(owner) ? "présent" : "ABSENT"}`);
  console.log(
    `    compte de position   : ${signers.includes(position.publicKey.toBase58()) ? "présent" : "ABSENT"}`,
  );

  // Et la signature du compte de position doit pouvoir être posée dès
  // maintenant, sans le portefeuille — c'est ce que fera le navigateur.
  tx.partialSign(position);
  const signed = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  console.log(`  après signature du compte de position : ${signed.length} octets`);
}

void main().catch((err) => {
  console.error("échec :", err instanceof Error ? err.message : err);
  process.exit(1);
});
