import { config } from "../config/config.js";
import type { BotDb, PositionRow } from "../db/database.js";

/**
 * Portfolio-level limits: max open positions, per-token exposure, capital
 * availability. Reads open positions from SQLite so it survives restarts.
 */

export interface PortfolioCheck {
  allowed: boolean;
  reason: string;
  openExposureUsd: number;
}

export function checkPortfolioLimits(
  db: BotDb,
  mode: "PAPER" | "LIVE",
  poolAddress: string,
  riskyMint: string | null,
  riskyMintByPool: (pool: PositionRow) => string | null,
): PortfolioCheck {
  const p = config.risk.portfolio;
  const open = db.openPositions(mode);
  const openExposureUsd = open.reduce((s, r) => s + r.size_usd, 0);

  if (open.length >= p.maxOpenPositions) {
    return { allowed: false, reason: `max open positions (${p.maxOpenPositions})`, openExposureUsd };
  }
  if (open.some((r) => r.pool_address === poolAddress)) {
    return { allowed: false, reason: "already in this pool", openExposureUsd };
  }
  if (riskyMint) {
    const exposure = open
      .filter((r) => riskyMintByPool(r) === riskyMint)
      .reduce((s, r) => s + r.size_usd, 0);
    if (exposure > 0 && exposure >= p.maxExposurePerTokenUsd) {
      return { allowed: false, reason: `token exposure $${exposure} at cap`, openExposureUsd };
    }
  }
  return { allowed: true, reason: "ok", openExposureUsd };
}
