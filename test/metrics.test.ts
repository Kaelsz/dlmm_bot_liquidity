import { describe, expect, it } from "vitest";
import {
  annualisedPct,
  deriveMetrics,
  heatTier,
  isRateReliable,
  pushFeePoint,
  DEFAULT_RATE_WINDOW,
  type FeePoint,
} from "../src/data/metrics";

const M = 60_000;

/** Builds a history from [minutesFromStart, cumulativeFees] pairs.
 *  Cumulative volume trails fees by a constant factor unless a test overrides
 *  it, so fee assertions are unaffected by its presence. */
const hist = (pairs: Array<[number, number]>, tvl = 10_000): FeePoint[] =>
  pairs.map(([min, cumFees]) => ({ ts: min * M, cumFees, cumVolume: cumFees * 100, tvl }));

describe("pushFeePoint", () => {
  it("drops readings where cumulative fees go backwards", () => {
    const h = hist([
      [0, 100],
      [1, 150],
    ]);
    // A stale API read reports less than we already banked.
    expect(pushFeePoint(h, { ts: 2 * M, cumFees: 120, cumVolume: 12_000, tvl: 10_000 }, 20)).toBeUndefined();
    // A normal increase is accepted.
    expect(pushFeePoint(h, { ts: 2 * M, cumFees: 200, cumVolume: 20_000, tvl: 10_000 }, 20)).toHaveLength(3);
  });

  it("drops out-of-order timestamps", () => {
    const h = hist([[5, 100]]);
    expect(pushFeePoint(h, { ts: 4 * M, cumFees: 200, cumVolume: 20_000, tvl: 1 }, 20)).toBeUndefined();
  });

  it("caps the history and keeps the newest points", () => {
    let h: FeePoint[] = [];
    for (let i = 0; i < 10; i += 1) {
      h = pushFeePoint(h, { ts: i * M, cumFees: i * 10, cumVolume: i * 1_000, tvl: 1 }, 4)!;
    }
    expect(h).toHaveLength(4);
    expect(h[h.length - 1]!.cumFees).toBe(90);
  });

  it("does not mutate the input", () => {
    const h = hist([[0, 100]]);
    pushFeePoint(h, { ts: M, cumFees: 200, cumVolume: 20_000, tvl: 1 }, 20);
    expect(h).toHaveLength(1);
  });
});

