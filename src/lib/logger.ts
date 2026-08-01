import pino from "pino";
import { config } from "@/config";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: config.log.level,
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : {}),
});
