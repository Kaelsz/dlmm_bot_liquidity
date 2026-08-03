/**
 * Derivation of the high-frequency fee signal.
 *
 * This is the product's differentiator. The Meteora list endpoints expose
 * nothing shorter than a 30-minute bucket, which is far too coarse to see a
 * pool start printing. But every row carries `cumulative_metrics.fees`, a
 * monotonically increasing counter — so sampling it and differentiating gives
 * a fee rate at whatever resolution we poll at.
 *
 * CADENCE RÉELLE DU COMPTEUR — mesurée, pas supposée : `cumulative_metrics.fees`
 * ne croît pas continûment, il saute environ une fois par minute (20 intervalles
 * nuls sur 23 lectures espacées de 5 s, sur la pool la plus active du marché).
 * Dériver sur le seul dernier couple d'échantillons donne donc alternativement
 * 0 et un multiple du vrai débit — c'est ce qui faisait clignoter le Heat et
 * entrer/sortir les pools du classement. D'où la fenêtre adaptative ci-dessous.
 *
 * Everything here is pure so it can be unit-tested without network or DB.
 *
 * UNITS — the trap that bit the previous implementation:
 *   - `feeRateUsdPerMin` is USD/minute, derived by us.
 *   - `heatPctPerHour` converts a FRACTION (rate*60/tvl) to a percentage, so
 *     the *100 here is correct.
 *   - The API's own `fee_tvl_ratio` is ALREADY a percentage and must never be
 *     multiplied by 100. Do not confuse the two.
 */

export interface FeePoint {
  ts: number;
  /** `cumulative_metrics.fees` — monotonically increasing. */
  cumFees: number;
  /** `cumulative_metrics.volume` — same treatment, same resolution win. */
  cumVolume: number;
  tvl: number;
}

/** Paramètres de la fenêtre adaptative (voir `config.collector.rate`). */
export interface RateWindowConfig {
  minUpdates: number;
  minSpanMs: number;
  maxWindowMs: number;
  /**
   * Plancher sous lequel un taux est traité comme nul.
   *
   * MESURÉ : 39 % des taux strictement positifs sont sous $0,01/min, et le
   * plus petit observé vaut 2e-20 $/min — de la poussière en virgule flottante,
   * pas un flux de fees. Sans ce plancher, le rapport entre un vrai taux et ce
   * résidu produit des variations de 1e13 qui n'ont aucun sens physique.
   *
   * $0,01/min, c'est moins de $15 par jour : rien qui mérite un regard. Le
   * seuil ne touche donc aucune valeur exploitable — vérifié, la médiane et le
   * p90 des variations sont inchangés, seule la queue extrême s'effondre.
   */
  minMeaningfulRate: number;
}

export const DEFAULT_RATE_WINDOW: RateWindowConfig = {
  minUpdates: 3,
  minSpanMs: 45_000,
  maxWindowMs: 600_000,
  minMeaningfulRate: 0.01,
};

export interface DerivedMetrics {
  /** USD of fees per minute, from the most recent pair of samples. */
  feeRateUsdPerMin: number;
  /** USD of volume per minute, derived the same way. The API's own shortest
   *  volume bucket is 30 minutes, which cannot show a burst as it happens. */
  volumeRateUsdPerMin: number;
  /** Percent of TVL paid out as fees per hour, at the current rate. */
  heatPctPerHour: number;
  /** Second derivative: change in fee rate per minute. Positive = accelerating. */
  feeAccel: number;
  /** How many usable samples back the estimate. Below 2, nothing is derivable. */
  sampleCount: number;
  /** Durée réellement couverte par la fenêtre du taux, en ms. */
  rateSpanMs: number;
  /** Nombre de sauts du compteur captés par la fenêtre. Porte la confiance. */
  rateUpdates: number;
  /** Highest rate seen in the retained history. */
  peakRateUsdPerMin: number;
  /** Consecutive most-recent samples whose rate stayed above `hotThreshold`. */
  hotStreak: number;
  /** Per-interval rates, oldest first — feeds the sparkline. */
  rateSeries: number[];
}

