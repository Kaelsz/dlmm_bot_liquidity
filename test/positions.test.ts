import { describe, expect, it } from "vitest";
import {
  applySnapshot,
  beginTracking,
  closeTracking,
  computeRoi,
  rangeCursor,
  type PositionSnapshot,
} from "../src/data/positions";

const M = 60_000;
const snap = (
  ts: number,
  valueUsd: number,
  totalShares: number,
  claimedFeeUsd = 0,
  unclaimedFeeUsd = 0,
): PositionSnapshot => ({ ts, valueUsd, totalShares, claimedFeeUsd, unclaimedFeeUsd });

describe("suivi d'une position", () => {
  it("prend la première observation comme prix de revient", () => {
    const t = beginTracking(snap(0, 1_000, 100));
    expect(t.depositedUsd).toBe(1_000);
    expect(computeRoi(t, snap(0, 1_000, 100)).roiPct).toBe(0);
  });

  it("compte les fees comme du gain, réclamées ou non", () => {
    const t = beginTracking(snap(0, 1_000, 100));
    const r = computeRoi(t, snap(5 * M, 1_000, 100, 30, 20));
    expect(r.feeUsd).toBe(50);
    expect(r.pnlUsd).toBe(50);
    expect(r.roiPct).toBeCloseTo(5);
  });

  it("ne confond pas une rotation de bins avec un dépôt", () => {
    // Le prix traverse les bins : X se convertit en Y et la valeur bouge, mais
    // les parts de liquidité ne changent pas. Aucun capital n'a été ajouté.
    let t = beginTracking(snap(0, 1_000, 100));
    t = applySnapshot(t, snap(M, 1_200, 100));
    expect(t.depositedUsd).toBe(1_000);
    expect(computeRoi(t, snap(M, 1_200, 100)).roiPct).toBeCloseTo(20);
  });

  it("détecte un apport par la hausse des parts", () => {
    let t = beginTracking(snap(0, 1_000, 100));
    // +50 % de parts pour une position qui vaut alors 1 500 : 500 ajoutés.
    t = applySnapshot(t, snap(M, 1_500, 150));
    expect(t.depositedUsd).toBeCloseTo(1_500);
    // Capital engagé 1 500, valeur 1 500 : le ROI reste nul, pas +50 %.
    expect(computeRoi(t, snap(M, 1_500, 150)).roiPct).toBeCloseTo(0);
  });

  it("détecte un retrait par la baisse des parts", () => {
    let t = beginTracking(snap(0, 1_000, 100));
    t = applySnapshot(t, snap(M, 600, 60)); // 40 % retirés
    expect(t.withdrawnUsd).toBeCloseTo(400);
    expect(computeRoi(t, snap(M, 600, 60)).roiPct).toBeCloseTo(0);
  });

  it("ignore le bruit d'arrondi sur les parts", () => {
    let t = beginTracking(snap(0, 1_000, 1e18));
    t = applySnapshot(t, snap(M, 1_000, 1e18 + 1));
    expect(t.depositedUsd).toBe(1_000);
    expect(t.withdrawnUsd).toBe(0);
  });

  it("fige le ROI à la fermeture au lieu de le faire tomber à -100 %", () => {
    let t = beginTracking(snap(0, 1_000, 100));
    const last = snap(10 * M, 1_100, 100, 80, 0);
    t = closeTracking(t, last);
    // La position ne vaut plus rien, mais tout est sorti.
    const r = computeRoi(t, snap(11 * M, 0, 0, 80, 0));
    expect(r.pnlUsd).toBeCloseTo(180);
    expect(r.roiPct).toBeCloseTo(18);
  });

  it("ne divise pas par zéro sur une position sans capital observé", () => {
    const t = beginTracking(snap(0, 0, 0));
    expect(computeRoi(t, snap(M, 0, 0)).roiPct).toBeNull();
  });

  it("retient la date de première observation, qui qualifie le chiffre", () => {
    const t = beginTracking(snap(1_700_000, 500, 10));
    expect(computeRoi(t, snap(2_000_000, 500, 10)).since).toBe(1_700_000);
  });
});

describe("curseur de plage", () => {
  it("place le bin actif proportionnellement entre les bornes", () => {
    expect(rangeCursor(100, 200, 150).ratio).toBeCloseTo(0.5);
    expect(rangeCursor(100, 200, 125).ratio).toBeCloseTo(0.25);
    expect(rangeCursor(100, 200, 100).ratio).toBe(0);
    expect(rangeCursor(100, 200, 200).ratio).toBe(1);
  });

  it("ne signale aucune sortie tant que le prix est dans la plage, bornes incluses", () => {
    for (const active of [100, 150, 200]) {
      expect(rangeCursor(100, 200, active).outside).toBeNull();
    }
  });

  it("dit de quel côté le prix est sorti et plaque le curseur sur ce bord", () => {
    expect(rangeCursor(100, 200, 99)).toMatchObject({ ratio: 0, outside: "below" });
    expect(rangeCursor(100, 200, 201)).toMatchObject({ ratio: 1, outside: "above" });
  });

  it("borne le curseur même sur un prix très au-delà de la plage", () => {
    expect(rangeCursor(100, 200, -10_000).ratio).toBe(0);
    expect(rangeCursor(100, 200, 10_000).ratio).toBe(1);
  });

  it("avertit quand la position est encore dedans mais près d'un bord", () => {
    expect(rangeCursor(0, 100, 5).nearEdge).toBe(true);
    expect(rangeCursor(0, 100, 95).nearEdge).toBe(true);
    expect(rangeCursor(0, 100, 50).nearEdge).toBe(false);
    // Exactement au seuil de 10 % : encore confortable.
    expect(rangeCursor(0, 100, 10).nearEdge).toBe(false);
  });

  it("ne prévient plus d'un bord proche une fois sorti — la sortie prime", () => {
    expect(rangeCursor(0, 100, -1).nearEdge).toBe(false);
  });

  it("ne divise pas par zéro sur une plage d'un seul bin, et la dit au bord", () => {
    const c = rangeCursor(42, 42, 42);
    expect(c.ratio).toBe(0.5);
    expect(c.outside).toBeNull();
    // Un seul bin : le moindre mouvement fait sortir.
    expect(c.nearEdge).toBe(true);
  });

  it("tolère des bornes inversées plutôt que de rendre NaN", () => {
    expect(rangeCursor(200, 100, 150).ratio).toBeCloseTo(0.5);
  });

  it("retombe au centre sur des valeurs non finies", () => {
    expect(rangeCursor(NaN, 200, 150)).toMatchObject({ ratio: 0.5, outside: null });
  });
});
