import { config } from "../config/config.js";
import type { PoolView } from "../types/datapi.js";
import type { RugcheckClient } from "./rugcheck.js";

/**
 * Hard token/pool eligibility filters — evaluated BEFORE any scoring.
 * Everything here is a rejection reason; the async RugCheck gate runs last
 * (it is the only network call).
 */

export interface EligibilityResult {
  eligible: boolean;
  reason: string;
  /** The non-quote (risky) mint of the pool, if identified. */
  riskyMint: string | null;
  /** True when the pool quotes fees in the quote token only (safer harvest). */
  quoteOnlyFees: boolean;
}

export function staticEligibility(pool: PoolView): EligibilityResult {
  const quoteSet = new Set<string>(config.risk.quoteWhitelist);
  const xIsQuote = quoteSet.has(pool.tokenX.address);
  const yIsQuote = quoteSet.has(pool.tokenY.address);
  const riskyToken = xIsQuote && yIsQuote ? null : xIsQuote ? pool.tokenY : pool.tokenX;
  const base: Omit<EligibilityResult, "eligible" | "reason"> = {
    riskyMint: riskyToken?.address ?? null,
    // DLMM/DAMM v2 collect_fee_mode: 0 = both tokens, 1/2 = quote-only variants.
    quoteOnlyFees: pool.collectFeeMode !== 0,
  };

  const reject = (reason: string): EligibilityResult => ({ ...base, eligible: false, reason });

  if (pool.isBlacklisted) return reject("pool blacklisted by Meteora");
  if (!xIsQuote && !yIsQuote) return reject("no whitelisted quote side (SOL/USDC/USDT)");

  const now = Date.now();
  if (pool.createdAtMs > 0 && now - pool.createdAtMs < config.risk.minPoolAgeMs) {
    return reject(`pool too young (${Math.round((now - pool.createdAtMs) / 60_000)}min)`);
  }

  if (riskyToken) {
    if (!riskyToken.freeze_authority_disabled) return reject("freeze authority still active");
    if (riskyToken.holders < config.risk.minHolders) {
      return reject(`only ${riskyToken.holders} holders < ${config.risk.minHolders}`);
    }
  }

  return { ...base, eligible: true, reason: "ok" };
}

/**
 * Full gate: static filters + mandatory RugCheck (fail-closed) on the risky
 * mint, plus the on-chain Token-2022 transfer-fee check in live mode.
 */
export async function fullEligibility(
  pool: PoolView,
  rugcheck: RugcheckClient,
  checkOnChain = false,
): Promise<EligibilityResult> {
  const staticRes = staticEligibility(pool);
  if (!staticRes.eligible) return staticRes;
  if (staticRes.riskyMint) {
    const verdict = await rugcheck.check(staticRes.riskyMint);
    if (!verdict.safe) return { ...staticRes, eligible: false, reason: verdict.reason };
    if (checkOnChain) {
      const { checkTransferFee } = await import("./token2022.js");
      const fee = await checkTransferFee(staticRes.riskyMint);
      if (!fee.ok) return { ...staticRes, eligible: false, reason: fee.reason };
    }
  }
  return staticRes;
}
