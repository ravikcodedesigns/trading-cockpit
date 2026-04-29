import { config } from './config.js';
import { logger } from './logger.js';
import type { ConfluenceSignal } from '@trading/contracts';

interface Embed {
  title: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
}

const COLOR = {
  ok: 0x00b050,
  info: 0x4a8fdc,
  warn: 0xf2a633,
  error: 0xd64545,
  longSignal: 0x00b050,
  shortSignal: 0xd64545,
};

class DiscordAlerter {
  private url = config.discordWebhook;
  private queue: Embed[] = [];
  private flushing = false;

  private async post(embeds: Embed[]) {
    if (!this.url) {
      logger.debug('discord webhook not configured');
      return;
    }
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds }),
      });
      if (!res.ok) {
        logger.warn({ status: res.status, body: await res.text() }, 'discord non-2xx');
      }
    } catch (err) {
      logger.warn({ err }, 'discord send failed');
    }
  }

  // Batch sends to avoid Discord rate limits (max 30 msg/min on a webhook)
  private scheduleFlush() {
    if (this.flushing) return;
    this.flushing = true;
    setTimeout(async () => {
      const batch = this.queue.splice(0, 10);
      this.flushing = false;
      if (batch.length > 0) await this.post(batch);
      if (this.queue.length > 0) this.scheduleFlush();
    }, 250);
  }

  send(embed: Embed) {
    this.queue.push({ ...embed, timestamp: new Date().toISOString() });
    this.scheduleFlush();
  }

  systemUp() {
    this.send({
      title: '✓ Aggregator started',
      description: 'System online and listening for sources.',
      color: COLOR.ok,
    });
  }

  systemError(message: string, detail?: string) {
    this.send({
      title: '✗ System error',
      description: message,
      color: COLOR.error,
      fields: detail ? [{ name: 'Detail', value: '```' + detail.slice(0, 1000) + '```' }] : undefined,
    });
  }

  sourceConnected(source: string) {
    this.send({
      title: `→ ${source} connected`,
      color: COLOR.info,
    });
  }

  sourceDisconnected(source: string) {
    this.send({
      title: `× ${source} disconnected`,
      color: COLOR.warn,
    });
  }

  signal(sig: ConfluenceSignal) {
    const color = sig.direction === 'long' ? COLOR.longSignal : COLOR.shortSignal;
    const arrow = sig.direction === 'long' ? '▲' : '▼';
    this.send({
      title: `${arrow} ${sig.symbol} ${sig.direction.toUpperCase()} — ${sig.ruleId} (score ${sig.score})`,
      description: sig.rationale,
      color,
      fields: [
        { name: 'Mode', value: sig.observeOnly ? 'OBSERVE-ONLY' : 'TRIGGER', inline: true },
        { name: 'Time', value: new Date(sig.ts).toLocaleTimeString(), inline: true },
      ],
    });
  }
}

export const discord = new DiscordAlerter();
