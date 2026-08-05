import { describe, expect, it } from "vitest";
import { fmtAmountInput, parseAmount } from "../src/lib/format";

describe("parseAmount", () => {
  it("distingue champ vide et saisie invalide", () => {
    // null = pas de filtre ; undefined = faute de frappe. Les confondre
    // désactiverait le filtre en silence sur une erreur de saisie.
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("   ")).toBeNull();
    expect(parseAmount("abc")).toBeUndefined();
    expect(parseAmount("5kk")).toBeUndefined();
    expect(parseAmount("-500")).toBeUndefined();
  });

  it("accepte les suffixes k et M, quelle que soit la casse", () => {
    expect(parseAmount("5k")).toBe(5_000);
    expect(parseAmount("5K")).toBe(5_000);
    expect(parseAmount("1.5M")).toBe(1_500_000);
    expect(parseAmount("2m")).toBe(2_000_000);
  });

  it("tolère le symbole dollar et les séparateurs de milliers", () => {
    expect(parseAmount("$50000")).toBe(50_000);
    expect(parseAmount("$50 000")).toBe(50_000);
    expect(parseAmount("50 000")).toBe(50_000);
    expect(parseAmount("50,000")).toBe(50_000);
  });

  it("accepte la virgule décimale française", () => {
    expect(parseAmount("1,5k")).toBe(1_500);
  });

  it("accepte le suffixe milliard, indispensable au filtre Market Cap", () => {
    expect(parseAmount("1B")).toBe(1_000_000_000);
    expect(parseAmount("2.5b")).toBe(2_500_000_000);
    expect(parseAmount("$43B")).toBe(43_000_000_000);
  });

  it("accepte zéro", () => {
    expect(parseAmount("0")).toBe(0);
  });
});

describe("fmtAmountInput", () => {
  it("produit une forme qu'on peut retaper telle quelle", () => {
    for (const v of [0, 500, 5_000, 50_000, 1_500_000, 1_000_000_000, 43_000_000_000]) {
      expect(parseAmount(fmtAmountInput(v))).toBe(v);
    }
  });

  it("rend une chaîne vide quand il n'y a pas de filtre", () => {
    expect(fmtAmountInput(null)).toBe("");
  });
});
