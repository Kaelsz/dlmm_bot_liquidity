import {
  CpAmm,
  getCurrentPoint,
  getTokenProgram,
  getUnClaimLpFee,
  type PoolState,
  type PositionState,
} from "@meteora-ag/cp-amm-sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
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

const SOL_USD_FALLBACK = 150;

/**
 * Live DAMM v2 executor. Positions are NFTs; liquidity is (semi-)concentrated
 * at pool level, so "range" here is the pool's own price range — entry/exit
 * timing and the fee scheduler read are what the strategy exploits.
 */
export class DammV2Executor implements IPositionExecutor {
  readonly mode = "LIVE" as const;
  private cpAmm: CpAmm | null = null;

  constructor(private readonly feed: MarketFeedFn) {}

  private amm(): CpAmm {
    if (!this.cpAmm) this.cpAmm = new CpAmm(getConnection());
    return this.cpAmm;
  }

  async open(params: OpenPositionParams): Promise<OpenPositionResult> {
    const wallet = getWallet();
    const amm = this.amm();
    const pool = new PublicKey(params.poolAddress);
    const poolState = await amm.fetchPoolState(pool);

    // Balanced deposit sized in token B (quote side by convention on DAMM v2 pools we accept).
    const maxAmountTokenA = this.toRaw(
      params.sizeUsd / 2 / Math.max(params.tokenX.priceUsd, 1e-12),
      params.tokenX.decimals,
    );
    const maxAmountTokenB = this.toRaw(
      params.sizeUsd / 2 / Math.max(params.tokenY.priceUsd, 1e-12),
      params.tokenY.decimals,
    );

    const quote = amm.getDepositQuote({
      inAmount: maxAmountTokenB,
      isTokenA: false,
      minSqrtPrice: poolState.sqrtMinPrice,
      maxSqrtPrice: poolState.sqrtMaxPrice,
      sqrtPrice: poolState.sqrtPrice,
      collectFeeMode: poolState.collectFeeMode,
      tokenAAmount: new BN(0),
      tokenBAmount: new BN(0),
      liquidity: poolState.liquidity,
    });

    const positionNft = Keypair.generate();
    const slippageNum = Math.floor((1 + config.position.costs.slippageFraction) * 10_000);
    const tx = await amm.createPositionAndAddLiquidity({
      owner: wallet.publicKey,
      pool,
      positionNft: positionNft.publicKey,
      liquidityDelta: quote.liquidityDelta,
      maxAmountTokenA: maxAmountTokenA.muln(slippageNum).divn(10_000),
      maxAmountTokenB: maxAmountTokenB.muln(slippageNum).divn(10_000),
      tokenAAmountThreshold: maxAmountTokenA.muln(slippageNum).divn(10_000),
      tokenBAmountThreshold: maxAmountTokenB.muln(slippageNum).divn(10_000),
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAProgram: getTokenProgram(poolState.tokenAFlag),
      tokenBProgram: getTokenProgram(poolState.tokenBFlag),
    });
    const result = await sendAndConfirm(tx, [wallet, positionNft], `damm-open:${params.poolName}`);
    logger.info(
      { pool: params.poolName, nft: positionNft.publicKey.toBase58(), tx: result.signature },
      "[LIVE] DAMM v2 position opened",
    );
    return {
      positionAddress: positionNft.publicKey.toBase58(),
      txSignature: result.signature,
      openCostUsd: this.lamportsToUsd(result.feeLamports),
    };
  }

  async status(protocol: Protocol, poolAddress: string, positionAddress: string): Promise<LivePositionStatus> {
    const snap = await this.feed(protocol, poolAddress);
    const { poolState, positionState } = await this.findPosition(poolAddress, positionAddress);
    const amm = this.amm();
    const withdrawQuote = amm.getWithdrawQuote({
      liquidityDelta: positionState.unlockedLiquidity,
      minSqrtPrice: poolState.sqrtMinPrice,
      maxSqrtPrice: poolState.sqrtMaxPrice,
      sqrtPrice: poolState.sqrtPrice,
      collectFeeMode: poolState.collectFeeMode,
      tokenAAmount: new BN(0),
      tokenBAmount: new BN(0),
      liquidity: poolState.liquidity,
    });
    const aUi = Number(withdrawQuote.outAmountA.toString()) / 10 ** snap.tokenXDecimals;
    const bUi = Number(withdrawQuote.outAmountB.toString()) / 10 ** snap.tokenYDecimals;
    const unclaimed = getUnClaimLpFee(poolState, positionState);
    const feeAUi = Number(unclaimed.feeTokenA.toString()) / 10 ** snap.tokenXDecimals;
    const feeBUi = Number(unclaimed.feeTokenB.toString()) / 10 ** snap.tokenYDecimals;
    return {
      positionValueUsd: aUi * snap.tokenXPriceUsd + bUi * snap.tokenYPriceUsd,
      unclaimedFeesUsd: feeAUi * snap.tokenXPriceUsd + feeBUi * snap.tokenYPriceUsd,
      currentPrice: snap.price,
      // DAMM v2 positions cover the pool's full configured range.
      inRange: true,
    };
  }

