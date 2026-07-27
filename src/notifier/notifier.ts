import { config } from "../config/config.js";
import { logger } from "../utils/logger.js";

/**
 * Discord webhook + Telegram bot notifications. Both optional; failures are
 * logged and never propagate into the trading loop.
 */
export class Notifier {
  async send(message: string): Promise<void> {
    await Promise.all([this.discord(message), this.telegram(message)]);
  }

  private async discord(message: string): Promise<void> {
    const url = config.notifier.discordWebhookUrl;
    if (!url) return;
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: message.slice(0, 1900) }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      logger.warn({ err }, "discord notify failed");
    }
  }

  private async telegram(message: string): Promise<void> {
    const { telegramBotToken, telegramChatId } = config.notifier;
    if (!telegramBotToken || !telegramChatId) return;
    try {
      await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: telegramChatId, text: message.slice(0, 4000) }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      logger.warn({ err }, "telegram notify failed");
    }
  }
}
