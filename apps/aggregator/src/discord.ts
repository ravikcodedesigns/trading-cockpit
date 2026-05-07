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
    const ext = sig as ConfluenceSignal & {
      rsLevel?: string; tp1?: { label: string; price: number; pts: number };
      tp2?: { label: string; price: number; pts: number };
      rsContext?: string; greaterMarketAligned?: boolean;
      conviction?: '++' | '+' | null;
    };

    // Conviction suffix in title — separate from score
    const convictionSuffix = ext.conviction ? ` ${ext.conviction}` : '';

    const fields = [
      { name: 'Time', value: new Date(sig.ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' ET', inline: true },
      { name: 'Score', value: `${sig.score}/100`, inline: true },
      { name: 'Strategy', value: `${sig.strategyVersion ?? 'A'} / ${(sig as any).ruleVersion ?? sig.ruleId}`, inline: true },
    ];

    // RS level proximity
    if (ext.rsLevel) {
      fields.push({ name: 'RS Level', value: `📍 ${ext.rsLevel}`, inline: false });
    }

    // Exit targets
    if (ext.tp1) {
      const tp1Str = `${ext.tp1.label} @ ${ext.tp1.price} (+${ext.tp1.pts}pts)`;
      const tp2Str = ext.tp2 ? `\n${ext.tp2.label} @ ${ext.tp2.price} (+${ext.tp2.pts}pts)` : '';
      fields.push({ name: 'Exit Targets', value: `TP1: ${tp1Str}${tp2Str}`, inline: false });
    }

    // Greater market alignment
    if (ext.greaterMarketAligned !== undefined) {
      fields.push({
        name: 'GM Alignment',
        value: ext.greaterMarketAligned ? '✅ Aligned' : '⚠️ Counter-GM',
        inline: true,
      });
    }

    // RS context summary
    if (ext.rsContext) {
      fields.push({ name: 'Market Context', value: ext.rsContext, inline: false });
    }

    this.send({
      title: `${arrow} ${sig.symbol} ${sig.direction.toUpperCase()} — ${sig.ruleId} (${sig.score})${convictionSuffix}`,
      description: sig.rationale,
      color,
      fields,
    });
  }
}

export const discord = new DiscordAlerter();
