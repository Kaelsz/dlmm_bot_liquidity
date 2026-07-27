import { createRequire } from "node:module";
import type { LbPosition } from "@meteora-ag/dlmm";
import { Keypair, PublicKey } from "@solana/web3.js";

// The DLMM package's ESM build has broken directory imports (anchor), so we
// load the CJS build. Its interop makes module.exports the DLMM class itself,
// with named exports (StrategyType, ...) attached to it.
const cjsRequire = createRequire(import.meta.url);
type DlmmNs = typeof import("@meteora-ag/dlmm");
type DlmmClass = DlmmNs["default"];
type DlmmInstance = InstanceType<DlmmClass>;
const DLMM = cjsRequire("@meteora-ag/dlmm") as DlmmClass & Omit<DlmmNs, "default">;
const { StrategyType } = DLMM;
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { config } from "../config/config.js";
import { logger } from "../utils/logger.js";
import type { Protocol } from "../types/datapi.js";
import { getConnection, getWallet, sendAndConfirm } from "./solana.js";
import type {
  ClaimResult,
  ClosePositionResult,
  IPositionExecutor,
  LivePositionStatus,
  MarketFeedFn,
  OpenPositionParams,
  OpenPositionResult,
} from "./types.js";

const LAMPORTS_PER_SOL_USD_FALLBACK = 150;

/**
 * Live DLMM executor: SPOT position around the active bin, periodic fee
 * claims, claim-and-close on exit. Wallet must hold the deposited tokens
 * (balanced when possible, single-sided otherwise).
 */
export class DlmmExecutor implements IPositionExecutor {
  readonly mode = "LIVE" as const;
  private readonly pools = new Map<string, DlmmInstance>();

  constructor(private readonly feed: MarketFeedFn) {}

  private async dlmm(poolAddress: string): Promise<DlmmInstance> {
    const cached = this.pools.get(poolAddress);
    if (cached) return cached;
    const instance = await DLMM.create(getConnection(), new PublicKey(poolAddress), {
      cluster: "mainnet-beta",
    });
    this.pools.set(poolAddress, instance);
    return instance;
  }

