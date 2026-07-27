# Architecture — Meteora Fee Sniper

Bot autonome de **fee-farming opportuniste** sur Meteora (DLMM + DAMM v2) :
détecter les pools qui impriment des fees de façon anormale, entrer en SPOT
serré autour du prix actif, récolter, sortir sur take-profit (+6 %) ou
stop-loss (−6 %) avant que l'IL ne mange les gains.

## Vue d'ensemble

```
                    ┌────────────────────────────────────────────────┐
                    │                    Engine                      │
                    │  (orchestration, boucles, kill switch, feed)   │
                    └──┬──────────┬──────────┬──────────┬────────────┘
                       │          │          │          │
        ┌──────────────▼──┐  ┌────▼─────┐ ┌──▼───────┐ ┌▼──────────────┐
        │    scanner/     │  │ scoring/ │ │  risk/   │ │position-mgr/  │
        │ 2 étages :      │  │ score    │ │ filtres  │ │ monitor ≤15s  │
        │ broad 90s       │  │ composite│ │ durs +   │ │ claims 60s    │
        │ fast  25s       │  │ + projec-│ │ RugCheck │ │ exit rules    │
        │ Δfees cumulées  │  │ tion     │ │fail-close│ │               │
        └───────┬─────────┘  └──────────┘ └──────────┘ └──────┬────────┘
                │                                             │
        ┌───────▼─────────┐                        ┌──────────▼────────┐
        │  Meteora datapi │                        │    execution/     │
        │  dlmm + damm-v2 │                        │ IPositionExecutor │
        │  (rate-limited) │                        │ paper | dlmm |    │
        └─────────────────┘                        │ damm_v2 (router)  │
                                                   └──────────┬────────┘
        ┌─────────────────┐  ┌──────────┐  ┌───────────┐      │
        │   db/ SQLite    │◄─┤  pnl/    │  │ notifier/ │◄─────┘
        │  (source vérité │  │ compta + │  │ Discord + │
        │   du bot)       │  │ rapport  │  │ Telegram  │
        └───────┬─────────┘  └──────────┘  └───────────┘
                │
        ┌───────▼─────────┐
        │   dashboard/    │  UI lecture seule (node:http, 1 page)
        └─────────────────┘
```

## Signal haute fréquence (cœur du bot)

Le bucket le plus court des data APIs est 30m — bien trop lent pour timer une
entrée sur un pic de fees. Le bot construit donc son propre signal :

1. **Broad scan** (90 s) : pages triées `sort_by=fee_tvl_ratio_30m:desc` et
   `volume_30m:desc` sur les deux APIs → pré-filtres (TVL bornée, blacklist,
   ratio heat 30m / baseline 24h ≥ 3) → **watchlist** (≤ 25 pools/protocole).
