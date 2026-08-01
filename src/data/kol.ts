import { config } from "@/config";
import { logger } from "@/lib/logger";
import { RateLimiter } from "@/lib/rateLimiter";
import raw from "@/data/kol-wallets.json";

/**
 * "Which well-known traders hold this token."
 *
 * No API answers this directly. GMGN's own KOL endpoint is a firehose of
 * recent KOL trades with no token parameter, so even with their key the
 * reverse lookup has to be built. We build it the other way round, which is
 * cheaper and does not depend on a vendor: keep a labelled wallet list, then
 * intersect it with the actual holders of the handful of tokens on screen.
 *
 * READ THIS BEFORE PUTTING IT NEXT TO THE SAFETY COLUMN: a KOL holding a token
 * is an ATTENTION signal, not a safety one. Paid promotion is routine on
 * Solana memecoins, and a KOL entry is frequently the distribution event
 * rather than an endorsement. It belongs with momentum, and the UI says so.
 *
 * The list is committed to the repo (refresh with scripts/fetch-kol-list.mjs)
 * so a rendering path never depends on a third-party page being reachable.
 */

export interface KolWallet {
  wallet: string;
  name: string;
  twitter: string | null;
}

const LIST = raw as { source: string; fetchedAt: string; count: number; wallets: KolWallet[] };

/** Wallet address -> label. Built once per process. */
const BY_WALLET: Map<string, KolWallet> = new Map(LIST.wallets.map((w) => [w.wallet, w]));

export const kolListInfo = {
  source: LIST.source,
  fetchedAt: LIST.fetchedAt,
  count: BY_WALLET.size,
};

export function kolFor(wallet: string): KolWallet | undefined {
  return BY_WALLET.get(wallet);
}

export interface KolHolder {
  wallet: string;
  name: string;
  twitter: string | null;
  /** Raw token amount; decimals are not applied because only ranking matters. */
  amount: number;
}

const limiter = new RateLimiter(config.helius.maxReqPerSec);

export function heliusConfigured(): boolean {
  return config.helius.apiKey.length > 0;
}

interface TokenAccount {
  owner: string;
  amount: number;
}

/**
 * All holders of a mint, via Helius DAS.
 *
 * `getTokenLargestAccounts` on a plain RPC would be one call, but it returns
 * only the top 20 — a KOL holding a small bag would be invisible, which is
 * exactly the case worth catching. DAS paginates the full holder set instead;
 * verified returning 574 owners for a token where the RPC would have shown 20.
 */
async function fetchHolders(mint: string): Promise<TokenAccount[] | undefined> {
  if (!heliusConfigured()) return undefined;
  const url = config.helius.rpcUrl(config.helius.apiKey);
  const out: TokenAccount[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < config.helius.maxHolderPages; page += 1) {
    await limiter.acquire();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(config.helius.requestTimeoutMs),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "kol",
          method: "getTokenAccounts",
          params: {
            mint,
            limit: config.helius.holderPageSize,
            ...(cursor ? { cursor } : {}),
            options: { showZeroBalance: false },
          },
        }),
      });
      if (!res.ok) {
        logger.debug({ mint, status: res.status }, "helius non-ok");
        return out.length > 0 ? out : undefined;
      }
      const json = (await res.json()) as {
        error?: unknown;
        result?: { token_accounts?: Array<{ owner?: string; amount?: number }>; cursor?: string };
      };
      if (json.error) {
        logger.debug({ mint, err: json.error }, "helius error");
        return out.length > 0 ? out : undefined;
      }
      const accounts = json.result?.token_accounts ?? [];
      for (const a of accounts) {
        if (a.owner) out.push({ owner: a.owner, amount: Number(a.amount ?? 0) });
      }
      cursor = json.result?.cursor;
      if (!cursor || accounts.length === 0) break;
    } catch (err) {
      logger.debug({ mint, err }, "helius request failed");
      return out.length > 0 ? out : undefined;
    }
  }
  return out;
}

export interface KolScan {
  mint: string;
  scannedAt: number;
  holders: KolHolder[];
  /** Total distinct owners seen — context for how thorough the scan was. */
  totalHolders: number;
  /** True when the lookup could not run at all (no key, or upstream failure). */
  unavailable: boolean;
}

/** Intersect the labelled wallet list with a token's actual holders. */
export async function scanKols(mint: string): Promise<KolScan> {
  const accounts = await fetchHolders(mint);
  if (!accounts) {
    return { mint, scannedAt: Date.now(), holders: [], totalHolders: 0, unavailable: true };
  }

  // One owner can hold through several token accounts; sum them.
  const byOwner = new Map<string, number>();
  for (const a of accounts) byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0) + a.amount);

  const holders: KolHolder[] = [];
  for (const [owner, amount] of byOwner) {
    const kol = BY_WALLET.get(owner);
    if (kol) holders.push({ wallet: owner, name: kol.name, twitter: kol.twitter, amount });
  }
  holders.sort((a, b) => b.amount - a.amount);

  return {
    mint,
    scannedAt: Date.now(),
    holders,
    totalHolders: byOwner.size,
    unavailable: false,
  };
}