  async open(params: OpenPositionParams): Promise<OpenPositionResult> {
    const wallet = getWallet();
    const dlmm = await this.dlmm(params.poolAddress);
    await dlmm.refetchStates();
    const activeBin = await dlmm.getActiveBin();
    const minBinId = activeBin.binId - params.binRange;
    const maxBinId = activeBin.binId + params.binRange;

    // Desired 50/50 USD split, capped by what the wallet actually holds.
    const desiredX = this.toRaw(params.sizeUsd / 2 / Math.max(params.tokenX.priceUsd, 1e-12), params.tokenX.decimals);
    const desiredY = this.toRaw(params.sizeUsd / 2 / Math.max(params.tokenY.priceUsd, 1e-12), params.tokenY.decimals);
    const [availX, availY] = await Promise.all([
      this.walletBalance(wallet.publicKey, params.tokenX.mint, params.tokenX.decimals),
      this.walletBalance(wallet.publicKey, params.tokenY.mint, params.tokenY.decimals),
    ]);
    const totalXAmount = BN.min(desiredX, availX);
    const totalYAmount = BN.min(desiredY, availY);
    if (totalXAmount.isZero() && totalYAmount.isZero()) {
      throw new Error("wallet holds neither pool token — cannot open DLMM position");
    }

    const positionKeypair = Keypair.generate();
    const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: { minBinId, maxBinId, strategyType: StrategyType.Spot },
      user: wallet.publicKey,
      slippage: config.position.costs.slippageFraction * 100,
    });
    const result = await sendAndConfirm(tx, [wallet, positionKeypair], `dlmm-open:${params.poolName}`);
    logger.info(
      { pool: params.poolName, position: positionKeypair.publicKey.toBase58(), tx: result.signature },
      "[LIVE] DLMM position opened",
    );
    return {
      positionAddress: positionKeypair.publicKey.toBase58(),
      txSignature: result.signature,
      openCostUsd: this.lamportsToUsd(result.feeLamports),
    };
  }

  async status(protocol: Protocol, poolAddress: string, positionAddress: string): Promise<LivePositionStatus> {
    const snap = await this.feed(protocol, poolAddress);
    const position = await this.findPosition(poolAddress, positionAddress);
    const d = position.positionData;
    const xUi = Number(d.totalXAmount) / 10 ** snap.tokenXDecimals;
    const yUi = Number(d.totalYAmount) / 10 ** snap.tokenYDecimals;
    const feeXUi = Number(d.feeX.toString()) / 10 ** snap.tokenXDecimals;
    const feeYUi = Number(d.feeY.toString()) / 10 ** snap.tokenYDecimals;
    const dlmm = await this.dlmm(poolAddress);
    const activeBin = await dlmm.getActiveBin();
    return {
      positionValueUsd: xUi * snap.tokenXPriceUsd + yUi * snap.tokenYPriceUsd,
      unclaimedFeesUsd: feeXUi * snap.tokenXPriceUsd + feeYUi * snap.tokenYPriceUsd,
      currentPrice: snap.price,
      inRange: activeBin.binId >= d.lowerBinId && activeBin.binId <= d.upperBinId,
    };
  }

  async claim(protocol: Protocol, poolAddress: string, positionAddress: string): Promise<ClaimResult> {
    const wallet = getWallet();
    const snap = await this.feed(protocol, poolAddress);
    const position = await this.findPosition(poolAddress, positionAddress);
    const feeXUi = Number(position.positionData.feeX.toString()) / 10 ** snap.tokenXDecimals;
    const feeYUi = Number(position.positionData.feeY.toString()) / 10 ** snap.tokenYDecimals;
    const claimedUsd = feeXUi * snap.tokenXPriceUsd + feeYUi * snap.tokenYPriceUsd;
    if (claimedUsd <= 0.01) return { claimedUsd: 0, txSignature: null };

    const dlmm = await this.dlmm(poolAddress);
    const txs = await dlmm.claimSwapFee({ owner: wallet.publicKey, position });
    let lastSig: string | null = null;
    for (const tx of txs) {
      const r = await sendAndConfirm(tx, [wallet], `dlmm-claim:${positionAddress.slice(0, 8)}`);
      lastSig = r.signature;
    }
    return { claimedUsd, txSignature: lastSig };
  }

  async close(protocol: Protocol, poolAddress: string, positionAddress: string): Promise<ClosePositionResult> {
    const wallet = getWallet();
    const snap = await this.feed(protocol, poolAddress);
    const position = await this.findPosition(poolAddress, positionAddress);
    const d = position.positionData;
    const xUi = Number(d.totalXAmount) / 10 ** snap.tokenXDecimals;
    const yUi = Number(d.totalYAmount) / 10 ** snap.tokenYDecimals;
    const feeXUi = Number(d.feeX.toString()) / 10 ** snap.tokenXDecimals;
    const feeYUi = Number(d.feeY.toString()) / 10 ** snap.tokenYDecimals;

    const dlmm = await this.dlmm(poolAddress);
    const txs = await dlmm.removeLiquidity({
      user: wallet.publicKey,
      position: position.publicKey,
      fromBinId: d.lowerBinId,
      toBinId: d.upperBinId,
      bps: new BN(10_000),
      shouldClaimAndClose: true,
    });
    let lastSig: string | null = null;
    let feeLamports = 0;
    for (const tx of txs) {
      const r = await sendAndConfirm(tx, [wallet], `dlmm-close:${positionAddress.slice(0, 8)}`);
      lastSig = r.signature;
      feeLamports += r.feeLamports ?? 0;
    }
    logger.info({ position: positionAddress, tx: lastSig }, "[LIVE] DLMM position closed");
    return {
      txSignature: lastSig,
      recoveredUsd: xUi * snap.tokenXPriceUsd + yUi * snap.tokenYPriceUsd,
      claimedUsd: feeXUi * snap.tokenXPriceUsd + feeYUi * snap.tokenYPriceUsd,
      closeCostUsd: this.lamportsToUsd(feeLamports),
    };
  }

  private async findPosition(poolAddress: string, positionAddress: string): Promise<LbPosition> {
    const wallet = getWallet();
    const dlmm = await this.dlmm(poolAddress);
    const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
    const found = userPositions.find((p) => p.publicKey.toBase58() === positionAddress);
    if (!found) throw new Error(`DLMM position ${positionAddress} not found on-chain`);
    return found;
  }

  private async walletBalance(owner: PublicKey, mint: string, decimals: number): Promise<BN> {
    const conn = getConnection();
    try {
      const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, true);
      const bal = await conn.getTokenAccountBalance(ata);
      return new BN(bal.value.amount);
    } catch {
      // wSOL: fall back to native balance minus the reserve buffer.
      if (mint === "So11111111111111111111111111111111111111112") {
        const lamports = await conn.getBalance(owner);
        const reserve = Math.floor(config.risk.portfolio.reserveSol * 1e9);
        return new BN(Math.max(0, lamports - reserve));
      }
      return new BN(0);
    }
  }

  private toRaw(uiAmount: number, decimals: number): BN {
    return new BN(Math.floor(Math.max(0, uiAmount) * 10 ** decimals).toString());
  }

  private lamportsToUsd(lamports: number | null): number {
    const fallback = config.position.costs.openUsd;
    if (lamports === null) return fallback;
    return (lamports / 1e9) * LAMPORTS_PER_SOL_USD_FALLBACK;
  }
}
