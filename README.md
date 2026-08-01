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

## Les vues

**Marché** (`/`) — classement par heat, tri sur toutes les colonnes, filtres
TVL / heat / protocole / âge.

**Nouvelles pools** (`/nouvelles`) — détection en moins de 20 s. Les colonnes
sont groupées selon les deux moitiés de la seule question qui compte à cet
instant : *ça imprime ?* (âge, $/min, heat, TVL, volume, nombre
d'échantillons) et *c'est safe ?* (verdict RugCheck, LP verrouillée, holders,
freeze authority).

Le filtre y est une **disjonction** TVL *ou* volume : une pool de trois
minutes peut n'avoir presque pas de liquidité tout en tradant fort, ou
l'inverse — les deux cas méritent un regard.

Chaque ligne porte cinq liens rapides : **G**MGN, **P**adre, **R**ugCheck,
**B**ubblemaps, **M**eteora. Ils pointent sur le token *non-quote* de la
paire, jamais sur SOL.

> Un compteur de traders connus (KOL) par token a été construit puis retiré :
> il exigeait de reconstruire un index inversé en interrogeant ~550 wallets,
> soit ~1100 requêtes Helius par passe, ce qui dépasse largement un quota
> gratuit. Le code reste dans l'historique git (`b902b42`) si le besoin
> revient avec un quota adapté.

## Sécurité

Le verdict RugCheck ne rend jamais « vert » un token sans rapport : un
lancement de deux minutes que personne n'a analysé est affiché « inconnu »,
ce qui n'est pas rassurant et ne doit pas en avoir l'air. Le score n'est pas
non plus inversé à l'écran, puisque l'échelle RugCheck est
*plus haut = plus risqué* — le retourner silencieusement ferait passer le
chiffre brut du site pour une contradiction.

`lpLockedPct` est le signal le plus fort sur un lancement et il est affiché
en barre : une LP non verrouillée peut être retirée à tout moment.

## État

Phases 1 et 2 livrées : socle data, collecteur trois tiers, vue Marché, vue
Nouvelles pools, badges RugCheck, liens rapides.
À suivre : alertes Discord/Telegram, panneau de détail avec OHLCV et
simulateur de position, déploiement Docker, et — non prioritaire — l'ouverture
de position en un clic (signature côté navigateur uniquement, aucune clé
privée côté serveur).
