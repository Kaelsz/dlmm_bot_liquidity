import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getMint, getTransferFeeConfig } from "@solana/spl-token";
import { config } from "../config/config.js";
import { logger } from "../utils/logger.js";
import { getConnection } from "../execution/solana.js";

/**
 * Token-2022 transfer-fee check (live mode only — needs RPC).
 * A transfer tax silently destroys LP profitability: every swap in/out of the
 * pool and every claim pays it. Fail-closed on RPC errors.
 */
export async function checkTransferFee(mint: string): Promise<{ ok: boolean; reason: string }> {
  try {
    const conn = getConnection();
    const mintPk = new PublicKey(mint);
    const info = await conn.getAccountInfo(mintPk);
    if (!info) return { ok: false, reason: "mint account not found" };
    if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return { ok: true, reason: "classic SPL token (no transfer fee extension)" };
    }
    const parsed = await getMint(conn, mintPk, "confirmed", TOKEN_2022_PROGRAM_ID);
    if (parsed.mintAuthority !== null) {
      return { ok: false, reason: "token-2022 mint authority still active" };
    }
    const feeConfig = getTransferFeeConfig(parsed);
    if (!feeConfig) return { ok: true, reason: "token-2022 without transfer fee" };
    const bps = Math.max(
      feeConfig.olderTransferFee.transferFeeBasisPoints,
      feeConfig.newerTransferFee.transferFeeBasisPoints,
    );
    if (bps > config.risk.maxTransferFeeBps) {
      return { ok: false, reason: `transfer fee ${bps}bps > ${config.risk.maxTransferFeeBps}bps` };
    }
    return { ok: true, reason: `transfer fee ${bps}bps within limit` };
  } catch (err) {
    logger.warn({ err, mint }, "transfer fee check failed -> fail-closed");
    return { ok: false, reason: "transfer fee check unavailable (fail-closed)" };
  }
}
