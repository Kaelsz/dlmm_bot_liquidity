import { NextResponse } from "next/server";
import { buildZapOut } from "@/chain/zapout";
import { isChainConfigured } from "@/chain/positions";
import { config } from "@/config";
import { logger } from "@/lib/logger";
import { clientKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const looksLikeAddress = (s: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

/**
 * Prépare un Zap Out : construit et simule, ne signe pas.
 *
 * La signature a lieu dans le portefeuille de l'utilisateur. Le serveur ne
 * détient aucune clé et ne peut rien envoyer — il rend des transactions non
 * signées, inutilisables sans l'accord explicite du propriétaire.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!isChainConfigured()) {
    return NextResponse.json({ error: "RPC_URL n'est pas configuré côté serveur." }, { status: 503 });
  }

  // Construire une transaction coûte plusieurs appels RPC et le site est
  // public : sans limite, l'endpoint deviendrait un moyen de vider le quota.
  const rl = rateLimit(`zapout:${clientKey(req)}`, 6, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "trop de requêtes, réessaie dans un instant" },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } },
    );
  }

  let body: { owner?: string; positionAddress?: string; slippageBps?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "corps de requête invalide" }, { status: 400 });
  }

  const owner = body.owner?.trim() ?? "";
  const positionAddress = body.positionAddress?.trim() ?? "";
  if (!looksLikeAddress(owner) || !looksLikeAddress(positionAddress)) {
    return NextResponse.json({ error: "adresse invalide" }, { status: 400 });
  }
  // Bornes de slippage : 0,1 % à 10 %. Au-delà, l'utilisateur signerait un
  // plancher qui ne le protège plus de rien.
  const slippageBps = Math.min(Math.max(Math.round(body.slippageBps ?? 100), 10), 1_000);

  try {
    const plan = await buildZapOut({ owner, positionAddress, slippageBps });
    return NextResponse.json(plan, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "échec de la construction";
    logger.warn({ owner, positionAddress, err }, "zap out: construction échouée");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