2. **Fast poll** (25 s) : `GET /pools/{address}` sur chaque pool watchlistée.
   `instant_fee_rate = Δ(cumulative_metrics.fees) / Δt` (USD/min) — mesure
   exacte, sans approximation. `instant_heat = rate×60 / TVL` (%/h).
   Dérivée seconde = accélération (n'entrer que si ≥ 0).
3. **Confirmation OHLCV 5m** (le plus fin dispo, vérifié en live) : drift net,
   chemin parcouru, vol réalisée /min, ratio volume/|Δprix| — distingue
   « gros volume en range » (idéal) de « tendance violente » (machine à IL).

Note : les timestamps où les fees cumulées régressent (lecture API stale)
sont ignorés pour ne jamais produire de taux négatif.

## Projection avant entrée

```
share          = size / (TVL × inRangeTvlFraction + size)     (auto-dilution)
expectedFees   = instant_fee_rate × horizon_projection(10min) × share
expectedIL     = IL(range ±w, move attendu = vol_réalisée × √horizon)
fixedCosts     = open + close + slippage aller-retour
expectedNet    = expectedFees − expectedIL − fixedCosts
breakeven(min) = fixedCosts / (instant_fee_rate × share)      (loggé partout)
```

Entrée seulement si : heat ≥ 2 %/h instantané, rate ≥ $25/min, accélération ≥ 0,
score composite ≥ 55, net ≥ $5 et ≥ 1.5× les coûts, breakeven ≤ 4 min,
drift 15min ≤ 12 %, RugCheck OK, limites portefeuille OK.

## Règles de sortie (parallèles, la première gagne)

| # | Règle        | Déclencheur                                                     |
|---|--------------|-----------------------------------------------------------------|
| 0 | KILL_SWITCH  | erreurs API/RPC répétées ou commande manuelle `close-all`        |
| 1 | OUT_OF_RANGE | prix hors du range → sortie immédiate                            |
| 2 | STOP_IL      | stop-loss : valeur (tokens + fees) < entrée − 6 %                |
| 3 | TAKE_PROFIT  | fees nettes ≥ 6 % de la taille                                   |
| 4 | FEE_DECAY    | fees/min < 35 % du taux d'entrée pendant ≥ 45 s                  |
| 5 | TIMEOUT      | optionnel, désactivé par défaut (`maxHoldMs: null`) — les sorties sont pilotées par TP/SL |

Boucle de monitoring : 10 s. Claim périodique : 60 s + claim final à la clôture.

## Schéma SQLite

```sql
pools            (address PK, protocol, name, mints/symbols, bin_step,
                  base_fee_pct, collect_fee_mode, created_at, first/last_seen_at)
pool_snapshots   (pool_address, ts, tvl, current_price, dynamic_fee_pct,
                  cum_fees_usd, cum_volume_usd, fees_30m, volume_30m,
                  fee_tvl_30m, source ['broad'|'fast'])       -- série temporelle
opportunities    (ts, pool, score, instant_fee_rate_usd_min, instant_heat_pct_hr,
                  fee_acceleration, turnover_30m, stability, expected_fees_usd,
                  expected_il_usd, fixed_costs_usd, expected_net_usd,
                  breakeven_min, decision ['ENTER'|'SKIP'], reject_reason)
positions        (pool, protocol, mode ['PAPER'|'LIVE'], status, opened/closed_at,
                  entry/exit_price, size_usd, lower/upper_price, bin_range,
                  entry_fee_rate_usd_min, onchain_address, tx_open/close, exit_reason)
position_events  (position_id, ts, kind ['OPEN','CLAIM','EXIT_SIGNAL','CLOSE','ERROR'], data JSON)
pnl              (position_id PK, fees_claimed_usd, il_usd, tx_costs_usd,
                  slippage_usd, net_pnl_usd, holding_minutes)
rugcheck_cache   (mint PK, checked_at, verdict, score_normalised, reason)  -- TTL 5min
```

Chaque évaluation (même rejetée) est persistée avec sa décomposition complète →
calibration offline des paramètres sur données réelles.

## Exécution

- `IPositionExecutor` : interface unique `open / status / claim / close`.
- **PaperExecutor** (DRY_RUN, défaut) : simulation sur données réelles —
  valeur du range par formules Uniswap-v3-style, accrual de fees =
  taux réel de la pool × part simulée, seulement quand le prix est in-range.
- **DlmmExecutor** : `initializePositionAndAddLiquidityByStrategy` (SPOT,
  active bin ± N), `claimSwapFee`, `removeLiquidity(shouldClaimAndClose)`.
- **DammV2Executor** : position NFT (`createPositionAndAddLiquidity`),
  `claimPositionFee`, `removeAllLiquidityAndClosePosition`.
- **LiveRouter** : dispatch par protocole derrière la même interface.
- Envoi : simulation systématique → priority fee dynamique (médiane
  `getRecentPrioritizationFees` × 1.5, plafonnée) → retry avec re-fetch du
  blockhash → confirmation `confirmed` → vérification `finalized` disponible
  pour la compta.
- Idempotence : au redémarrage, les positions OPEN de la DB sont re-monitorées
  (et en live, l'état on-chain est la source de vérité via `status()`).

## Découvertes API figées dans le code (vérifiées en live, 2026-07)

- Tri : `sort_by=<champ>:<asc|desc>` (ex. `fee_tvl_ratio_30m:desc`) —
  `sort_key`/`order_by` sont ignorés par l'API.
- Pas de filtre TVL serveur → filtrage client.
- OHLCV : `timeframe` ∈ {5m, 30m, 1h, 2h, 4h, 12h, 24h} (pas de 1m),
  bornes `start_time`/`end_time` en secondes epoch.
- RugCheck summary : `GET /v1/tokens/{mint}/report/summary` →
  `{score, score_normalised, risks[{name, level, ...}]}` (score haut = risqué).
- Le build ESM de `@meteora-ag/dlmm` 1.9.14 est cassé (imports de répertoires
  anchor) → chargé via `createRequire` (build CJS), typé proprement.
```
