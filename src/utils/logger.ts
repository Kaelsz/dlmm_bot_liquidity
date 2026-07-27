import pino from "pino";
import { config } from "../config/config.js";

export const logger = pino({
  level: config.log.level,
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
        },
});

export type Logger = typeof logger;
