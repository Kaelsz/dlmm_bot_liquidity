/**
 * Vérifie la lecture ET la valorisation des positions d'un wallet.
 *   pnpm probe:positions <adresse> [<adresse>…]
 * Utilise RPC_URL si défini, sinon le RPC public (lent et limité).
 */
import { readPositions, isChainConfigured } from "../src/chain/positions";

async function main(): Promise<void> {
  if (!isChainConfigured()) {
    console.log("RPC_URL absent — repli sur le RPC public pour cette sonde.");
    process.env.RPC_URL = "https://api.mainnet-beta.solana.com";
  }
  for (const w of process.argv.slice(2)) {
    const t0 = Date.now();
    const ps = await readPositions(w);
    console.log(`\n${w} -> ${ps.length} position(s) [${Date.now() - t0} ms]`);
    let total = 0;
    for (const p of ps) {
      if (p.valued) total += p.valueUsd + p.unclaimedFeeUsd;
      console.log(
        `  ${p.poolName.padEnd(18)} ${p.valued ? "valeur $" + p.valueUsd.toFixed(2).padStart(10) : "  non valorisée"}` +
          `  fees dues $${p.unclaimedFeeUsd.toFixed(2).padStart(8)}` +
          `  ${p.inRange ? "dans la plage" : "HORS PLAGE  "}` +
          `  bins ${p.lowerBinId}..${p.upperBinId}`,
      );
    }
    if (ps.length) console.log(`  total exposé : $${total.toFixed(2)}`);
  }
}
void main();
