import { describe, expect, it } from "vitest";
import {
  applySnapshot,
  beginTracking,
  closeTracking,
  computeRoi,
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
