import { config } from './config.js';
import { logger } from './logger.js';
import { getTodayEvents, getUpcomingEvents, type EconEvent } from './economic-calendar.js';
import type { ConfluenceSignal } from '@trading/contracts';

export interface Embed {
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

  private async _post(embeds: Embed[]) {
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
      if (batch.length > 0) await this._post(batch);
      if (this.queue.length > 0) this.scheduleFlush();
    }, 250);
  }

  // Public: enqueue any embed directly (used by morning-brief, etc.)
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

  morningBriefing() {
    const events = getTodayEvents();
    const upcoming = getUpcomingEvents(5).filter(u => {
      const d = new Date(u.date + 'T12:00:00Z');
      return d.getTime() > Date.now();
    });

    if (events.length === 0 && upcoming.length === 0) return;

    const fields: { name: string; value: string; inline?: boolean }[] = [];

    if (events.length > 0) {
      const todayLines = events.map(e =>
        `**${e.short}** (${e.time_et} ET) — ${e.note}`
      ).join('\n');
      fields.push({ name: '⚠️ TODAY', value: todayLines });
    }

    if (upcoming.length > 0) {
      const upLines = upcoming.map(u =>
        `**${u.date}**: ${u.events.map(e => e.short).join(', ')}`
      ).join('\n');
      fields.push({ name: 'Upcoming', value: upLines });
    }

    const hasToday = events.length > 0;
    this.send({
      title: hasToday
        ? `📅 Pre-Market: ${events.map(e => e.short).join(' + ')} day`
        : '📅 Pre-Market: No major events today',
      description: hasToday
        ? 'High-impact release today — expect wider ranges, stop early spikes. Reduce size on CONT signals. Avoid trading the initial 8:30 spike.'
        : undefined,
      color: hasToday ? COLOR.warn : COLOR.info,
      fields,
    });
  }

  signal(sig: ConfluenceSignal) {
    const color = sig.direction === 'long' ? COLOR.longSignal : COLOR.shortSignal;
    const arrow = sig.direction === 'long' ? '▲' : '▼';
    const ext = sig as ConfluenceSignal & {
      tp1?: { label: string; price: number; pts: number };
      tp2?: { label: string; price: number; pts: number };
      conviction?: '+' | null;
    };

    const convictionSuffix = ext.conviction ? ` ${ext.conviction}` : '';
    const tierSuffix = sig.rsTier && sig.rsTier !== 'PASS' ? ` · ${sig.rsTier}` : '';

    const fields = [
      { name: 'Time',     value: new Date(sig.ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' ET', inline: true },
      { name: 'Score',    value: `${sig.score}/100`, inline: true },
      { name: 'Strategy', value: `${sig.strategyVersion ?? 'A'} / ${(sig as any).ruleVersion ?? sig.ruleId}`, inline: true },
    ];

    // RS score + components
    if (sig.rsScore !== undefined && sig.rsTier) {
      const comp = sig.rsComponents;
      const compStr = comp ? `  \`level=${comp.level} · ctx=${comp.context} · confirm=${comp.confirm}\`` : '';
      fields.push({
        name: `RS Score — ${sig.rsTier}`,
        value: `**${sig.rsScore}/100**${compStr}`,
        inline: false,
      });
    }

    // RS label line (matched level · test count · GM · LM code · B&R)
    if (sig.rsLabelLine) {
      fields.push({ name: 'RS Context', value: sig.rsLabelLine, inline: false });
    }

    // Exit targets
    if (ext.tp1) {
      const tp1Str = `${ext.tp1.label} @ ${ext.tp1.price} (+${ext.tp1.pts}pts)`;
      const tp2Str = ext.tp2 ? `\n${ext.tp2.label} @ ${ext.tp2.price} (+${ext.tp2.pts}pts)` : '';
      fields.push({ name: 'Exit Targets', value: `TP1: ${tp1Str}${tp2Str}`, inline: false });
    }

    // Economic calendar warning
    const todayEvents = getTodayEvents();
    if (todayEvents.length > 0) {
      const label = todayEvents.map(e => `${e.short} ${e.time_et} ET`).join(' · ');
      fields.push({ name: '⚠️ News Day', value: label, inline: false });
    }

    this.send({
      title: `${arrow} ${sig.symbol} ${sig.direction.toUpperCase()} — ${sig.ruleId} (${sig.score})${tierSuffix}${convictionSuffix}`,
      description: sig.rationale,
      color,
      fields,
    });
  }
}

export const discord = new DiscordAlerter();
