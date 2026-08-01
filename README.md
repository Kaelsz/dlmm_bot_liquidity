# ⚡ Meteora Pool Radar

Dashboard temps réel des pools **Meteora** (DLMM + DAMM v2) qui impriment le
plus de fees. Deux questions, deux vues : *qu'est-ce qui chauffe en ce moment
sur le marché*, et *quelles pools viennent d'être créées* — pour attraper un
lancement dans ses premières minutes.

Ce n'est pas un bot. Il n'ouvre aucune position et ne détient aucune clé. Il
regarde, il mesure, et il te dit où regarder.

## Ce qui le distingue

Les APIs Meteora n'exposent rien de plus fin qu'un bucket de **30 minutes** —
bien trop lent pour voir une pool s'emballer. Mais chaque ligne renvoyée
contient `cumulative_metrics.fees`, un compteur monotone. En l'échantillonnant
et en le dérivant, on obtient un **taux de fees à la minute** que ni l'UI
officielle ni DexScreener n'affichent :

```
fee_rate ($/min)  = Δ(fees cumulées) / Δt
heat     (%/h)    = fee_rate × 60 / TVL × 100
accélération      = dérivée seconde du taux
```

`heat` est comparable entre pools de toutes tailles : c'est la part du TVL
reversée en fees par heure.

## Démarrage

```bash
pnpm install
pnpm dev            # http://localhost:3000
```

Node ≥ 22, pnpm. Aucune clé API n'est nécessaire — les données Meteora sont
publiques.

| Commande         | Description                                              |
|------------------|----------------------------------------------------------|
| `pnpm dev`       | Serveur de développement, collecteur inclus              |
| `pnpm build`     | Build de production (sortie `standalone`)                |
| `pnpm start`     | Serveur de production                                    |
| `pnpm typecheck` | `tsc --noEmit`                                           |
| `pnpm test`      | Tests unitaires (vitest)                                 |
| `node scripts/screenshot.mjs` | Capture de contrôle du rendu               |

## Architecture

Une seule application Next.js. Le collecteur tourne **dans le même process**,
démarré par `instrumentation.ts` — pas de serverless, pas de cron externe, pas
de file d'attente.

```
instrumentation.ts  ──►  Collector (singleton)
                           ├─ Tier A  découverte    60 s   12 requêtes
                           ├─ Tier B  nouvelles     20 s    2 requêtes
                           ├─ Tier C  hot set       12 s   ≤60 requêtes
                           └─ EventEmitter ──► SSE ──► navigateur
                                    │
                              SQLite (WAL)
                                    │
                     routes /api/*  +  Server Components
```

**Budget de requêtes** : ~5 req/s en pointe, réparties entre deux APIs limitées
à 20/s (DLMM) et 6/s (DAMM v2). Vérifiable en direct sur `/api/health`.

Le gain vient du tier A : l'endpoint *liste* renvoie `cumulative_metrics` pour
chaque ligne, donc douze requêtes suffisent à échantillonner ~1 200 pools. Le
tier C ne sert qu'à densifier le signal sur les pools qui comptent vraiment.

## Configuration

Tout est dans [`src/config.ts`](./src/config.ts), commenté. Les variables
d'environnement utiles :

| Variable | Défaut | Rôle |
|---|---|---|
| `DB_PATH` | `data/radar.db` | Fichier SQLite (sur un volume monté en prod) |
| `COLLECTOR` | `on` | `off` pour servir l'UI sans collecter |
| `LOG_LEVEL` | `info` | `trace`…`error` |
| `DISCOVERY_INTERVAL_MS` | `60000` | Période du tier A |
| `NEW_POOLS_INTERVAL_MS` | `20000` | Période du tier B |
| `HOT_SET_INTERVAL_MS` | `12000` | Période du tier C |

## Particularités de l'API Meteora

Vérifiées en live et figées dans le code — plusieurs sont contre-intuitives et
avaient été mal interprétées dans un projet précédent :

- **`fee_tvl_ratio` est déjà un pourcentage**, pas une fraction. Le multiplier
  par 100 gonfle toutes les mesures d'un facteur cent. Vérifié sur SOL-USDC :
  `fees24h/TVL×100 = 0,0885` et l'API renvoie `0.08850115`.
- **`apr` n'est pas un APR** : c'est exactement `fee_tvl_ratio["24h"]`.
- **`apy` déborde** à `18446744073709552000` (2⁶⁴) sur les pools jeunes.
  `toPoolView` le neutralise ; `annualisedPct()` le recalcule proprement.
- **Tri** : `sort_by=<champ>:<asc|desc>`, direction obligatoire. Un champ
  invalide renvoie un 400 qui liste tous les champs valides — c'est de là que
  vient `SORT_FIELDS`.
- **`sort_by=apr_*` renvoie 500** (cassé côté serveur). Ne pas l'utiliser.
- **`pool_created_at`** est le champ de tri par date de création (et non
  `created_at`, qui est le nom dans la réponse). Il fonctionne sur les deux
  protocoles et permet de détecter une pool moins d'une minute après sa
  création.
- **OHLCV** : timeframes `5m` à `24h`, il n'y a pas de `1m`. Bornes en
  secondes epoch.
- Les **fees cumulées peuvent régresser** (lecture périmée) ; ces points sont
  écartés pour ne jamais produire de taux négatif ni de faux pic au
  rattrapage.

## État

Phase 1 livrée : socle data, collecteur, vue Marché.
À suivre : vue Nouvelles pools + badges RugCheck, alertes Discord/Telegram,
panneau de détail avec OHLCV, déploiement Docker.
