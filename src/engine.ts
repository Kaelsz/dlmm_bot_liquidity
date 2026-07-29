import { config } from "./config/config.js";
import { logger } from "./utils/logger.js";
import { fmtPct, fmtUsd, sleep } from "./utils/time.js";
import { BotDb } from "./db/database.js";
import { Scanner, type HeatSample } from "./scanner/scanner.js";
import { apiFor } from "./scanner/datapi.js";
import { computeStability, type StabilityMetrics } from "./scoring/volatility.js";
import { evaluateOpportunity, type OpportunityEvaluation } from "./scoring/scoring.js";
import { RugcheckClient } from "./risk/rugcheck.js";
import { fullEligibility, staticEligibility } from "./risk/tokenFilters.js";
import { checkPortfolioLimits } from "./risk/portfolio.js";
import { PaperExecutor } from "./execution/paper.js";
import { DlmmExecutor } from "./execution/dlmm.js";
import { DammV2Executor } from "./execution/dammv2.js";
import type {
  ClaimResult,
  ClosePositionResult,
  IPositionExecutor,
  LivePositionStatus,
  MarketFeedFn,
  MarketSnapshot,
  OpenPositionParams,
  OpenPositionResult,
} from "./execution/types.js";
import { PositionManager } from "./position-manager/manager.js";
import { Notifier } from "./notifier/notifier.js";
import type { PoolView, Protocol } from "./types/datapi.js";

/**
 * Orchestrator: wires scanner → risk → scoring → position manager.
 *
 * Modes:
 *  - "scan":  read-only, prints the live opportunity board (Phase 1)
 *  - "paper": full simulated lifecycle on real data (Phase 2, default)
 *  - "live":  real transactions (requires DRY_RUN=false + wallet)
 */
export type EngineMode = "scan" | "paper" | "live";

/** Routes live execution to the right protocol executor behind one interface. */
class LiveRouter implements IPositionExecutor {
  readonly mode = "LIVE" as const;
  private readonly dlmm: DlmmExecutor;
  private readonly damm: DammV2Executor;

  constructor(feed: MarketFeedFn) {
    this.dlmm = new DlmmExecutor(feed);
    this.damm = new DammV2Executor(feed);
  }
  private pick(protocol: Protocol): IPositionExecutor {
    return protocol === "dlmm" ? this.dlmm : this.damm;
  }
  open(params: OpenPositionParams): Promise<OpenPositionResult> {
    return this.pick(params.protocol).open(params);
  }
  status(protocol: Protocol, pool: string, position: string): Promise<LivePositionStatus> {
    return this.pick(protocol).status(protocol, pool, position);
  }
  claim(protocol: Protocol, pool: string, position: string): Promise<ClaimResult> {
    return this.pick(protocol).claim(protocol, pool, position);
  }
  close(protocol: Protocol, pool: string, position: string): Promise<ClosePositionResult> {
    return this.pick(protocol).close(protocol, pool, position);
  }
}

export class Engine {
  readonly db: BotDb;
  readonly scanner: Scanner;
  readonly notifier = new Notifier();
  private readonly rugcheck: RugcheckClient;
  readonly manager: PositionManager | null;
  private readonly feedCache = new Map<string, { at: number; snap: MarketSnapshot }>();
  private readonly lastFeeRate = new Map<string, number>();
  private readonly stabilityCache = new Map<string, { at: number; metrics: StabilityMetrics }>();
  private running = true;
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(readonly mode: EngineMode, dbPath?: string) {
    this.db = new BotDb(dbPath);
    this.scanner = new Scanner(this.db);
    this.rugcheck = new RugcheckClient(this.db);

    if (mode === "scan") {
      this.manager = null;
    } else if (mode === "paper") {
      this.manager = new PositionManager(this.db, new PaperExecutor(this.feed), this.feed, this.notifier);
    } else {
      if (config.dryRun) {
        throw new Error(
          "live mode requested but DRY_RUN=true. Set DRY_RUN=false explicitly after validating in paper mode.",
        );
      }
      this.manager = new PositionManager(this.db, new LiveRouter(this.feed), this.feed, this.notifier);
    }
  }