describe("deriveMetrics", () => {
  it("needs at least two samples", () => {
    expect(deriveMetrics(hist([[0, 100]]))).toBeUndefined();
  });

  it("dérive le volume sur la même fenêtre que les fees", () => {
    // $17k de volume sur 3 minutes => ~$5,7k/min. La fenêtre couvre tout
    // l'historique disponible ici, exactement comme pour les fees : les deux
    // taux doivent porter sur la même portée, sinon on compare des choses
    // mesurées sur des durées différentes.
    const h: FeePoint[] = [
      { ts: 0, cumFees: 0, cumVolume: 0, tvl: 10_000 },
      { ts: M, cumFees: 10, cumVolume: 5_000, tvl: 10_000 },
      { ts: 3 * M, cumFees: 40, cumVolume: 17_000, tvl: 10_000 },
    ];
    const m = deriveMetrics(h)!;
    expect(m.volumeRateUsdPerMin).toBeCloseTo(17_000 / 3, 6);
    expect(m.feeRateUsdPerMin).toBeCloseTo(40 / 3, 6);
  });

  it("clamps a volume counter that goes backwards", () => {
    // Fees still advance, so the sample is kept; only the stale volume is
    // neutralised rather than reported as a negative rate.
    const h: FeePoint[] = [
      { ts: 0, cumFees: 0, cumVolume: 50_000, tvl: 10_000 },
      { ts: M, cumFees: 10, cumVolume: 40_000, tvl: 10_000 },
    ];
    const m = deriveMetrics(h)!;
    expect(m.volumeRateUsdPerMin).toBe(0);
    expect(m.feeRateUsdPerMin).toBeCloseTo(10);
  });

  it("computes the fee rate from the last interval", () => {
    // $60 earned over 2 minutes => $30/min.
    const m = deriveMetrics(hist([
      [0, 0],
      [2, 60],
    ]))!;
    expect(m.feeRateUsdPerMin).toBeCloseTo(30, 9);
  });

  it("expresses heat as a percentage of TVL per hour", () => {
    // $10/min on $10k TVL => $600/h => 6% of TVL per hour.
    const m = deriveMetrics(hist(
      [
        [0, 0],
        [1, 10],
      ],
      10_000,
    ))!;
    expect(m.heatPctPerHour).toBeCloseTo(6, 9);
  });

  it("signale une accélération quand le débit monte", () => {
    // Débit calme sur 4 min, puis quadruplé sur les 4 suivantes. L'accélération
    // compare deux fenêtres successives, pas deux intervalles bruts.
    const pts: Array<[number, number]> = [];
    let cum = 0;
    for (let min = 0; min <= 8; min += 1) {
      pts.push([min, cum]);
      cum += min < 4 ? 10 : 40;
    }
    const m = deriveMetrics(hist(pts))!;
    expect(m.feeRateUsdPerMin).toBeGreaterThan(20);
    expect(m.feeAccel).toBeGreaterThan(0);
  });

  it("signale une décélération quand la rafale retombe", () => {
    const pts: Array<[number, number]> = [];
    let cum = 0;
    for (let min = 0; min <= 8; min += 1) {
      pts.push([min, cum]);
      cum += min < 4 ? 100 : 5;
    }
    expect(deriveMetrics(hist(pts))!.feeAccel).toBeLessThan(0);
  });

  it("tracks the peak rate across the retained history", () => {
    const m = deriveMetrics(hist([
      [0, 0],
      [1, 500], // 500/min
      [2, 510], // 10/min
    ]))!;
    // Le pic reste la plus forte fenêtre observée. Le taux courant, lui, est
    // désormais une moyenne fenêtrée : la rafale de la 1re minute pèse encore
    // sur la fenêtre, ce qui est le comportement voulu — c'est ce qui empêche
    // le chiffre de retomber à zéro dès que le compteur ne bouge plus.
    expect(m.peakRateUsdPerMin).toBeCloseTo(500, 9);
    expect(m.feeRateUsdPerMin).toBeCloseTo(255, 9);
  });

  it("counts a hot streak only while the rate stays above the threshold", () => {
    const m = deriveMetrics(
      hist([
        [0, 0],
        [1, 100], // 100/min  hot
        [2, 100], // 0/min    cold -> breaks the streak
        [3, 200], // 100/min  hot
        [4, 300], // 100/min  hot
      ]),
      50,
    )!;
    expect(m.hotStreak).toBe(2);
  });

  it("never yields a negative rate and survives a zero TVL", () => {
    const m = deriveMetrics(hist(
      [
        [0, 100],
        [1, 100],
      ],
      0,
    ))!;
    expect(m.feeRateUsdPerMin).toBe(0);
    expect(m.heatPctPerHour).toBe(0);
  });

  it("exposes one rate per interval for the sparkline", () => {
    const m = deriveMetrics(hist([
      [0, 0],
      [1, 10],
      [2, 20],
      [3, 30],
    ]))!;
    expect(m.rateSeries).toHaveLength(3);
  });
});

describe("heatTier", () => {
  it("maps the thermal scale by threshold", () => {
    expect(heatTier(0)).toBe("inert");
    expect(heatTier(0.49)).toBe("inert");
    expect(heatTier(0.5)).toBe("cool");
    expect(heatTier(1.9)).toBe("cool");
    expect(heatTier(2)).toBe("warm");
    expect(heatTier(5)).toBe("hot");
    expect(heatTier(15)).toBe("blazing");
    expect(heatTier(40)).toBe("nuclear");
    expect(heatTier(1e6)).toBe("nuclear");
  });

  it("treats non-finite input as inert rather than throwing", () => {
    expect(heatTier(Number.NaN)).toBe("inert");
  });
});

describe("annualisedPct", () => {
  it("reproduces the API's own apy from the 24h fee/TVL percentage", () => {
    // Verified live on SOL-USDC: fee_tvl_ratio 24h = 0.0885% -> apy 38.11%.
    expect(annualisedPct(0.08850115394372726)).toBeCloseTo(38.11, 1);
  });

  it("returns zero for non-positive or non-finite input", () => {
    expect(annualisedPct(0)).toBe(0);
    expect(annualisedPct(-1)).toBe(0);
    expect(annualisedPct(Number.NaN)).toBe(0);
  });
});

/**
 * Reproduit la cadence RÉELLE de l'API, mesurée en direct : le compteur de
 * fees cumulées reste plat puis saute, environ une fois par minute, pendant
 * qu'on l'échantillonne toutes les 12 s.
 *
 * C'est ce motif qui faisait clignoter le Heat entre 0 et cinq fois le vrai
 * débit. Les anciens tests utilisaient un compteur qui montait régulièrement —
 * une hypothèse que le marché ne respecte pas, et c'est pourquoi le défaut est
 * passé au travers.
 */
