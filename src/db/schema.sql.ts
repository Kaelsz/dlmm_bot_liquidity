/**
 * Schema, applied idempotently on every boot.
 *
 * Two deliberate departures from the trading bot's database:
 *
 *  1. `pools` stores EVERYTHING the collector sees. The bot only persisted
 *     pools that survived its entry prefilter, which made its own table a
 *     biased sample of the market — useless for a dashboard.
 *
 *  2. `pool_metrics` is materialised. The leaderboard needs 100 rows each
 *     carrying a sparkline; computing that from the raw series on every
 *     request is 100 queries. The collector writes this table once per cycle
 *     so the read path is a single indexed SELECT.
 */
/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` cannot
 * add them to a database that already exists, so they are ALTERed in
 * separately and the "duplicate column" error is swallowed — SQLite has no
 * `ADD COLUMN IF NOT EXISTS`.
 */
export const MIGRATIONS: string[] = [
  "ALTER TABLE pools ADD COLUMN token_y_holders INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE pools ADD COLUMN token_y_verified INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE pools ADD COLUMN token_y_freeze_disabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE pools ADD COLUMN token_y_market_cap REAL NOT NULL DEFAULT 0",
  "ALTER TABLE pool_metrics ADD COLUMN volume_rate_usd_min REAL NOT NULL DEFAULT 0",
  "ALTER TABLE pool_metrics ADD COLUMN rate_span_ms INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE pool_metrics ADD COLUMN rate_updates INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tracked_wallets ADD COLUMN last_viewed_at INTEGER",
  "ALTER TABLE pools ADD COLUMN risky_market_cap REAL NOT NULL DEFAULT 0",
  "ALTER TABLE wallet_positions ADD COLUMN active_bin_id INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE wallet_positions ADD COLUMN lower_price REAL NOT NULL DEFAULT 0",
  "ALTER TABLE wallet_positions ADD COLUMN upper_price REAL NOT NULL DEFAULT 0",
  "ALTER TABLE wallet_positions ADD COLUMN current_price REAL NOT NULL DEFAULT 0",
];

export const SCHEMA = `
-- Wallets dont on suit les positions. Une adresse publique n'est pas un secret,
-- mais le dashboard n'a pas d'authentification propre : c'est basic_auth qui
-- protège l'accès (cf. DEPLOY.md).
CREATE TABLE IF NOT EXISTS tracked_wallets (
  owner       TEXT PRIMARY KEY,
  added_at    INTEGER NOT NULL,
  last_sync_at INTEGER,
  -- Dernière consultation. Le suivi de fond ne garde que les wallets
  -- réellement regardés : sur un site public, sonder indéfiniment chaque
  -- adresse tapée par un visiteur viderait le quota RPC.
  last_viewed_at INTEGER
);

