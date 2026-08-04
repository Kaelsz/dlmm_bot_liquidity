import { NextResponse } from "next/server";
import { isChainConfigured } from "@/chain/positions";
import { syncWallet } from "@/chain/sync";
import { computeRoi } from "@/data/positions";
import { getDb } from "@/db";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Une adresse Solana en base58 fait 32 à 44 caractères. */
const looksLikeAddress = (s: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

export async function GET(req: Request): Promise<NextResponse> {
  const owner = new URL(req.url).searchParams.get("owner")?.trim() ?? "";

  if (!isChainConfigured()) {
    return NextResponse.json(
      { configured: false, positions: [], error: "RPC_URL n'est pas configuré côté serveur." },
      { headers: { "cache-control": "no-store" } },
    );
  }
  if (!looksLikeAddress(owner)) {
    return NextResponse.json({ configured: true, positions: [], error: "adresse invalide" }, { status: 400 });
  }

  const db = getDb();
  db.trackWallet(owner);
  try {
    await syncWallet(owner);
  } catch (err) {
    // La lecture de chaîne peut échouer (RPC saturé) sans que le suivi déjà
    // enregistré soit perdu : on sert le dernier état connu plutôt que rien.
    logger.warn({ owner, err }, "synchronisation du wallet échouée");
  }

  const rows = db.positionsFor(owner);
  const positions = rows.map((p) => {
    const roi = computeRoi(
      {
        firstSeenAt: p.firstSeenAt,
        depositedUsd: p.depositedUsd,
        withdrawnUsd: p.withdrawnUsd,
        totalShares: p.totalShares,
      },
      {
        ts: p.lastSeenAt,
        valueUsd: p.valueUsd,
        unclaimedFeeUsd: p.unclaimedFeeUsd,
        claimedFeeUsd: p.claimedFeeUsd,
        totalShares: p.totalShares,
      },
    );
    return {
      ...p,
      inRange: p.inRange === 1,
      valued: p.valued === 1,
      closed: p.closedAt !== null,
      roi,
    };
  });

  return NextResponse.json(
    { configured: true, owner, positions, generatedAt: Date.now() },
    { headers: { "cache-control": "no-store" } },
  );
}