const steppy = (minutes: number, usdPerMin: number, pollMs = 12_000): FeePoint[] => {
  const pts: FeePoint[] = [];
  let cum = 0;
  const n = Math.round((minutes * 60_000) / pollMs);
  for (let i = 0; i <= n; i += 1) {
    const ts = i * pollMs;
    // Le compteur ne se met à jour qu'au passage de chaque minute pleine.
    cum = Math.floor(ts / 60_000) * usdPerMin;
    pts.push({ ts, cumFees: cum, cumVolume: cum * 100, tvl: 10_000 });
  }
  return pts;
};

describe("taux sur compteur en escalier (cadence réelle de l'API)", () => {
  it("retrouve le vrai débit là où le dernier intervalle donnait 0 ou 5x", () => {
    const h = steppy(6, 60); // $60/min réels
    const m = deriveMetrics(h)!;

    // L'ancien calcul — dernier couple d'échantillons — alterne entre 0 (le
    // compteur n'a pas bougé) et 5x le vrai débit (tout l'accumulé d'une
    // minute divisé par 12 s). C'est très exactement le clignotement observé.
    const naive: number[] = [];
    for (let i = h.length - 10; i < h.length; i += 1) {
      naive.push((h[i]!.cumFees - h[i - 1]!.cumFees) / (12_000 / 60_000));
    }
    expect(Math.min(...naive)).toBe(0);
    expect(Math.max(...naive)).toBeGreaterThanOrEqual(60 * 4);

    // La fenêtre adaptative retrouve le débit réel.
    // Un biais résiduel subsiste (la fenêtre peut se fermer juste après un
    // saut), mais on passe d'un facteur 5 à moins de 1,5.
    expect(m.feeRateUsdPerMin).toBeGreaterThan(40);
    expect(m.feeRateUsdPerMin).toBeLessThan(90);
  });

  it("ne laisse plus le taux retomber à zéro d'un échantillon à l'autre", () => {
    const h = steppy(6, 60);
    // Sur les 10 derniers points, le taux fenêtré doit rester du même ordre.
    const rates = h.slice(-10).map((_, i) => {
      const upTo = h.slice(0, h.length - 9 + i);
      return deriveMetrics(upTo)!.feeRateUsdPerMin;
    });
    expect(Math.min(...rates)).toBeGreaterThan(30);
    const spread = Math.max(...rates) / Math.min(...rates);
    expect(spread).toBeLessThan(2.5);
  });

  it("resserre la fenêtre quand les sauts s'enchaînent — la réactivité", () => {
    // Pool calme : sauts toutes les minutes.
    const calme = deriveMetrics(steppy(6, 60))!;
    // Pool qui s'emballe : le compteur bouge à chaque sondage.
    const emballee: FeePoint[] = [];
    for (let i = 0; i <= 30; i += 1) {
      emballee.push({ ts: i * 12_000, cumFees: i * 12, cumVolume: i * 1200, tvl: 10_000 });
    }
    const chaude = deriveMetrics(emballee)!;
    expect(chaude.rateSpanMs).toBeLessThan(calme.rateSpanMs);
    expect(chaude.rateSpanMs).toBeLessThanOrEqual(DEFAULT_RATE_WINDOW.minSpanMs + 12_000);
  });

  it("borne la fenêtre sur une pool inerte", () => {
    const morte: FeePoint[] = [];
    for (let i = 0; i <= 60; i += 1) {
      morte.push({ ts: i * 30_000, cumFees: 100, cumVolume: 100, tvl: 10_000 });
    }
    const m = deriveMetrics(morte)!;
    expect(m.rateSpanMs).toBeLessThanOrEqual(DEFAULT_RATE_WINDOW.maxWindowMs);
    expect(m.feeRateUsdPerMin).toBe(0);
  });

  it("signale une confiance faible tant que la fenêtre n'est pas remplie", () => {
    const jeune: FeePoint[] = [
      { ts: 0, cumFees: 0, cumVolume: 0, tvl: 10_000 },
      { ts: 12_000, cumFees: 5, cumVolume: 500, tvl: 10_000 },
    ];
    const m = deriveMetrics(jeune)!;
    expect(isRateReliable(m)).toBe(false);
    // La valeur est tout de même produite : on affiche tôt, on marque.
    expect(m.feeRateUsdPerMin).toBeGreaterThan(0);

    expect(isRateReliable(deriveMetrics(steppy(6, 60))!)).toBe(true);
  });
});
