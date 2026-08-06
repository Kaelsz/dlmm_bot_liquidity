import { NextResponse } from "next/server";
import { isChainConfigured } from "@/chain/positions";
import { buildOpenPosition } from "@/chain/openposition";
import { logger } from "@/lib/logger";
import { clientKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const looksLikeAddress = (s: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

/** Plafond de sécurité, indépendant du solde : une faute de frappe coûte cher. */
const MAX_LAMPORTS = 100 * 1e9; // 100 SOL

/**
 * Prépare l'ouverture d'une position : construit et simule, ne signe pas.
 *
 * La transaction rendue est inexécutable telle quelle. Il lui manque deux
 * signatures — celle du portefeuille, et celle du compte de position dont seul
 * le navigateur détient la clé privée. Le serveur ne peut donc engager les
 * fonds de personne.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!isChainConfigured()) {
    return NextResponse.json({ error: "RPC_URL n'est pas configuré côté serveur." }, { status: 503 });
  }

  // Construire une position coûte plusieurs appels RPC dont une simulation ;
  // le site est public, donc sans limite l'endpoint viderait le quota.
  const rl = rateLimit(`open:${clientKey(req)}`, 6, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "trop de requêtes, réessaie dans un instant" },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } },
    );
  }

  let body: {
    owner?: string;
    poolAddress?: string;
    positionPubKey?: string;
    amountLamports?: number;
    strategyId?: string;
    maxBinDrift?: number;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "corps de requête invalide" }, { status: 400 });
  }

  const owner = body.owner?.trim() ?? "";
  const poolAddress = body.poolAddress?.trim() ?? "";
  const positionPubKey = body.positionPubKey?.trim() ?? "";
  if (
    !looksLikeAddress(owner) ||
    !looksLikeAddress(poolAddress) ||
    !looksLikeAddress(positionPubKey)
  ) {
    return NextResponse.json({ error: "adresse invalide" }, { status: 400 });
  }

  const amountLamports = Math.round(Number(body.amountLamports ?? 0));
  if (!Number.isFinite(amountLamports) || amountLamports <= 0 || amountLamports > MAX_LAMPORTS) {
    return NextResponse.json({ error: "montant hors bornes" }, { status: 400 });
  }
  // Tolérance exprimée en BINS : c'est l'unité dans laquelle le programme
  // raisonne. Un pourcentage donnerait une tolérance réelle très différente
  // selon le bin step de la pool (cf. `openposition.ts`).
  const maxBinDrift = Math.min(Math.max(Math.round(body.maxBinDrift ?? 5), 1), 30);

  try {
    const plan = await buildOpenPosition({
      owner,
      poolAddress,
      positionPubKey,
      amountLamports,
      strategyId: body.strategyId?.trim() || "spot70-sol",
      maxBinDrift,
    });
    return NextResponse.json(plan, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "échec de la construction";
    logger.warn({ owner, poolAddress, err }, "ouverture : construction échouée");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
