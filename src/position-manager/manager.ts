import { config } from "../config/config.js";
import { logger } from "../utils/logger.js";
import { fmtUsd } from "../utils/time.js";
import type { BotDb, PositionRow } from "../db/database.js";
import type { OpportunityEvaluation } from "../scoring/scoring.js";
import type { IPositionExecutor, MarketFeedFn } from "../execution/types.js";
import type { Notifier } from "../notifier/notifier.js";
import { evaluateExit, updateFeeDecayClock } from "./exitRules.js";

/**
 * Lifecycle of open positions: fast monitoring loop, periodic claims,
 * exit rule evaluation, close + final PnL accounting.
 *
 * Runtime state (fee decay clock, claimed totals) is kept in memory but the
 * source of truth is SQLite + (in live mode) the chain: after a restart,
 * open positions are reloaded from the DB and re-monitored.
 */

interface RuntimeState {
  feeDecaySinceMs: number | null;
  claimedUsd: number;
  lastClaimMs: number;
  openCostUsd: number;
  closing: boolean;
}

export class PositionManager {
  private readonly runtime = new Map<number, RuntimeState>();
  killSwitch = false;

  constructor(
    private readonly db: BotDb,
    private readonly executor: IPositionExecutor,
    private readonly feed: MarketFeedFn,
    private readonly notifier: Notifier,
  ) {}

  openCount(): number {
    return this.db.openPositions(this.executor.mode).length;
  }

  openExposureUsd(): number {
    return this.db.openPositions(this.executor.mode).reduce((s, r) => s + r.size_usd, 0);
  }

  async openFromEvaluation(ev: OpportunityEvaluation): Promise<number | null> {
    const { pool } = ev.sample;
    const lowerPrice = pool.currentPrice * (1 - ev.rangeHalfWidth);
    const upperPrice = pool.currentPrice * (1 + ev.rangeHalfWidth);
    try {
      const res = await this.executor.open({
        protocol: pool.protocol,
        poolAddress: pool.address,
        poolName: pool.name,
        sizeUsd: ev.positionSizeUsd,
        currentPrice: pool.currentPrice,
        lowerPrice,
        upperPrice,
        binRange: ev.binRange,
        tokenX: { mint: pool.tokenX.address, decimals: pool.tokenX.decimals, priceUsd: pool.tokenX.price },
        tokenY: { mint: pool.tokenY.address, decimals: pool.tokenY.decimals, priceUsd: pool.tokenY.price },
      });
      const id = this.db.createPosition({
        pool_address: pool.address,
        protocol: pool.protocol,
        mode: this.executor.mode,
        status: "OPEN",
        pool_name: pool.name,
        opened_at: Date.now(),
        entry_price: pool.currentPrice,
        size_usd: ev.positionSizeUsd,
        lower_price: lowerPrice,
        upper_price: upperPrice,
        bin_range: ev.binRange,
        entry_fee_rate_usd_min: ev.sample.instantFeeRateUsdPerMin,
        onchain_address: res.positionAddress,
        tx_open: res.txSignature,
      });
      this.runtime.set(id, {
        feeDecaySinceMs: null,
        claimedUsd: 0,
        lastClaimMs: Date.now(),
        openCostUsd: res.openCostUsd,
        closing: false,
      });
      this.db.addPositionEvent(id, "OPEN", {
        score: ev.score,
        expectedNetUsd: ev.expectedNetUsd,
        breakevenMin: ev.breakevenMinutes,
        entryFeeRateUsdMin: ev.sample.instantFeeRateUsdPerMin,
      });
      await this.notifier.send(
        `🟢 ENTER ${pool.name} [${pool.protocol}/${this.executor.mode}]\n` +
          `size ${fmtUsd(ev.positionSizeUsd)} | range ±${(ev.rangeHalfWidth * 100).toFixed(2)}% (${ev.binRange} bins)\n` +
          `fee rate ${fmtUsd(ev.sample.instantFeeRateUsdPerMin)}/min | expected net ${fmtUsd(ev.expectedNetUsd)} | breakeven ${ev.breakevenMinutes.toFixed(1)}min`,
      );
      return id;
    } catch (err) {
      logger.error({ err, pool: pool.name }, "position open failed");
      await this.notifier.send(`🔴 OPEN FAILED ${pool.name}: ${String(err)}`);
      return null;
    }
  }

  /** One monitoring pass over all open positions of this executor's mode. */
  async monitorTick(): Promise<void> {
    const open = this.db.openPositions(this.executor.mode);
    for (const row of open) {
      try {
        await this.monitorPosition(row);
      } catch (err) {
        logger.error({ err, position: row.id, pool: row.pool_name }, "monitor failed");
        this.db.addPositionEvent(row.id, "ERROR", { error: String(err) });
      }
    }
  }

  private stateFor(row: PositionRow): RuntimeState {
    let st = this.runtime.get(row.id);
    if (!st) {
      // Restart recovery: rebuild runtime state conservatively from the DB.
      st = {
        feeDecaySinceMs: null,
        claimedUsd: 0,
        lastClaimMs: row.opened_at,
        openCostUsd: config.position.costs.openUsd,
        closing: false,
      };
      this.runtime.set(row.id, st);
    }
    return st;
  }