/**
 * Append a sample, dropping it when the cumulative counter goes backwards.
 *
 * Cumulative fees only ever increase; a lower reading means the API served a
 * stale value. Keeping it would produce a negative rate and, worse, a fake
 * spike on the following sample once the counter catches up.
 *
 * Returns the new history (the input is not mutated), or `undefined` when the
 * point was rejected.
 */
export function pushFeePoint(
  history: readonly FeePoint[],
  point: FeePoint,
  maxPoints: number,
): FeePoint[] | undefined {
  const last = history[history.length - 1];
  if (last) {
    if (point.cumFees < last.cumFees) return undefined;
    if (point.ts <= last.ts) return undefined;
  }
  const next = [...history, point];
  return next.length > maxPoints ? next.slice(next.length - maxPoints) : next;
}

/**
 * Fenêtre adaptative : remonte depuis `endIdx` jusqu'à capter assez de sauts du
 * compteur pour que la division soit significative.
 *
 * Trois conditions d'arrêt : assez de sauts (`minUpdates`), assez de temps
 * (`minSpanMs`), et jamais au-delà de `maxWindowMs`. Les deux premières évitent
 * de diviser l'accumulé d'une minute par 12 s ; la troisième évite qu'une pool
 * inerte moyenne sur toute son histoire.
 *
 * C'est ce qui rend la mesure ADAPTATIVE : sur une pool qui s'emballe les sauts
 * s'enchaînent, la fenêtre se referme et le chiffre grimpe vite ; sur une pool
 * calme elle s'étire et le chiffre cesse de clignoter.
 *
 * Les deltas négatifs sont ignorés : les compteurs ne font que croître, une
 * baisse signale une lecture périmée.
 */
function windowedRate(
  history: readonly FeePoint[],
  endIdx: number,
  field: "cumFees" | "cumVolume",
  cfg: RateWindowConfig,
): { rate: number; spanMs: number; updates: number } {
  const end = history[endIdx];
  if (!end || endIdx <= 0) return { rate: 0, spanMs: 0, updates: 0 };

  let start = endIdx;
  let updates = 0;
  for (let i = endIdx; i > 0; i -= 1) {
    const prev = history[i - 1]!;
    if (end.ts - prev.ts > cfg.maxWindowMs) break;
    if (history[i]![field] - prev[field] > 0) updates += 1;
    start = i - 1;
    if (updates >= cfg.minUpdates && end.ts - prev.ts >= cfg.minSpanMs) break;
  }

  const anchor = history[start]!;
  const spanMs = end.ts - anchor.ts;
  if (spanMs <= 0) return { rate: 0, spanMs: 0, updates };
  const delta = end[field] - anchor[field];
  const rate = delta > 0 ? delta / (spanMs / 60_000) : 0;
  // La poussière numérique est ramenée à zéro : la garder produirait des
  // rapports absurdes sans jamais représenter un flux réel.
  return { rate: rate >= cfg.minMeaningfulRate ? rate : 0, spanMs, updates };
}

