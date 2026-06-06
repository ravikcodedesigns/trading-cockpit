// Discord webhook notifier for trader events.
// Fires async, never throws (Discord failures shouldn't block trading).

import { config } from './config.js';
import { logger } from './logger.js';

async function send(content: string): Promise<void> {
  if (!config.discordWebhook) return;
  try {
    const res = await fetch(config.discordWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, username: 'trader', avatar_url: 'https://i.imgur.com/AfFp7pu.png' }),
    });
    if (!res.ok) logger.warn({ status: res.status }, 'discord notify failed');
  } catch (err) {
    logger.warn({ err }, 'discord notify threw');
  }
}

function fmtPts(n: number): string { return (n >= 0 ? '+' : '') + n.toFixed(1); }
function fmtUsd(n: number): string { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }
function etTime(ts: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ts));
}

export const discord = {
  open(opts: { ruleId: string; direction: 'long' | 'short'; symbol: string; entry: number; tp: number; sl: number; pointValue: number; qty: number; }): void {
    const arrow = opts.direction === 'long' ? '↑' : '↓';
    const slUsd = opts.sl * opts.pointValue * opts.qty;
    void send(
      `🟢 **OPEN** | ${opts.ruleId.toUpperCase()} ${opts.direction.toUpperCase()} ${arrow} ${opts.symbol} @ **${opts.entry}** (${etTime(Date.now())} ET)\n` +
      `   TP ${opts.tp.toFixed(2)} (+${(opts.tp - opts.entry).toFixed(0)})  ·  SL ${opts.sl.toFixed(2)} (-${(opts.direction === 'long' ? opts.entry - opts.sl : opts.sl - opts.entry).toFixed(0)})  ·  Risk ${fmtUsd(-Math.abs(slUsd))}`
    );
  },

  close(opts: { reason: 'TP_HIT' | 'SL_HIT' | 'OPP_SIG_EXIT' | 'CLOSE_AT_BELL' | string; ruleId: string; direction: 'long' | 'short'; symbol: string; exitPx: number; pnlPts: number; pnlUsd: number; }): void {
    const icon = opts.reason === 'TP_HIT' ? '🔵 **TP**' :
                 opts.reason === 'SL_HIT' ? '🔴 **SL**' :
                 opts.reason === 'OPP_SIG_EXIT' ? '🟡 **OPP**' :
                 opts.reason === 'CLOSE_AT_BELL' ? '⏰ **BELL**' : '⚪ **CLOSE**';
    void send(
      `${icon} | ${opts.direction.toUpperCase()} ${opts.symbol} closed @ **${opts.exitPx}** (${fmtPts(opts.pnlPts)} pts, ${fmtUsd(opts.pnlUsd)}) — ${opts.reason}`
    );
  },

  reject(opts: { ruleId: string; direction: string; symbol: string; reason: string; }): void {
    void send(`🚨 **REJECT** | ${opts.ruleId} ${opts.direction.toUpperCase()} ${opts.symbol}: ${opts.reason}`);
  },

  block(opts: { ruleId: string; direction: string; symbol: string; blockReason: string; }): void {
    void send(`🛑 **BLOCKED** | ${opts.ruleId} ${opts.direction.toUpperCase()} ${opts.symbol}: ${opts.blockReason}`);
  },

  orphan(opts: { symbol: string; detail: string; }): void {
    void send(`⚠️ **ORPHAN** | ${opts.symbol}: ${opts.detail}`);
  },

  halt(reason: string): void {
    void send(`🚨🚨🚨 **TRADER HALTED** — ${reason}`);
  },

  startup(opts: { mode: string; rules: string[]; lossLimit: number; }): void {
    void send(
      `▶ **trader starting** | mode=${opts.mode} · rules=${opts.rules.join(',')} · daily-loss-cap=${fmtUsd(opts.lossLimit)}`
    );
  },

  dailySummary(opts: { trades: number; wins: number; losses: number; pnlPts: number; pnlUsd: number; }): void {
    const wr = opts.trades > 0 ? ((opts.wins / Math.max(opts.wins + opts.losses, 1)) * 100).toFixed(0) : '—';
    void send(
      `📊 **DAILY SUMMARY** | ${opts.trades} trades · ${opts.wins}W ${opts.losses}L · WR ${wr}% · ${fmtPts(opts.pnlPts)} pts · ${fmtUsd(opts.pnlUsd)}`
    );
  },
};