  private async monitorPosition(row: PositionRow): Promise<void> {
    const st = this.stateFor(row);
    if (st.closing) return;
    if (!row.onchain_address) throw new Error("position row missing onchain address");

    const status = await this.executor.status(row.protocol, row.pool_address, row.onchain_address);
    const snap = await this.feed(row.protocol, row.pool_address);
    const now = Date.now();

    st.feeDecaySinceMs = updateFeeDecayClock(
      st.feeDecaySinceMs,
      row.entry_fee_rate_usd_min,
      snap.poolFeeRateUsdPerMin,
      now,
    );

    const decision = evaluateExit({
      openedAtMs: row.opened_at,
      nowMs: now,
      entryPrice: row.entry_price,
      currentPrice: status.currentPrice,
      lowerPrice: row.lower_price,
      upperPrice: row.upper_price,
      sizeUsd: row.size_usd,
      entryFeeRateUsdPerMin: row.entry_fee_rate_usd_min,
      currentFeeRateUsdPerMin: snap.poolFeeRateUsdPerMin,
      feeDecaySinceMs: st.feeDecaySinceMs,
      positionValueUsd: status.positionValueUsd,
      feesEarnedUsd: st.claimedUsd + status.unclaimedFeesUsd,
      killSwitch: this.killSwitch,
    });

    logger.debug(
      {
        position: row.id,
        pool: row.pool_name,
        value: status.positionValueUsd.toFixed(2),
        fees: (st.claimedUsd + status.unclaimedFeesUsd).toFixed(2),
        feeRate: snap.poolFeeRateUsdPerMin.toFixed(2),
        inRange: status.inRange,
      },
      "monitor",
    );

    if (decision.exit) {
      st.closing = true;
      await this.closePosition(row, st, decision.reason ?? "TIMEOUT", decision.detail, status.currentPrice);
      return;
    }

    // Periodic claim (skipped near the end — the close claims everything).
    if (now - st.lastClaimMs >= config.position.claimIntervalMs) {
      st.lastClaimMs = now;
      try {
        const claim = await this.executor.claim(row.protocol, row.pool_address, row.onchain_address);
        if (claim.claimedUsd > 0) {
          st.claimedUsd += claim.claimedUsd;
          this.db.addPositionEvent(row.id, "CLAIM", { usd: claim.claimedUsd, tx: claim.txSignature });
          logger.info({ position: row.id, claimed: claim.claimedUsd.toFixed(2) }, "fees claimed");
        }
      } catch (err) {
        logger.warn({ err, position: row.id }, "claim failed (will retry)");
      }
    }
  }

  private async closePosition(
    row: PositionRow,
    st: RuntimeState,
    reason: string,
    detail: string,
    exitPrice: number,
  ): Promise<void> {
    if (!row.onchain_address) return;
    this.db.addPositionEvent(row.id, "EXIT_SIGNAL", { reason, detail });
    const res = await this.executor.close(row.protocol, row.pool_address, row.onchain_address);
    this.db.closePosition(row.id, exitPrice, reason, res.txSignature);

    const feesTotal = st.claimedUsd + res.claimedUsd;
    const holdingMinutes = (Date.now() - row.opened_at) / 60_000;
    const txCosts = st.openCostUsd + res.closeCostUsd;
    const slippageUsd = (row.size_usd + res.recoveredUsd) * config.position.costs.slippageFraction;
    const netPnl = res.recoveredUsd + feesTotal - row.size_usd - txCosts;
    const ilUsd = Math.max(0, row.size_usd - res.recoveredUsd);
    this.db.upsertPnl({
      positionId: row.id,
      feesClaimedUsd: feesTotal,
      ilUsd,
      txCostsUsd: txCosts,
      slippageUsd,
      netPnlUsd: netPnl,
      holdingMinutes,
    });
    this.db.addPositionEvent(row.id, "CLOSE", { reason, netPnl, feesTotal, recovered: res.recoveredUsd });
    this.runtime.delete(row.id);

    const emoji = netPnl >= 0 ? "🟢" : "🔻";
    await this.notifier.send(
      `${emoji} EXIT ${row.pool_name} [${reason}] after ${holdingMinutes.toFixed(1)}min\n` +
        `fees ${fmtUsd(feesTotal)} | value loss ${fmtUsd(ilUsd)} | costs ${fmtUsd(txCosts)}\n` +
        `net PnL ${fmtUsd(netPnl)} (${detail})`,
    );
    logger.info(
      { position: row.id, pool: row.pool_name, reason, netPnl: netPnl.toFixed(2), holdingMinutes: holdingMinutes.toFixed(1) },
      "position closed",
    );
  }

  /** Kill switch: close everything as cleanly as possible. */
  async closeAll(reason: string): Promise<void> {
    this.killSwitch = true;
    const open = this.db.openPositions(this.executor.mode);
    for (const row of open) {
      const st = this.stateFor(row);
      try {
        const status = await this.executor.status(row.protocol, row.pool_address, row.onchain_address ?? "");
        await this.closePosition(row, st, "KILL_SWITCH", reason, status.currentPrice);
      } catch (err) {
        logger.error({ err, position: row.id }, "kill switch close failed");
      }
    }
  }
}
