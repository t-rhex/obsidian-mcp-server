/**
 * Webhook emitter — sends vault events to external HTTP endpoints.
 *
 * Features:
 *   - Fire-and-forget (non-blocking, catches errors)
 *   - Optional HMAC-SHA256 signature header (X-Vault-Signature)
 *   - Configurable timeout
 *   - One retry with 2s delay on failure
 *   - Multiple URLs (comma-separated)
 */

import { createHmac } from "node:crypto";
import type { VaultEvent } from "./events.js";

export interface WebhookConfig {
  /** Comma-separated webhook URLs */
  urls: string[];
  /** HMAC signing secret (optional) */
  secret?: string;
  /** HTTP timeout in ms */
  timeoutMs: number;
}

export class WebhookEmitter {
  private config: WebhookConfig;

  constructor(config: WebhookConfig) {
    this.config = config;
  }

  /**
   * Send event to all configured webhook URLs.
   * Fire-and-forget — errors are logged but never thrown.
   */
  async send(event: VaultEvent): Promise<void> {
    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Vault-Event": event.event,
    };

    // HMAC signature
    if (this.config.secret) {
      const signature = createHmac("sha256", this.config.secret)
        .update(body)
        .digest("hex");
      headers["X-Vault-Signature"] = `sha256=${signature}`;
    }

    for (const url of this.config.urls) {
      this.sendToUrl(url, body, headers).catch(() => {
        // Silently ignore — fire-and-forget
      });
    }
  }

  private async sendToUrl(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<void> {
    const attempt = async (): Promise<void> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

      try {
        const resp = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
      } finally {
        clearTimeout(timeout);
      }
    };

    try {
      await attempt();
    } catch (err) {
      // One retry after 2s
      console.error(
        `Webhook to ${url} failed (retrying in 2s):`,
        err instanceof Error ? err.message : err,
      );
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await attempt();
      } catch (retryErr) {
        console.error(
          `Webhook to ${url} failed on retry:`,
          retryErr instanceof Error ? retryErr.message : retryErr,
        );
      }
    }
  }
}