-- Positions vues au moins une fois. closed_at non nul = la position a disparu
-- de la chaîne, donc elle a été fermée.
CREATE TABLE IF NOT EXISTS wallet_positions (
  position_address TEXT PRIMARY KEY,
  owner            TEXT NOT NULL,
  pool_address     TEXT NOT NULL,
  pool_name        TEXT NOT NULL DEFAULT '',
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  closed_at        INTEGER,
  -- Capital engagé et sorti, reconstitués depuis les variations de parts.
  deposited_usd    REAL NOT NULL DEFAULT 0,
  withdrawn_usd    REAL NOT NULL DEFAULT 0,
  total_shares     REAL NOT NULL DEFAULT 0,
  -- Dernier état connu.
  value_usd        REAL NOT NULL DEFAULT 0,
  claimed_fee_usd  REAL NOT NULL DEFAULT 0,
  unclaimed_fee_usd REAL NOT NULL DEFAULT 0,
  lower_bin_id     INTEGER NOT NULL DEFAULT 0,
  upper_bin_id     INTEGER NOT NULL DEFAULT 0,
  -- Bin où était le prix au dernier relevé : situe la position DANS sa plage,
  -- ce que in_range seul ne dit pas.
  active_bin_id    INTEGER NOT NULL DEFAULT 0,
  -- Bornes et prix courant, prix de X en Y. 0 = non calculable.
  lower_price      REAL NOT NULL DEFAULT 0,
  upper_price      REAL NOT NULL DEFAULT 0,
  current_price    REAL NOT NULL DEFAULT 0,
  in_range         INTEGER NOT NULL DEFAULT 0,
  valued           INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_positions_owner ON wallet_positions(owner, closed_at);

CREATE TABLE IF NOT EXISTS pools (
  address                   TEXT PRIMARY KEY,
  protocol                  TEXT NOT NULL,
  name                      TEXT NOT NULL,
  token_x_mint              TEXT NOT NULL,
  token_x_symbol            TEXT NOT NULL,
  token_x_decimals          INTEGER NOT NULL DEFAULT 0,
  token_x_holders           INTEGER NOT NULL DEFAULT 0,
  token_x_verified          INTEGER NOT NULL DEFAULT 0,
  token_x_freeze_disabled   INTEGER NOT NULL DEFAULT 0,
  token_x_market_cap        REAL NOT NULL DEFAULT 0,
  token_y_mint              TEXT NOT NULL,
  token_y_symbol            TEXT NOT NULL,
  token_y_decimals          INTEGER NOT NULL DEFAULT 0,
  token_y_holders           INTEGER NOT NULL DEFAULT 0,
  token_y_verified          INTEGER NOT NULL DEFAULT 0,
  token_y_freeze_disabled   INTEGER NOT NULL DEFAULT 0,
  token_y_market_cap        REAL NOT NULL DEFAULT 0,
  -- Market cap du côté RISQUÉ uniquement. Dénormalisé parce que filtrer
  -- dessus exigerait sinon de porter la liste des mints de confiance dans la
  -- requête SQL ; ici la définition du côté risqué reste en TypeScript, à un
  -- seul endroit. Celui du quote n'a aucun sens : USDC vaut $7,7 Md partout.
  risky_market_cap          REAL NOT NULL DEFAULT 0,
  bin_step                  INTEGER,
  base_fee_pct              REAL NOT NULL DEFAULT 0,
  collect_fee_mode          INTEGER NOT NULL DEFAULT 0,
  created_at                INTEGER NOT NULL DEFAULT 0,
  first_seen_at             INTEGER NOT NULL,
  last_seen_at              INTEGER NOT NULL,
  is_blacklisted            INTEGER NOT NULL DEFAULT 0,
  launchpad                 TEXT,
  tags                      TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_pools_created ON pools(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pools_seen    ON pools(last_seen_at DESC);

-- Raw time series. Short retention; the rollup carries the long history.
CREATE TABLE IF NOT EXISTS pool_samples (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_address     TEXT NOT NULL,
  ts               INTEGER NOT NULL,
  tvl              REAL NOT NULL,
  price            REAL NOT NULL,
  cum_fees_usd     REAL NOT NULL,
  cum_volume_usd   REAL NOT NULL,
  fees_30m         REAL NOT NULL DEFAULT 0,
  volume_30m       REAL NOT NULL DEFAULT 0,
  fee_tvl_30m_pct  REAL NOT NULL DEFAULT 0,
  reserve_x_amount REAL NOT NULL DEFAULT 0,
  reserve_y_amount REAL NOT NULL DEFAULT 0,
  source           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_pool_ts ON pool_samples(pool_address, ts DESC);
CREATE INDEX IF NOT EXISTS idx_samples_ts      ON pool_samples(ts);

-- One row per pool, rewritten by the collector. This is what the UI reads.
CREATE TABLE IF NOT EXISTS pool_metrics (
  pool_address       TEXT PRIMARY KEY,
  ts                 INTEGER NOT NULL,
  fee_rate_usd_min   REAL NOT NULL DEFAULT 0,
  volume_rate_usd_min REAL NOT NULL DEFAULT 0,
  -- Portée réelle de la fenêtre de dérivation : porte la confiance du taux.
  rate_span_ms       INTEGER NOT NULL DEFAULT 0,
  rate_updates       INTEGER NOT NULL DEFAULT 0,
  heat_pct_hr        REAL NOT NULL DEFAULT 0,
  fee_accel          REAL NOT NULL DEFAULT 0,
  peak_rate_usd_min  REAL NOT NULL DEFAULT 0,
  hot_streak         INTEGER NOT NULL DEFAULT 0,
  sample_count       INTEGER NOT NULL DEFAULT 0,
  sparkline_json     TEXT NOT NULL DEFAULT '[]',
  -- Denormalised snapshot of the latest API values, so the leaderboard is a
  -- single table scan joined to pools rather than a correlated subquery.
  tvl                REAL NOT NULL DEFAULT 0,
  price              REAL NOT NULL DEFAULT 0,
  volume_30m         REAL NOT NULL DEFAULT 0,
  fees_30m           REAL NOT NULL DEFAULT 0,
  fee_tvl_30m_pct    REAL NOT NULL DEFAULT 0,
  fee_tvl_24h_pct    REAL NOT NULL DEFAULT 0,
  dynamic_fee_pct    REAL,
  apy_pct            REAL,
  reserve_x_amount   REAL NOT NULL DEFAULT 0,
  reserve_y_amount   REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_metrics_heat ON pool_metrics(heat_pct_hr DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_rate ON pool_metrics(fee_rate_usd_min DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_ts   ON pool_metrics(ts DESC);

-- Full RugCheck payload, not just a verdict: lp_locked_pct and the risk list
-- are the most useful signals on a launch and are free in the same call.
CREATE TABLE IF NOT EXISTS rugcheck (
  mint          TEXT PRIMARY KEY,
  checked_at    INTEGER NOT NULL,
  score         REAL,
  lp_locked_pct REAL,
  risks_json    TEXT NOT NULL DEFAULT '[]',
  unavailable   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rugcheck_checked ON rugcheck(checked_at DESC);

CREATE TABLE IF NOT EXISTS watchlist (
  pool_address TEXT PRIMARY KEY,
  added_at     INTEGER NOT NULL,
  note         TEXT NOT NULL DEFAULT ''
);
`;
