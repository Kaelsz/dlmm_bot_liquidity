/**
 * Rapprochement entre l'état on-chain d'un wallet et notre suivi.
 *
 * C'est ici que le ROI prend corps : la chaîne dit ce qu'il y a maintenant,
 * la base dit ce qu'on a vu avant, et `src/data/positions.ts` fait la
 * différence. Une position absente du relevé courant a été fermée — c'est le
 * seul moyen de connaître les positions fermées, puisque leur compte on-chain
 * est supprimé et son loyer récupéré.
 */

import { readPositions } from "@/chain/positions";
import {
  applySnapshot,
  beginTracking,
  closeTracking,
  type PositionSnapshot,
  type PositionTracking,
} from "@/data/positions";
import { getDb } from "@/db";
import { logger } from "@/lib/logger";

export async function syncWallet(owner: string): Promise<number> {
  const db = getDb();
  const ts = Date.now();
  const chain = await readPositions(owner);
  const known = new Map(db.positionsFor(owner).map((p) => [p.positionAddress, p]));

  for (const c of chain) {
    const snap: PositionSnapshot = {
      ts,
      valueUsd: c.valueUsd,
      unclaimedFeeUsd: c.unclaimedFeeUsd,
      claimedFeeUsd: c.claimedFeeUsd,
      totalShares: c.totalShares,
    };
    const prev = known.get(c.positionAddress);
    const tracking: PositionTracking = prev
      ? applySnapshot(
          {
            firstSeenAt: prev.firstSeenAt,
            depositedUsd: prev.depositedUsd,
            withdrawnUsd: prev.withdrawnUsd,
            totalShares: prev.totalShares,
          },
          snap,
        )
      : beginTracking(snap);

    db.upsertPosition(
      {
        positionAddress: c.positionAddress,
        owner,
        poolAddress: c.poolAddress,
        poolName: c.poolName,
        depositedUsd: tracking.depositedUsd,
        withdrawnUsd: tracking.withdrawnUsd,
        totalShares: tracking.totalShares,
        valueUsd: c.valueUsd,
        claimedFeeUsd: c.claimedFeeUsd,
        unclaimedFeeUsd: c.unclaimedFeeUsd,
        lowerBinId: c.lowerBinId,
        upperBinId: c.upperBinId,
        inRange: c.inRange ? 1 : 0,
        valued: c.valued ? 1 : 0,
      },
      ts,
    );
  }

  // Fermetures : ce qui était suivi et n'est plus là. La valeur restante bascule
  // en retrait, sans quoi le ROI tomberait à -100 % au moment de la fermeture.
  const seen = new Set(chain.map((c) => c.positionAddress));
  for (const [addr, p] of known) {
    if (seen.has(addr) || p.closedAt !== null) continue;
    const t = closeTracking(
      {
        firstSeenAt: p.firstSeenAt,
        depositedUsd: p.depositedUsd,
        withdrawnUsd: p.withdrawnUsd,
        totalShares: p.totalShares,
      },
      {
        ts,
        valueUsd: p.valueUsd,
        unclaimedFeeUsd: p.unclaimedFeeUsd,
        claimedFeeUsd: p.claimedFeeUsd,
        totalShares: p.totalShares,
      },
    );
    db.upsertPosition(
      {
        positionAddress: p.positionAddress,
        owner,
        poolAddress: p.poolAddress,
        poolName: p.poolName,
        depositedUsd: t.depositedUsd,
        withdrawnUsd: t.withdrawnUsd,
        totalShares: 0,
        valueUsd: 0,
        claimedFeeUsd: p.claimedFeeUsd,
        unclaimedFeeUsd: 0,
        lowerBinId: p.lowerBinId,
        upperBinId: p.upperBinId,
        inRange: 0,
        valued: p.valued,
      },
      ts,
    );
  }
  db.closeMissingPositions(owner, [...seen], ts);
  db.markWalletSynced(owner, ts);
  logger.debug({ owner, open: chain.length }, "wallet synchronisé");
  return chain.length;
}