  async claim(protocol: Protocol, poolAddress: string, positionAddress: string): Promise<ClaimResult> {
    const wallet = getWallet();
    const snap = await this.feed(protocol, poolAddress);
    const { pool, poolState, positionState, position, positionNftAccount } = await this.findPosition(
      poolAddress,
      positionAddress,
    );
    const unclaimed = getUnClaimLpFee(poolState, positionState);
    const feeAUi = Number(unclaimed.feeTokenA.toString()) / 10 ** snap.tokenXDecimals;
    const feeBUi = Number(unclaimed.feeTokenB.toString()) / 10 ** snap.tokenYDecimals;
    const claimedUsd = feeAUi * snap.tokenXPriceUsd + feeBUi * snap.tokenYPriceUsd;
    if (claimedUsd <= 0.01) return { claimedUsd: 0, txSignature: null };

    const tx = await this.amm().claimPositionFee({
      owner: wallet.publicKey,
      position,
      pool,
      positionNftAccount,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: getTokenProgram(poolState.tokenAFlag),
      tokenBProgram: getTokenProgram(poolState.tokenBFlag),
    });
    const r = await sendAndConfirm(tx, [wallet], `damm-claim:${positionAddress.slice(0, 8)}`);
    return { claimedUsd, txSignature: r.signature };
  }

  async close(protocol: Protocol, poolAddress: string, positionAddress: string): Promise<ClosePositionResult> {
    const wallet = getWallet();
    const snap = await this.feed(protocol, poolAddress);
    const { poolState, positionState, position, positionNftAccount } = await this.findPosition(
      poolAddress,
      positionAddress,
    );
    const amm = this.amm();
    const withdrawQuote = amm.getWithdrawQuote({
      liquidityDelta: positionState.unlockedLiquidity,
      minSqrtPrice: poolState.sqrtMinPrice,
      maxSqrtPrice: poolState.sqrtMaxPrice,
      sqrtPrice: poolState.sqrtPrice,
      collectFeeMode: poolState.collectFeeMode,
      tokenAAmount: new BN(0),
      tokenBAmount: new BN(0),
      liquidity: poolState.liquidity,
    });
    const aUi = Number(withdrawQuote.outAmountA.toString()) / 10 ** snap.tokenXDecimals;
    const bUi = Number(withdrawQuote.outAmountB.toString()) / 10 ** snap.tokenYDecimals;
    const unclaimed = getUnClaimLpFee(poolState, positionState);
    const feeAUi = Number(unclaimed.feeTokenA.toString()) / 10 ** snap.tokenXDecimals;
    const feeBUi = Number(unclaimed.feeTokenB.toString()) / 10 ** snap.tokenYDecimals;

    const currentPoint = await getCurrentPoint(getConnection(), poolState.activationType);
    const tx = await amm.removeAllLiquidityAndClosePosition({
      owner: wallet.publicKey,
      position,
      positionNftAccount,
      poolState,
      positionState,
      tokenAAmountThreshold: new BN(0),
      tokenBAmountThreshold: new BN(0),
      vestings: [],
      currentPoint,
    });
    const r = await sendAndConfirm(tx, [wallet], `damm-close:${positionAddress.slice(0, 8)}`);
    logger.info({ position: positionAddress, tx: r.signature }, "[LIVE] DAMM v2 position closed");
    return {
      txSignature: r.signature,
      recoveredUsd: aUi * snap.tokenXPriceUsd + bUi * snap.tokenYPriceUsd,
      claimedUsd: feeAUi * snap.tokenXPriceUsd + feeBUi * snap.tokenYPriceUsd,
      closeCostUsd: this.lamportsToUsd(r.feeLamports),
    };
  }

  private async findPosition(
    poolAddress: string,
    positionNftMint: string,
  ): Promise<{
    pool: PublicKey;
    poolState: PoolState;
    position: PublicKey;
    positionNftAccount: PublicKey;
    positionState: PositionState;
  }> {
    const wallet = getWallet();
    const amm = this.amm();
    const pool = new PublicKey(poolAddress);
    const poolState = await amm.fetchPoolState(pool);
    const positions = await amm.getUserPositionByPool(pool, wallet.publicKey);
    const nftMint = new PublicKey(positionNftMint);
    const found = positions.find((p) => p.positionState.nftMint.equals(nftMint));
    if (!found) throw new Error(`DAMM v2 position with NFT ${positionNftMint} not found on-chain`);
    return {
      pool,
      poolState,
      position: found.position,
      positionNftAccount: found.positionNftAccount,
      positionState: found.positionState,
    };
  }

  private toRaw(uiAmount: number, decimals: number): BN {
    return new BN(Math.floor(Math.max(0, uiAmount) * 10 ** decimals).toString());
  }

  private lamportsToUsd(lamports: number | null): number {
    if (lamports === null) return config.position.costs.openUsd;
    return (lamports / 1e9) * SOL_USD_FALLBACK;
  }
}
