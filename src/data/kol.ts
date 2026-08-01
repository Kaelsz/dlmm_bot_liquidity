import { config } from "@/config";
import { logger } from "@/lib/logger";
import { RateLimiter } from "@/lib/rateLimiter";
import raw from "@/data/kol-wallets.json";

/**
 * "Which well-known traders hold this token."
 *
 * No API answers this directly — GMGN's own KOL endpoint is a firehose of
 * recent trades with no token parameter, so even with their key the reverse
 * lookup has to be built. We build it by inverting the relation.
 *
 * WHY INVERTED, AND NOT BY LISTING EACH TOKEN'S HOLDERS
 *
 * The obvious approach — for each displayed token, fetch its holders and
 * intersect with the wallet list — was the first implementation and it was
 * quietly wrong. Holder lists are unbounded and Helius returns them in no
 * particular order, so any page cap samples an ARBITRARY subset rather than
 * the top of the book. Measured on ANSEM: capped at 2000 accounts it reported
 * 2 KOLs; the full walk found 59,809 holders and 20 KOLs. A tenfold
 * undercount, and worse, one that looked plausible.
 *
 * Walking every token fully is not an option either: ANSEM alone took 60
 * requests and 6.6 seconds.
 *
 * Going the other way is bounded and exact. Each wallet's holdings come back
 * in a SINGLE getTokenAccountsByOwner call with no pagination, so one pass
 * over the list is ~553 requests and yields an accurate index for the entire
 * market at once — including tokens nobody is looking at yet.
 *
 * READ THIS BEFORE MOVING IT NEXT TO THE SAFETY COLUMN: a KOL holding a token
 * is an ATTENTION signal, not a safety one. Paid promotion is routine on
 * Solana memecoins, and a KOL entry is frequently the distribution event
 * rather than an endorsement.
 */

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export interface KolWallet {
  wallet: string;
  name: string;
  twitter: string | null;
}

const LIST = raw as { source: string; fetchedAt: string; count: number; wallets: KolWallet[] };

export const kolListInfo = {
  source: LIST.source,
  fetchedAt: LIST.fetchedAt,
  count: LIST.wallets.length,
};

export interface KolHolder {
  wallet: string;
  name: string;
  twitter: string | null;
  /** UI amount, decimals applied. Used only to rank holders within a token. */
  amount: number;
}

const limiter = new RateLimiter(config.helius.maxReqPerSec);

export function heliusConfigured(): boolean {
  return config.helius.apiKey.length > 0;
}

interface ParsedTokenAccount {
  account?: {
    data?: {
      parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number | null } } };
    };
  };
}

/** Every mint a wallet currently holds a non-zero balance of. */
async function holdingsOf(wallet: string): Promise<Map<string, number> | undefined> {
  const url = config.helius.rpcUrl(config.helius.apiKey);
  const held = new Map<string, number>();

  // Token-2022 lives in a separate program and is invisible to a query on the
  // original one. It doubles the request count for a standard that almost no
  // memecoin uses, so it can be switched off on a tight quota.
  const programs = config.kol.includeToken2022
    ? [SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM]
    : [SPL_TOKEN_PROGRAM];
  for (const programId of programs) {
    await limiter.acquire();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(config.helius.requestTimeoutMs),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "kol",
          method: "getTokenAccountsByOwner",
          params: [wallet, { programId }, { encoding: "jsonParsed" }],
        }),
      });
      if (!res.ok) {
        logger.debug({ wallet, status: res.status }, "helius non-ok");
        return held.size > 0 ? held : undefined;
      }
      const json = (await res.json()) as { error?: unknown; result?: { value?: ParsedTokenAccount[] } };
      if (json.error) {
        logger.debug({ wallet, err: json.error }, "helius error");
        return held.size > 0 ? held : undefined;
      }
      for (const acc of json.result?.value ?? []) {
        const info = acc.account?.data?.parsed?.info;
        const mint = info?.mint;
        const amount = info?.tokenAmount?.uiAmount ?? 0;
        if (mint && amount > 0) held.set(mint, (held.get(mint) ?? 0) + amount);
      }
    } catch (err) {
      logger.debug({ wallet, err }, "helius request failed");
      return held.size > 0 ? held : undefined;
    }
  }
  return held;
}

export interface KolIndex {
  /** mint -> the labelled wallets holding it, richest first. */
  byMint: Map<string, KolHolder[]>;
  walletsScanned: number;
  walletsFailed: number;
  builtAt: number;
}

/**
 * One full pass over the wallet list, producing the mint -> KOLs index.
 *
 * Bounded work: exactly two requests per wallet regardless of how much they
 * hold. Runs with modest concurrency so a full refresh takes tens of seconds
 * rather than minutes, while the token bucket keeps the request rate gentle.
 */
/** Requests one full pass costs — surfaced on /api/health for quota planning. */
export function requestsPerPass(): number {
  return LIST.wallets.length * (config.kol.includeToken2022 ? 2 : 1);
}

export async function buildKolIndex(): Promise<KolIndex> {
  const byMint = new Map<string, KolHolder[]>();
  let scanned = 0;
  let failed = 0;

  const queue = [...LIST.wallets];
  const concurrency = Math.max(1, config.kol.concurrency);

  const worker = async (): Promise<void> => {
    for (;;) {
      const w = queue.shift();
      if (!w) return;
      const held = await holdingsOf(w.wallet);
      if (!held) {
        failed += 1;
        continue;
      }
      scanned += 1;
      for (const [mint, amount] of held) {
        const list = byMint.get(mint);
        const entry: KolHolder = { wallet: w.wallet, name: w.name, twitter: w.twitter, amount };
        if (list) list.push(entry);
        else byMint.set(mint, [entry]);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  for (const list of byMint.values()) list.sort((a, b) => b.amount - a.amount);

  return { byMint, walletsScanned: scanned, walletsFailed: failed, builtAt: Date.now() };
}