  /** Market feed shared by executors and the position monitor (5s cache). */
  readonly feed: MarketFeedFn = async (protocol, poolAddress) => {
    const key = `${protocol}:${poolAddress}`;
    const cached = this.feedCache.get(key);
    if (cached && Date.now() - cached.at < 5_000) return cached.snap;
    const pool = await apiFor(protocol).getPool(poolAddress);
    if (!pool) throw new Error(`pool ${poolAddress} not found on datapi`);
    const sample = this.scanner.recordFeePoint(pool);
    let feeRate = sample?.instantFeeRateUsdPerMin;
    if (feeRate === undefined || feeRate < 0) {
      feeRate = this.lastFeeRate.get(key) ?? pool.fees["30m"] / 30;
    }
    this.lastFeeRate.set(key, feeRate);
    const snap: MarketSnapshot = {
      price: pool.currentPrice,
      tvl: pool.tvl,
      poolFeeRateUsdPerMin: feeRate,
      tokenXPriceUsd: pool.tokenX.price,
      tokenYPriceUsd: pool.tokenY.price,
      tokenXDecimals: pool.tokenX.decimals,
      tokenYDecimals: pool.tokenY.decimals,
    };
    this.feedCache.set(key, { at: Date.now(), snap });
    return snap;
  };

  async start(): Promise<void> {
    logger.info({ mode: this.mode, dryRun: config.dryRun }, "engine starting");
    await this.notifier.send(`🚀 fee-sniper started in ${this.mode.toUpperCase()} mode`);

    await this.scanner.broadScan();
    this.every(config.scanner.broadScanIntervalMs, () => this.scanner.broadScan());
    this.every(config.scanner.fastPollIntervalMs, () => this.fastCycle());
    if (this.manager) {
      this.every(config.position.monitorIntervalMs, () => this.monitorCycle());
    }
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.db.close();
  }

  private every(ms: number, fn: () => Promise<unknown>): void {
    let busy = false;
    const t = setInterval(async () => {
      if (busy || !this.running) return;
      busy = true;
      try {
        await fn();
      } catch (err) {
        logger.error({ err }, "loop iteration failed");
      } finally {
        busy = false;
      }
    }, ms);
    this.timers.push(t);
  }

  /** Fast cycle: derive fees/min on the watchlist, score, maybe enter. */
  private async fastCycle(): Promise<void> {
    // Kill switch on repeated infrastructure errors.
    if (this.manager && this.scanner.errorStreak >= config.risk.killSwitch.maxConsecutiveErrors) {
      logger.error({ streak: this.scanner.errorStreak }, "KILL SWITCH: repeated API errors");
      await this.notifier.send("🛑 KILL SWITCH tripped (repeated API/RPC errors) — closing everything");
      await this.manager.closeAll("repeated API errors");
      return;
    }

    const samples = await this.scanner.fastPoll();
    const evaluations: OpportunityEvaluation[] = [];

    for (const sample of samples.slice(0, 10)) {
      const evaluation = await this.evaluate(sample);
      if (evaluation) evaluations.push(evaluation);
    }

    this.printBoard(evaluations);

    if (!this.manager) return;
    for (const ev of evaluations) {
      if (!ev.enter) continue;
      const pool = ev.sample.pool;
      const eligibility = await fullEligibility(pool, this.rugcheck, this.mode === "live");
      if (!eligibility.eligible) {
        this.persistOpportunity(ev, "SKIP", eligibility.reason);
        logger.info({ pool: pool.name, reason: eligibility.reason }, "entry blocked by risk filter");
        continue;
      }
      const limits = checkPortfolioLimits(this.db, this.mode === "paper" ? "PAPER" : "LIVE", pool.address, eligibility.riskyMint, (row) => {
        const p = this.db.db
          .prepare(`SELECT token_x_mint, token_y_mint FROM pools WHERE address=?`)
          .get(row.pool_address) as { token_x_mint: string; token_y_mint: string } | undefined;
        if (!p) return null;
        const quoteSet = new Set<string>(config.risk.quoteWhitelist);
        if (!quoteSet.has(p.token_x_mint)) return p.token_x_mint;
        if (!quoteSet.has(p.token_y_mint)) return p.token_y_mint;
        return null;
      });
      if (!limits.allowed) {
        this.persistOpportunity(ev, "SKIP", `portfolio: ${limits.reason}`);
        continue;
      }
      // Pre-entry recheck: most bursts die within seconds of detection. Wait
      // a beat, re-poll the pool and confirm fees are still flowing before
      // committing capital.
      const recheck = await this.recheckEntry(ev);
      if (!recheck.ok) {
        this.persistOpportunity(ev, "SKIP", recheck.reason);
        logger.info({ pool: pool.name, reason: recheck.reason }, "entry recheck failed");
        continue;
      }
      this.persistOpportunity(ev, "ENTER", null);
      await this.manager.openFromEvaluation(ev);
    }
  }

