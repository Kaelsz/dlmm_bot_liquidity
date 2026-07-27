# ⚡ Meteora Fee Sniper

Bot autonome de **fee-farming opportuniste** sur Solana : il scanne en continu
les pools Meteora **DLMM** et **DAMM v2**, détecte celles qui génèrent un volume
de fees anormalement élevé par rapport à leur TVL (à la minute près, via les
deltas de fees cumulées), ouvre une position **SPOT serrée** autour du prix
actif pour capter un maximum de fees, puis sort selon des règles strictes
(fee decay, out-of-range, stop IL, take profit, timeout 10 min).

Ce n'est **pas** un bot directionnel : il gagne si
`fees captées > IL + coûts de tx + slippage`.

Voir [ARCHITECTURE.md](./ARCHITECTURE.md) pour le design détaillé et le schéma DB.

## Setup

```bash
pnpm install
cp .env.example .env     # puis éditer
```

Prérequis : Node ≥ 22, pnpm.

## Commandes

| Commande         | Description                                                        |
|------------------|--------------------------------------------------------------------|
| `pnpm scan`      | **Phase 1** — scanner + scoring, lecture seule : board console des pools qui chauffent avec décomposition du score, breakeven, raison de rejet. Aucune transaction. |
| `pnpm paper`     | **Phase 2** — paper trading (DRY_RUN) : cycle de vie complet simulé sur données réelles, PnL en SQLite. **Mode de validation obligatoire avant tout capital réel.** |
| `pnpm live`      | **Phases 3/4** — exécution réelle DLMM + DAMM v2. Exige `DRY_RUN=false` explicite + wallet configuré. Commencer avec des montants minimes. |
| `pnpm report`    | Rapport de performance agrégé (option : `pnpm report 24` = dernières 24 h). |
| `pnpm dashboard` | Dashboard web lecture seule sur http://localhost:8787.             |
| `pnpm test`      | Tests unitaires (scoring, exit rules, IL, volatilité, rate limiter). |
| `tsx src/index.ts close-all` | **Kill switch manuel** : ferme toutes les positions ouvertes. |

## Configuration

- **Secrets & mode** : `.env` (voir `.env.example`) — `DRY_RUN` (défaut `true`),
  RPC premium (`RPC_URL`), wallet (`WALLET_KEYPAIR_PATH` **ou**
  `WALLET_SECRET_KEY_B58`, jamais commité), webhooks Discord/Telegram, capital.
- **Stratégie** : tous les seuils sont dans [`src/config/config.ts`](./src/config/config.ts),
  commentés avec des défauts conservateurs — seuil d'entrée (heat ≥ 2 %/h
  instantané, ≥ $25/min), breakeven max 4 min, range ±3–10 bins adapté à la
  volatilité, sorties, limites portefeuille, kill switch.

## Gestion des risques

- **Filtres durs avant tout scoring** : blacklist Meteora, quote whitelist
  (SOL/USDC/USDT), freeze authority désactivée, holders min, âge min de pool.
- **RugCheck obligatoire, fail-closed** : si l'API RugCheck est indisponible,
  aucune entrée sur un token non vérifié (jamais fail-open). Cache TTL 5 min.
- **Limites portefeuille** : taille max/position, positions simultanées max,
  exposition max par token, buffer SOL réservé.
- **Kill switch global** : erreurs API/RPC répétées → fermeture propre de tout ;
  déclenchement manuel via `close-all`.

## Workflow recommandé

1. `pnpm scan` quelques heures : observer le board, vérifier que les pools
   détectées correspondent à de vraies opportunités.
2. `pnpm paper` sur 24–48 h : calibrer les seuils avec `pnpm report` et le
   dashboard (chaque évaluation, même rejetée, est persistée avec sa
   décomposition complète dans la table `opportunities`).
3. Seulement ensuite : `DRY_RUN=false`, RPC premium, montants minimes,
   `pnpm live`.

## Notes d'implémentation

- Les schémas des data APIs Meteora et de RugCheck ont été **vérifiés en live**
  et figés dans des types zod (`src/types/datapi.ts`) ; les particularités
  découvertes (syntaxe `sort_by`, OHLCV 5m minimum, absence de filtre TVL
  serveur) sont documentées dans ARCHITECTURE.md.
- Rate limits respectés par token-bucket : 20 req/s DLMM, 6 req/s DAMM v2
  (sous les limites documentées), backoff exponentiel sur 429/5xx.
- Redémarrage idempotent : les positions ouvertes sont rechargées depuis
  SQLite et re-monitorées ; en live, l'état on-chain est la source de vérité.
