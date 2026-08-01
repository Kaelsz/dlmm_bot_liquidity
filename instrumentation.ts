/**
 * Next.js calls this once, on server boot, before handling any request.
 * It is the only supported hook for starting a long-lived background service
 * inside the Next process.
 *
 * Guards, in order of importance:
 *   - `NEXT_RUNTIME === "nodejs"` — this file is also evaluated for the edge
 *     runtime, where better-sqlite3 and timers are unavailable.
 *   - `NEXT_PHASE` — never start polling during `next build`, which would fire
 *     real API traffic from a CI machine.
 *   - `config.collector.enabled` — lets the UI run against an existing DB.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { config } = await import("@/config");
  const { logger } = await import("@/lib/logger");

  if (!config.collector.enabled) {
    logger.warn("collector disabled (COLLECTOR=off) — serving stored data only");
    return;
  }

  const { getCollector } = await import("@/collector/collector");
  const collector = getCollector();
  collector.start();

  const shutdown = (signal: string) => () => {
    logger.info({ signal }, "shutting down");
    collector.stop();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown("SIGTERM"));
  process.once("SIGINT", shutdown("SIGINT"));
}
