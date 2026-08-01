import { z } from "zod";
import { config } from "@/config";
import { logger } from "@/lib/logger";
import { RateLimiter } from "@/lib/rateLimiter";

/**
 * RugCheck summary client.
 *
 * `GET https://api.rugcheck.xyz/v1/tokens/{mint}/report/summary`
 * Verified live 2026-08-01, ~400ms even on a token minted minutes earlier:
 *
 *   { tokenProgram, tokenType, risks: [{name, value, description, score, level}],
 *     score, score_normalised, lpLockedPct }
 *
 * HIGHER SCORE MEANS RISKIER — this reads backwards from every other rating
 * you have seen, and getting it wrong inverts the entire safety column.
 *
 * The previous project kept only the verdict and threw away `lpLockedPct`,
 * `risks[].value` and `risks[].score`. For a launch, the share of LP locked is
 * the single most informative number available, so everything is retained here
 * and the interpretation is left to the UI.
 */

const RiskSchema = z.object({
  name: z.string().catch(""),
  value: z.string().nullish().catch(null),
  description: z.string().catch(""),
  score: z.number().catch(0),
  level: z.string().catch(""),
});

const SummarySchema = z.object({
  tokenProgram: z.string().nullish().catch(null),
  tokenType: z.string().nullish().catch(null),
  risks: z.array(RiskSchema).catch([]),
  score: z.number().catch(0),
  score_normalised: z.number().nullish().catch(null),
  lpLockedPct: z.number().nullish().catch(null),
});

export interface RugcheckReport {
  mint: string;
  checkedAt: number;
  /** Normalised 0-100 where HIGHER IS RISKIER. Null when RugCheck has no data. */
  score: number | null;
  lpLockedPct: number | null;
  risks: Array<{ name: string; level: string; description: string; score: number }>;
  /** Set when the lookup itself failed, so the UI can show "unknown" rather than "safe". */
  unavailable: boolean;
}

/**
 * Mints we never look up: they are the quote side of nearly every pool, so
 * querying them would burn the whole budget on three well-known tokens.
 */
const TRUSTED_MINTS = new Set<string>([
  "So11111111111111111111111111111111111111112", // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export function isTrustedMint(mint: string): boolean {
  return TRUSTED_MINTS.has(mint);
}

/** RugCheck publishes no rate limit, so stay deliberately gentle. */
const limiter = new RateLimiter(config.rugcheck.maxReqPerSec);

export async function fetchRugcheck(mint: string): Promise<RugcheckReport> {
  const base: RugcheckReport = {
    mint,
    checkedAt: Date.now(),
    score: null,
    lpLockedPct: null,
    risks: [],
    unavailable: true,
  };

  await limiter.acquire();
  try {
    const res = await fetch(`${config.rugcheck.baseUrl}/v1/tokens/${mint}/report/summary`, {
      signal: AbortSignal.timeout(config.rugcheck.requestTimeoutMs),
      headers: { accept: "application/json" },
      cache: "no-store",
    });

    // 404/400 mean RugCheck has genuinely never analysed this mint. That is a
    // real answer — "unknown", not a transport failure — but it is still not a
    // clean bill of health, so it stays flagged as unavailable.
    if (res.status === 404 || res.status === 400) return base;
    if (!res.ok) {
      logger.debug({ mint, status: res.status }, "rugcheck non-ok");
      return base;
    }

    const parsed = SummarySchema.safeParse(await res.json());
    if (!parsed.success) {
      logger.debug({ mint, issues: parsed.error.issues }, "rugcheck parse failed");
      return base;
    }
    const r = parsed.data;
    return {
      mint,
      checkedAt: Date.now(),
      score: r.score_normalised ?? r.score,
      lpLockedPct: r.lpLockedPct ?? null,
      risks: r.risks.map((x) => ({
        name: x.name,
        level: x.level,
        description: x.description,
        score: x.score,
      })),
      unavailable: false,
    };
  } catch (err) {
    logger.debug({ mint, err }, "rugcheck request failed");
    return base;
  }
}

export type SafetyVerdict = "safe" | "caution" | "danger" | "unknown";

/**
 * Collapse a report into one of four buckets for the badge.
 *
 * Deliberately conservative: anything RugCheck flags at danger level is danger
 * regardless of the numeric score, and a missing report is "unknown" rather
 * than being quietly treated as fine.
 */
export function verdictOf(r: RugcheckReport | null | undefined): SafetyVerdict {
  if (!r || r.unavailable || r.score === null) return "unknown";
  if (r.risks.some((x) => x.level.toLowerCase() === "danger")) return "danger";
  if (r.score > config.rugcheck.dangerScore) return "danger";
  if (r.score > config.rugcheck.cautionScore) return "caution";
  return "safe";
}
