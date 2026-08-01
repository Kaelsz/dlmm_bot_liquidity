import pino from "pino";
import { config } from "@/config";

/**
 * Structured logging to stdout, deliberately without a transport.
 *
 * pino-pretty runs in a worker thread, which Next's server bundler cannot
 * resolve — it fails with "Cannot find module .next/server/vendor-chunks/
 * lib/worker.js" and then takes the whole dev server down with an uncaught
 * exception. Plain NDJSON on stdout also happens to be what you want on a
 * VPS, where journald or Docker collects it.
 */
export const logger = pino({
  level: config.log.level,
  base: undefined, // drop pid/hostname noise
  timestamp: pino.stdTimeFunctions.isoTime,
});
