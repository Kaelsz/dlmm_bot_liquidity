import { describe, expect, it } from "vitest";
import { isTrustedMint, verdictOf, type RugcheckReport } from "../src/data/rugcheck";
import { config } from "../src/config";
import { riskyMintOf } from "../src/lib/api-types";

const report = (over: Partial<RugcheckReport> = {}): RugcheckReport => ({
  mint: "mint",
  checkedAt: Date.now(),
  score: 0,
  lpLockedPct: 100,
  risks: [],
  unavailable: false,
  ...over,
});

describe("verdictOf", () => {
  it("treats a missing report as unknown, never as safe", () => {
    expect(verdictOf(null)).toBe("unknown");
    expect(verdictOf(undefined)).toBe("unknown");
    // A failed lookup carries no information — it must not read as a pass.
    expect(verdictOf(report({ unavailable: true }))).toBe("unknown");
    expect(verdictOf(report({ score: null }))).toBe("unknown");
  });

  it("reads the score as higher = riskier", () => {
    expect(verdictOf(report({ score: 1 }))).toBe("safe");
    expect(verdictOf(report({ score: config.rugcheck.cautionScore + 1 }))).toBe("caution");
    expect(verdictOf(report({ score: config.rugcheck.dangerScore + 1 }))).toBe("danger");
  });

  it("lets any danger-level risk override a low score", () => {
    const r = report({
      score: 0,
      risks: [{ name: "Top 10 holders high ownership", level: "danger", description: "", score: 0 }],
    });
    expect(verdictOf(r)).toBe("danger");
  });

  it("is case-insensitive on the risk level", () => {
    const r = report({ risks: [{ name: "x", level: "DANGER", description: "", score: 0 }] });
    expect(verdictOf(r)).toBe("danger");
  });

  it("ignores non-danger risk levels", () => {
    const r = report({ risks: [{ name: "x", level: "warn", description: "", score: 0 }] });
    expect(verdictOf(r)).toBe("safe");
  });

  it("puts the thresholds in the expected order", () => {
    expect(config.rugcheck.cautionScore).toBeLessThan(config.rugcheck.dangerScore);
  });
});

describe("isTrustedMint", () => {
  it("skips the three quote tokens that appear in nearly every pool", () => {
    expect(isTrustedMint("So11111111111111111111111111111111111111112")).toBe(true);
    expect(isTrustedMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(true);
    expect(isTrustedMint("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")).toBe(true);
  });

  it("does not trust anything else", () => {
    expect(isTrustedMint("HhMq9vuWEntyUXFLv25xG2o3d2m8gJ1jdxtjG2J6pump")).toBe(false);
  });
});

describe("riskyMintOf", () => {
  const SOL = "So11111111111111111111111111111111111111112";
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const TOKEN = "HhMq9vuWEntyUXFLv25xG2o3d2m8gJ1jdxtjG2J6pump";

  it("picks token_y when token_x is the quote", () => {
    // SOL-CTO: Meteora does not normalise the order.
    expect(riskyMintOf({ tokenXMint: SOL, tokenYMint: TOKEN })).toBe(TOKEN);
  });

  it("picks token_x in the usual orientation", () => {
    expect(riskyMintOf({ tokenXMint: TOKEN, tokenYMint: SOL })).toBe(TOKEN);
  });

  it("falls back to token_x when both sides are trusted", () => {
    expect(riskyMintOf({ tokenXMint: SOL, tokenYMint: USDC })).toBe(SOL);
  });
});
