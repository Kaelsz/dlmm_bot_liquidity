/**
 * Construit et simule un Zap Out sur une position réelle.
 * Ne signe rien, n'envoie rien.
 *   pnpm exec tsx scripts/probe-zapout.ts <wallet> [positionAddress]
 */
import { buildZapOut } from "../src/chain/zapout";
import { readPositions } from "../src/chain/positions";

async function main(): Promise<void> {
  const owner = process.argv[2]!;
  let target = process.argv[3];
  if (!target) {
    const ps = await readPositions(owner);
    console.log(`${ps.length} position(s) ouvertes`);
    target = ps[0]?.positionAddress;
    if (!target) return;
  }
  const plan = await buildZapOut({ owner, positionAddress: target, slippageBps: 100 });
  console.log(`\nposition ${plan.positionAddress.slice(0, 10)}… dans ${plan.poolAddress.slice(0, 10)}…`);
  console.log(`  vend    ${plan.inputMint.slice(0, 10)}…`);
  console.log(`  reçoit  ${plan.outputMint.slice(0, 10)}…`);
  console.log(`  attendu ${plan.expectedOut}  (plancher ${plan.minOut})`);
  console.log(`  impact prix ${plan.priceImpactPct.toFixed(3)} %`);
  console.log(`  fees récupérées X=${plan.claimedFees.x} Y=${plan.claimedFees.y}`);
  console.log(`  ${plan.transactions.length} transaction(s), tailles: ${plan.transactions.map((t) => Buffer.from(t, "base64").length).join(", ")} octets`);
  for (const w of plan.warnings) console.log(`  ⚠ ${w}`);
}
void main();
