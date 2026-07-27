import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type Commitment,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { config } from "../config/config.js";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/time.js";

/**
 * Production Solana plumbing: connection management, wallet loading,
 * dynamic priority fees, simulate-before-send, retry with blockhash
 * re-fetch, confirmed → finalized verification.
 */

let _connection: Connection | null = null;
let _sendConnection: Connection | null = null;
let _wallet: Keypair | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(config.solana.rpcUrl, {
      commitment: config.solana.commitment,
      disableRetryOnRateLimit: false,
    });
  }
  return _connection;
}

export function getSendConnection(): Connection {
  if (!_sendConnection) {
    _sendConnection =
      config.solana.rpcSendUrl === config.solana.rpcUrl
        ? getConnection()
        : new Connection(config.solana.rpcSendUrl, { commitment: config.solana.commitment });
  }
  return _sendConnection;
}

export function getWallet(): Keypair {
  if (_wallet) return _wallet;
  const { walletKeypairPath, walletSecretKeyB58 } = config.solana;
  if (walletKeypairPath) {
    const raw = JSON.parse(readFileSync(walletKeypairPath, "utf8")) as number[];
    _wallet = Keypair.fromSecretKey(Uint8Array.from(raw));
  } else if (walletSecretKeyB58) {
    _wallet = Keypair.fromSecretKey(base58Decode(walletSecretKeyB58));
  } else {
    throw new Error(
      "No wallet configured. Set WALLET_KEYPAIR_PATH or WALLET_SECRET_KEY_B58 (required when DRY_RUN=false).",
    );
  }
  logger.info({ pubkey: _wallet.publicKey.toBase58() }, "wallet loaded");
  return _wallet;
}

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const i = B58_ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("invalid base58 character");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}

/** Median of recent prioritization fees, scaled and capped. */
export async function getPriorityFeeMicroLamports(writableAccounts: PublicKey[] = []): Promise<number> {
  try {
    const fees = await getConnection().getRecentPrioritizationFees({
      lockedWritableAccounts: writableAccounts.slice(0, 32),
    });
    const values = fees.map((f) => f.prioritizationFee).filter((v) => v > 0).sort((a, b) => a - b);
    if (values.length === 0) return 10_000;
    const median = values[Math.floor(values.length / 2)] ?? 10_000;
    return Math.min(
      config.solana.maxPriorityFeeMicroLamports,
      Math.max(10_000, Math.ceil(median * config.solana.priorityFeeMultiplier)),
    );
  } catch (err) {
    logger.warn({ err }, "priority fee lookup failed, using floor");
    return 50_000;
  }
}

export interface SendResult {
  signature: string;
  /** Lamports actually paid in fees, when retrievable. */
  feeLamports: number | null;
}

/**
 * Simulate, sign, send and confirm a legacy Transaction. Retries with fresh
 * blockhash on transient failures. Throws when simulation fails.
 */
export async function sendAndConfirm(
  tx: Transaction,
  signers: Keypair[],
  label: string,
): Promise<SendResult> {
  const conn = getConnection();
  const sendConn = getSendConnection();
  const payer = signers[0];
  if (!payer) throw new Error("sendAndConfirm requires at least one signer");

  const priorityFee = await getPriorityFeeMicroLamports(
    tx.instructions.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey)),
  );
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: config.solana.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
  );

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= config.solana.sendMaxRetries; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = payer.publicKey;
      tx.signatures = [];
      tx.sign(...signers);

      const sim = await conn.simulateTransaction(tx);
      if (sim.value.err) {
        throw new NonRetryableTxError(
          `simulation failed for ${label}: ${JSON.stringify(sim.value.err)} logs=${(sim.value.logs ?? []).slice(-5).join(" | ")}`,
        );
      }

      const signature = await sendConn.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });
      logger.info({ label, signature, attempt, priorityFee }, "tx sent");

      const confirmation = await conn.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      if (confirmation.value.err) {
        throw new Error(`tx ${signature} failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      }

      const feeLamports = await fetchFee(conn, signature);
      return { signature, feeLamports };
    } catch (err) {
      if (err instanceof NonRetryableTxError) throw err;
      lastError = err;
      logger.warn({ err, label, attempt }, "send attempt failed, retrying");
      await sleep(1_000 * attempt);
    }
  }
  throw new Error(`sendAndConfirm(${label}) exhausted retries: ${String(lastError)}`);
}

async function fetchFee(conn: Connection, signature: string): Promise<number | null> {
  try {
    const info = await conn.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return info?.meta?.fee ?? null;
  } catch {
    return null;
  }
}

/** Verify a signature reached finalized commitment (used before final accounting). */
export async function verifyFinalized(signature: string, timeoutMs = 90_000): Promise<boolean> {
  const conn = getConnection();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await conn.getSignatureStatuses([signature]);
    const s = st.value[0];
    if (s?.confirmationStatus === "finalized") return true;
    if (s?.err) return false;
    await sleep(2_000);
  }
  return false;
}

export class NonRetryableTxError extends Error {}

export type { Commitment };
