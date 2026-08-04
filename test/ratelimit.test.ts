import { describe, expect, it, vi, afterEach } from "vitest";
import { clientKey, rateLimit } from "../src/lib/ratelimit";

afterEach(() => vi.useRealTimers());

describe("rateLimit", () => {
  it("laisse passer jusqu'au plafond puis refuse", () => {
    const k = `k${Math.random()}`;
    for (let i = 0; i < 3; i += 1) expect(rateLimit(k, 3, 60_000).allowed).toBe(true);
    const r = rateLimit(k, 3, 60_000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSec).toBeGreaterThan(0);
  });

  it("rouvre après la fenêtre", () => {
    vi.useFakeTimers();
    const k = `k${Math.random()}`;
    expect(rateLimit(k, 1, 1_000).allowed).toBe(true);
    expect(rateLimit(k, 1, 1_000).allowed).toBe(false);
    vi.advanceTimersByTime(1_100);
    expect(rateLimit(k, 1, 1_000).allowed).toBe(true);
  });

  it("compte séparément deux appelants", () => {
    const a = `a${Math.random()}`;
    const b = `b${Math.random()}`;
    expect(rateLimit(a, 1, 60_000).allowed).toBe(true);
    expect(rateLimit(a, 1, 60_000).allowed).toBe(false);
    // Le seau de a est plein, celui de b est intact.
    expect(rateLimit(b, 1, 60_000).allowed).toBe(true);
  });
});

describe("clientKey", () => {
  it("prend le client d'origine derrière le proxy", () => {
    const req = new Request("http://x/", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(clientKey(req)).toBe("203.0.113.7");
  });

  it("se rabat sur un seau commun sans en-tête — plus strict, jamais plus permissif", () => {
    expect(clientKey(new Request("http://x/"))).toBe("inconnu");
  });
});