export function deriveMetrics(
  history: readonly FeePoint[],
  hotThreshold = 0,
  cfg: RateWindowConfig = DEFAULT_RATE_WINDOW,
): DerivedMetrics | undefined {
  if (history.length < 2) return undefined;

  // Taux fenêtré à chaque indice : la sparkline doit raconter la même histoire
  // que le chiffre affiché à côté d'elle.
  const rateSeries: number[] = [];
  for (let i = 1; i < history.length; i += 1) {
    rateSeries.push(windowedRate(history, i, "cumFees", cfg).rate);
  }

  const last = history.length - 1;
  const fee = windowedRate(history, last, "cumFees", cfg);
  const vol = windowedRate(history, last, "cumVolume", cfg);
  const curr = history[last]!;

  const feeRateUsdPerMin = fee.rate;
  const volumeRateUsdPerMin = vol.rate;

  const tvl = curr.tvl > 0 ? curr.tvl : 0;
  const heatPctPerHour = tvl > 0 ? ((feeRateUsdPerMin * 60) / tvl) * 100 : 0;

  // Accélération : comparer la fenêtre courante à celle qui se terminait au
  // début de la fenêtre courante. Comparer deux intervalles bruts revenait à
  // dériver le bruit d'échantillonnage.
  let feeAccel = 0;
  let anchorIdx = last;
  while (anchorIdx > 0 && curr.ts - history[anchorIdx]!.ts < fee.spanMs) anchorIdx -= 1;
  if (anchorIdx > 0) {
    const before = windowedRate(history, anchorIdx, "cumFees", cfg);
    const dtMin = (curr.ts - history[anchorIdx]!.ts) / 60_000;
    if (dtMin > 0) feeAccel = (feeRateUsdPerMin - before.rate) / dtMin;
  }

  const peakRateUsdPerMin = rateSeries.reduce((m, r) => (r > m ? r : m), 0);

  let hotStreak = 0;
  for (let i = rateSeries.length - 1; i >= 0; i -= 1) {
    if (rateSeries[i]! > hotThreshold) hotStreak += 1;
    else break;
  }

  return {
    feeRateUsdPerMin,
    volumeRateUsdPerMin,
    heatPctPerHour,
    feeAccel,
    sampleCount: history.length,
    rateSpanMs: fee.spanMs,
    rateUpdates: fee.updates,
    peakRateUsdPerMin,
    hotStreak,
    rateSeries,
  };
}

/**
 * Le taux est-il assez étayé pour être lu sans réserve ?
 *
 * Choix explicite : l'UI affiche tôt plutôt que de masquer, mais marque la
 * valeur quand cette fonction renvoie false.
 */
export function isRateReliable(
  m: { rateSpanMs: number; rateUpdates: number },
  cfg: RateWindowConfig = DEFAULT_RATE_WINDOW,
): boolean {
  return m.rateUpdates >= cfg.minUpdates && m.rateSpanMs >= cfg.minSpanMs;
}

/**
 * Thermal tiers for the heat cell. Thresholds are in percent of TVL per hour.
 * `inert` covers pools that are technically alive but not worth a glance.
 */
export type HeatTier = "inert" | "cool" | "warm" | "hot" | "blazing" | "nuclear";

export function heatTier(heatPctPerHour: number): HeatTier {
  if (!Number.isFinite(heatPctPerHour) || heatPctPerHour < 0.5) return "inert";
  if (heatPctPerHour < 2) return "cool";
  if (heatPctPerHour < 5) return "warm";
  if (heatPctPerHour < 15) return "hot";
  if (heatPctPerHour < 40) return "blazing";
  return "nuclear";
}

/**
 * How much of a requested window our own fee samples actually cover.
 *
 * The series is bounded twice over: by `sampleRetentionMs` (6h of raw samples)
 * and by how long the collector has known the pool. Asking for 7d therefore
 * cannot ever be answered in full, and the panel has to say so rather than
 * stretch a few minutes of data across a week of axis.
 */
export function signalCoverage(
  signal: readonly { ts: number }[],
  windowMs: number,
): { spanMs: number; ratio: number } {
  if (signal.length < 2 || windowMs <= 0) return { spanMs: 0, ratio: 0 };
  const spanMs = Math.max(0, signal[signal.length - 1]!.ts - signal[0]!.ts);
  return { spanMs, ratio: spanMs / windowMs };
}

/**
 * Below this share of the requested window, a shared time axis squeezes the
 * fee series into an unreadable sliver against the right edge. The panel then
 * states the coverage in words instead of drawing it.
 */
export const MIN_SIGNAL_COVERAGE = 0.1;

/**
 * Annualised yield from the API's 24h fee/TVL percentage, compounded daily.
 * Reproduces the API's own `apy` (verified: SOL-USDC 0.0885% -> 38.11%) but
 * without the uint64 overflow it returns on young pools.
 */
export function annualisedPct(feeTvlRatio24hPct: number): number {
  if (!Number.isFinite(feeTvlRatio24hPct) || feeTvlRatio24hPct <= 0) return 0;
  return ((1 + feeTvlRatio24hPct / 100) ** 365 - 1) * 100;
}
