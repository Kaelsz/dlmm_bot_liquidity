/**
 * Vérifie la lecture des positions DLMM d'un wallet.
 *   pnpm probe:positions <adresse> [<adresse>…]
 * Utilise RPC_URL si défini, sinon le RPC public (lent et limité).
 */
import { Connection, PublicKey } from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";

const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const conn = new Connection(rpc, "confirmed");

async function main(): Promise<void> {
for (const w of process.argv.slice(2)) {
  const t0 = Date.now();
  try {
    const map = await DLMM.getAllLbPairPositionsByUser(conn, new PublicKey(w));
    const entries = [...map.entries()];
    console.log(`${w} -> ${entries.length} pool(s) [${Date.now() - t0} ms]`);
    for (const [pair, info] of entries.slice(0, 3)) {
      for (const p of info.lbPairPositionsData.slice(0, 2)) {
        const d = p.positionData;
        const shares = d.positionBinData.reduce((s, b) => s + Number(b.positionLiquidity), 0);
        console.log(`  ${p.publicKey.toBase58().slice(0, 8)}… pool ${pair.slice(0, 8)}…`);
        console.log(`    X=${d.totalXAmount} Y=${d.totalYAmount}`);
        console.log(`    fees dues X=${d.feeX} Y=${d.feeY}`);
        console.log(`    fees réclamées X=${d.totalClaimedFeeXAmount} Y=${d.totalClaimedFeeYAmount}`);
        console.log(`    bins ${d.lowerBinId}..${d.upperBinId} parts=${shares.toExponential(3)}`);
      }
    }
  } catch (e) {
    console.log(`${w} -> ECHEC ${String(e).slice(0, 200)}`);
  }
}
}

void main();
