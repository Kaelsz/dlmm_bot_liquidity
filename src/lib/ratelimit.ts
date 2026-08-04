/**
 * Limite de débit par client, en mémoire.
 *
 * Le site est public et `/api/positions` déclenche une lecture on-chain à
 * chaque appel. Sans ce garde-fou, n'importe qui peut vider le quota RPC en
 * bouclant sur l'endpoint — le coût n'est pas supporté par le visiteur mais
 * par le propriétaire du serveur.
 *
 * En mémoire volontairement : une seule instance, et un redémarrage qui
 * remet les compteurs à zéro est sans conséquence ici. Une table SQLite
 * coûterait une écriture par requête pour une protection identique.
 */

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

/** Purge périodique pour que la table ne grossisse pas indéfiniment. */
function sweep(now: number, windowMs: number): void {
  if (buckets.size < 5_000) return;
  for (const [k, b] of buckets) {
    if (b.hits.length === 0 || now - b.hits[b.hits.length - 1]! > windowMs) buckets.delete(k);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  /** Secondes avant que la prochaine requête passe. */
  retryAfterSec: number;
}

export function rateLimit(key: string, max: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now, windowMs);

  const b = buckets.get(key) ?? { hits: [] };
  b.hits = b.hits.filter((t) => now - t < windowMs);

  if (b.hits.length >= max) {
    buckets.set(key, b);
    const oldest = b.hits[0]!;
    return { allowed: false, retryAfterSec: Math.ceil((windowMs - (now - oldest)) / 1000) };
  }

  b.hits.push(now);
  buckets.set(key, b);
  return { allowed: true, retryAfterSec: 0 };
}

/**
 * Identifie l'appelant derrière le reverse proxy.
 *
 * Caddy renseigne `X-Forwarded-For`. On prend la première entrée, qui est le
 * client d'origine. Sans en-tête, tout le monde partage le même seau — plus
 * strict, mais jamais plus permissif, ce qui est le bon sens de l'erreur.
 */
export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "inconnu";
}
