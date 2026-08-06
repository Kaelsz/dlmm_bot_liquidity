import { describe, expect, it } from "vitest";
import {
  SPOT_BINS,
  STRATEGY_TYPE,
  spot70SolSided,
  strategyById,
  STRATEGIES,
} from "../src/strategies";

describe("spot 70 bins, SOL seul", () => {
  it("occupe exactement 70 bins, bornes comprises", () => {
    for (const solIsX of [true, false]) {
      const p = spot70SolSided.plan({ activeBinId: 1_000, solIsX });
      expect(p.maxBinId - p.minBinId + 1).toBe(SPOT_BINS);
      expect(p.binCount).toBe(SPOT_BINS);
    }
  });

  it("descend sous le prix quand SOL est le token Y", () => {
    // Cas courant : paire TOKEN-SOL. Les bins sous l'actif ne contiennent que
    // du Y, donc un dépôt en SOL seul ne peut aller que là.
    const p = spot70SolSided.plan({ activeBinId: 1_000, solIsX: false });
    expect(p.minBinId).toBe(931);
    expect(p.maxBinId).toBe(1_000);
    expect(p.depositSide).toBe("y");
  });

  it("monte au-dessus du prix quand SOL est le token X", () => {
    // La géométrie s'inverse, l'économie non : on accumule toujours le token
    // à mesure qu'il devient moins cher face au SOL.
    const p = spot70SolSided.plan({ activeBinId: 1_000, solIsX: true });
    expect(p.minBinId).toBe(1_000);
    expect(p.maxBinId).toBe(1_069);
    expect(p.depositSide).toBe("x");
  });

  it("inclut toujours le bin actif — sinon la position démarre déjà morte", () => {
    for (const solIsX of [true, false]) {
      const p = spot70SolSided.plan({ activeBinId: -42, solIsX });
      expect(p.minBinId).toBeLessThanOrEqual(-42);
      expect(p.maxBinId).toBeGreaterThanOrEqual(-42);
    }
  });

  it("fait suivre singleSidedX au côté déposé", () => {
    // Le bin actif est le seul à pouvoir contenir les deux tokens : le
    // privilégier du mauvais côté l'alimenterait dans une devise absente.
    expect(spot70SolSided.plan({ activeBinId: 0, solIsX: true }).singleSidedX).toBe(true);
    expect(spot70SolSided.plan({ activeBinId: 0, solIsX: false }).singleSidedX).toBe(false);
  });

  it("reste juste sur des bins négatifs", () => {
    const p = spot70SolSided.plan({ activeBinId: -1_074, solIsX: false });
    expect(p.minBinId).toBe(-1_143);
    expect(p.maxBinId).toBe(-1_074);
  });

  it("demande une répartition uniforme", () => {
    expect(spot70SolSided.plan({ activeBinId: 0, solIsX: false }).strategyType).toBe(
      STRATEGY_TYPE.Spot,
    );
  });
});

describe("registre des stratégies", () => {
  it("retrouve une stratégie par son identifiant", () => {
    expect(strategyById("spot70-sol")).toBe(spot70SolSided);
    expect(strategyById("inconnue")).toBeUndefined();
  });

  it("n'expose que des identifiants uniques", () => {
    const ids = STRATEGIES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
