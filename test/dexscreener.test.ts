import { describe, expect, it } from "vitest";
import { MAX_PAIRS, sumTokenVolume, volumePerMinute } from "../src/data/dexscreener";

const MINT = "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump";
const OTHER = "So11111111111111111111111111111111111111112";

const pair = (base: string, m5: number | undefined, dexId = "meteora") => ({
  dexId,
  baseToken: { address: base },
  quoteToken: { address: OTHER },
  volume: { m5 },
});

describe("volume tous DEX d'un token", () => {
  it("somme les paires où le token est en base", () => {
    const v = sumTokenVolume([pair(MINT, 100), pair(MINT, 250, "pumpswap")], MINT, 0);
    expect(v.volumeM5Usd).toBe(350);
    expect(v.pairs).toBe(2);
  });

  it("ignore les paires où le token est la devise de cotation", () => {
    // Sinon le volume d'un token très coté gonflerait de tout ce qui se
    // négocie contre lui.
    const v = sumTokenVolume([pair(MINT, 100), pair(OTHER, 9_999)], MINT, 0);
    expect(v.volumeM5Usd).toBe(100);
    expect(v.pairs).toBe(1);
  });

  it("survit à un volume absent, nul ou aberrant", () => {
    const v = sumTokenVolume(
      [pair(MINT, undefined), pair(MINT, 0), pair(MINT, Number.NaN), pair(MINT, -5), pair(MINT, 42)],
      MINT,
      0,
    );
    expect(v.volumeM5Usd).toBe(42);
  });

  it("signale la troncature quand le plafond de paires est atteint", () => {
    const many = Array.from({ length: MAX_PAIRS }, () => pair(MINT, 10));
    expect(sumTokenVolume(many, MINT, 0).truncated).toBe(true);
    expect(sumTokenVolume(many.slice(0, MAX_PAIRS - 1), MINT, 0).truncated).toBe(false);
  });

  it("compte le plafond sur la réponse entière, pas sur les paires retenues", () => {
    // 30 paires renvoyées dont une seule nous concerne : la somme reste
    // partielle, puisque DexScreener a coupé la liste.
    const mixed = [pair(MINT, 10), ...Array.from({ length: MAX_PAIRS - 1 }, () => pair(OTHER, 10))];
    const v = sumTokenVolume(mixed, MINT, 0);
    expect(v.pairs).toBe(1);
    expect(v.truncated).toBe(true);
  });

  it("rend zéro plutôt que NaN sur une réponse vide", () => {
    const v = sumTokenVolume([], MINT, 0);
    expect(v.volumeM5Usd).toBe(0);
    expect(v.truncated).toBe(false);
  });

  it("convertit la fenêtre de 5 minutes en taux par minute", () => {
    expect(volumePerMinute({ volumeM5Usd: 394_909 })).toBeCloseTo(78_981.8);
    expect(volumePerMinute({ volumeM5Usd: 0 })).toBe(0);
  });
});