  /**
   * Fresh confirmation poll just before opening: sleep long enough for the
   * cumulative fee counter to move, re-derive the rate, and require it to
   * hold at least entryRecheckMinFraction of the signal rate.
   */
  private async recheckEntry(ev: OpportunityEvaluation): Promise<{ ok: boolean; reason: string }> {
    const pool = ev.sample.pool;
    await sleep(config.scoring.entryRecheckDelayMs);
    const fresh = await apiFor(pool.protocol).getPool(pool.address);
    if (!fresh) return { ok: false, reason: "recheck: pool unavailable" };
    const freshSample = this.scanner.recordFeePoint(fresh);
    if (!freshSample) return { ok: false, reason: "recheck: stale cumulative fees" };
    const floor = ev.sample.instantFeeRateUsdPerMin * config.scoring.entryRecheckMinFraction;
    if (freshSample.instantFeeRateUsdPerMin < floor) {
      return {
        ok: false,
        reason: `recheck: rate collapsed $${freshSample.instantFeeRateUsdPerMin.toFixed(0)}/min < $${floor.toFixed(0)}/min`,
      };
    }
    return { ok: true, reason: "ok" };
  }

  private async evaluate(sample: HeatSample): Promise<OpportunityEvaluation | null> {
    const pool = sample.pool;
    // Cheap static filters before spending OHLCV requests.
    const staticRes = staticEligibility(pool);
    if (!staticRes.eligible) {
      logger.debug({ pool: pool.name, reason: staticRes.reason }, "statically ineligible");
      return null;
    }
    const stability = await this.getStability(pool);
    const capital = config.paper.capitalUsd;
    const exposure = this.manager?.openExposureUsd() ?? 0;
    const evaluation = evaluateOpportunity(sample, stability, capital, exposure);
    if (!evaluation.enter) this.persistOpportunity(evaluation, "SKIP", evaluation.rejectReason);
    return evaluation;
  }

  private async getStability(pool: PoolView): Promise<StabilityMetrics> {
    const key = `${pool.protocol}:${pool.address}`;
    const cached = this.stabilityCache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.metrics;
    // 20 minutes of 5m candles: the drift/stability gate must reflect the
    // holding horizon, not the last hour (config: maxNetDrift15mPct).
    const nowSec = Math.floor(Date.now() / 1000);
    const candles = await apiFor(pool.protocol).getOhlcv(pool.address, "5m", nowSec - 1_200, nowSec);
    const metrics = computeStability(candles, 5);
    this.stabilityCache.set(key, { at: Date.now(), metrics });
    return metrics;
  }

  private persistOpportunity(ev: OpportunityEvaluation, decision: "ENTER" | "SKIP", reason: string | null): void {
    const pool = ev.sample.pool;
    this.db.insertOpportunity({
      ts: Date.now(),
      poolAddress: pool.address,
      protocol: pool.protocol,
      poolName: pool.name,
      score: ev.score,
      instantFeeRateUsdMin: ev.sample.instantFeeRateUsdPerMin,
      instantHeatPctHr: ev.sample.instantHeatPctPerHour,
      feeAcceleration: ev.sample.feeAcceleration,
      turnover30m: pool.tvl > 0 ? pool.volume["30m"] / pool.tvl : 0,
      stability: ev.stability.stabilityScore,
      expectedFeesUsd: ev.expectedFeesUsd,
      expectedIlUsd: ev.expectedIlUsd,
      fixedCostsUsd: ev.fixedCostsUsd,
      expectedNetUsd: ev.expectedNetUsd,
      breakevenMin: ev.breakevenMinutes,
      decision,
      rejectReason: reason,
    });
  }

  private async monitorCycle(): Promise<void> {
    if (!this.manager) return;
    await this.manager.monitorTick();
  }

  /** Console board of the hottest evaluated pools (Phase 1 deliverable). */
  private printBoard(evaluations: OpportunityEvaluation[]): void {
    if (evaluations.length === 0) return;
    const lines = [
      "",
      "┌─ 🔥 opportunity board ──────────────────────────────────────────────────────────",
    ];
    for (const ev of evaluations.slice(0, 8)) {
      const p = ev.sample.pool;
      const flag = ev.enter ? "✅ ENTER" : `— ${ev.rejectReason ?? ""}`;
      lines.push(
        `│ ${p.name.padEnd(18).slice(0, 18)} ${p.protocol.padEnd(7)} ` +
          `score ${ev.score.toFixed(0).padStart(3)} ` +
          `heat ${fmtPct(ev.sample.instantHeatPctPerHour).padStart(8)}/h ` +
          `${fmtUsd(ev.sample.instantFeeRateUsdPerMin).padStart(9)}/min ` +
          `net~${fmtUsd(ev.expectedNetUsd).padStart(8)} ` +
          `be ${Number.isFinite(ev.breakevenMinutes) ? ev.breakevenMinutes.toFixed(1) : "∞"}min ` +
          flag,
      );
    }
    lines.push("└─────────────────────────────────────────────────────────────────────────────────");
    // Direct console output (not pino) so the board stays readable.
    console.log(lines.join("\n"));
  }
}
