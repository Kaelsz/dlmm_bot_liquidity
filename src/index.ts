import { config } from "./config/config.js";
import { logger } from "./utils/logger.js";
import { Engine } from "./engine.js";
import { BotDb } from "./db/database.js";
import { computeReport, formatReport } from "./pnl/report.js";
import { startDashboard } from "./dashboard/server.js";

/**
 * CLI entry point.
 *
 *   pnpm scan       Phase 1: scanner + scoring, read-only opportunity board
 *   pnpm paper      Phase 2: paper trading (DRY_RUN), full simulated lifecycle
 *   pnpm live       Phase 3/4: real execution (requires DRY_RUN=false + wallet)
 *   pnpm report     performance report from SQLite
 *   pnpm dashboard  read-only web dashboard
 *   tsx src/index.ts close-all   emergency: close all open positions
 */

const command = process.argv[2] ?? "scan";

async function main(): Promise<void> {
  switch (command) {
    case "scan":
    case "paper":
    case "live": {
      const engine = new Engine(command);
      const shutdown = (): void => {
        logger.info("shutting down (open positions are re-monitored on restart)");
        engine.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await engine.start();
      break;
    }
    case "report": {
      const db = new BotDb();
      const hours = Number(process.argv[3] ?? "0");
      const since = hours > 0 ? Date.now() - hours * 3_600_000 : 0;
      console.log(formatReport(computeReport(db, since), hours > 0 ? `last ${hours}h` : "all time"));
      db.close();
      break;
    }
    case "dashboard": {
      const db = new BotDb();
      startDashboard(db);
      break;
    }
    case "close-all": {
      // Emergency manual kill switch.
      const mode = config.dryRun ? "paper" : "live";
      const engine = new Engine(mode);
      if (engine.manager) await engine.manager.closeAll("manual close-all command");
      engine.stop();
      break;
    }
    default:
      console.error(`unknown command: ${command}`);
      console.error("usage: tsx src/index.ts <scan|paper|live|report|dashboard|close-all>");
      process.exit(1);
  }
}

main().catch((err) => {
  logger.fatal({ err }, "fatal error");
  process.exit(1);
});
