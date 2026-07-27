import { z } from "zod";
import { config } from "../config/config.js";
import { logger } from "../utils/logger.js";
import type { BotDb } from "../db/database.js";

/**
 * RugCheck integration — MANDATORY hard filter, fail-closed.
 *
 * Endpoint (verified live): GET /v1/tokens/{mint}/report/summary
 *   => { tokenProgram, tokenType, risks: [{name, value, description, score, level}], score, score_normalised, lpLockedPct }
 *
 * Higher score = riskier. Any risk item at a configured reject level, or a
 * normalized score above the threshold, rejects the token. If the API is
 * unreachable the token is treated as UNSAFE (never fail-open).
 */

const RugcheckSummarySchema = z.object({
  score: z.number().catch(Number.MAX_SAFE_INTEGER),
  score_normalised: z.number().optional(),
  risks: z
    .array(
      z.object({
        name: z.string().catch("unknown"),
        level: z.string().catch("unknown"),
        description: z.string().catch(""),
      }),
    )
    .catch([]),
});

export interface RugcheckVerdict {
  safe: boolean;
  reason: string;
}

/** Mints considered structurally safe (never queried): SOL + whitelisted stables. */
const TRUSTED_MINTS = new Set<string>(config.risk.quoteWhitelist);

export class RugcheckClient {
  constructor(private readonly db: BotDb) {}

  async check(mint: string): Promise<RugcheckVerdict> {
    if (TRUSTED_MINTS.has(mint)) return { safe: true, reason: "trusted quote mint" };

    const cached = this.db.getRugcheckVerdict(mint, config.risk.rugcheck.cacheTtlMs);
    if (cached) return { safe: cached.verdict === "SAFE", reason: cached.reason ?? "cached" };

    let verdict: RugcheckVerdict;
    try {
      verdict = await this.fetchVerdict(mint);
    } catch (err) {
      logger.warn({ err, mint }, "rugcheck unavailable -> fail-closed");
      verdict = { safe: false, reason: "rugcheck unavailable (fail-closed)" };
      // Cache the failure briefly too, to avoid hammering a downed API.
      this.db.setRugcheckVerdict(mint, "UNSAFE", null, verdict.reason);
      return verdict;
    }
    this.db.setRugcheckVerdict(mint, verdict.safe ? "SAFE" : "UNSAFE", null, verdict.reason);
    return verdict;
  }

  private async fetchVerdict(mint: string): Promise<RugcheckVerdict> {
    const rc = config.risk.rugcheck;
    const res = await fetch(`${rc.baseUrl}/v1/tokens/${mint}/report/summary`, {
      signal: AbortSignal.timeout(rc.requestTimeoutMs),
      headers: { accept: "application/json" },
    });
    if (res.status === 404 || res.status === 400) {
      return { safe: false, reason: `rugcheck has no report (${res.status})` };
    }
    if (!res.ok) throw new Error(`rugcheck HTTP ${res.status}`);
    const parsed = RugcheckSummarySchema.safeParse(await res.json());
    if (!parsed.success) return { safe: false, reason: "rugcheck schema mismatch (fail-closed)" };
    const report = parsed.data;

    const rejectLevels: readonly string[] = rc.rejectLevels;
    const danger = report.risks.find((r) => rejectLevels.includes(r.level.toLowerCase()));
    if (danger) return { safe: false, reason: `rugcheck ${danger.level}: ${danger.name}` };

    const score = report.score_normalised ?? report.score;
    if (score > rc.maxScoreNormalised) {
      return { safe: false, reason: `rugcheck score ${score} > ${rc.maxScoreNormalised}` };
    }
    return { safe: true, reason: `rugcheck score ${score}` };
  }
}
