// Pushover push-notification sender for trader events.
// Fires async, never throws (notification failures shouldn't block trading).
//
// Surface mirrors discord.ts so the two can be called side-by-side from
// notify.ts. Differences vs Discord:
//   - <1s mobile delivery (Discord webhook → phone is 5-30m in practice)
//   - Per-event sound, so each event type has its own audible signature
//   - Emergency priority on halt (overrides silent mode, retries until
//     acknowledged in the Pushover iOS/macOS app)
//
// Setup: create an application at https://pushover.net/apps/build (free, the
// app token goes in PUSHOVER_TOKEN), then put your user key (top of
// https://pushover.net) in PUSHOVER_USER. Empty = disabled.

import { config } from './config.js';
import { logger } from './logger.js';

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

interface PushoverParams {
  title: string;
  message: string;
  /** Pushover built-in sound name. See pushover.net/api#sounds. */
  sound?: string;
  /** -2 (lowest, no notification) / -1 (quiet) / 0 (normal) / 1 (high — bypasses quiet hours) / 2 (emergency — repeats until ack). */
  priority?: -2 | -1 | 0 | 1 | 2;
  /** Required when priority=2: retry every N seconds (min 30). */
  retry?: number;
  /** Required when priority=2: stop retrying after N seconds (max 10800). */
  expire?: number;
  /** Set true to enable HTML formatting (<b>, <i>, <font color>, <a href>). */
  html?: boolean;
}

async function send(p: PushoverParams): Promise<void> {
  if (!config.pushoverUser || !config.pushoverToken) return;

  const body: Record<string, string | number> = {
    token:   config.pushoverToken,
    user:    config.pushoverUser,
    title:   p.title,
    message: p.message,
  };
  if (p.sound)    body.sound    = p.sound;
  if (p.priority !== undefined) body.priority = p.priority;
  if (p.retry)    body.retry    = p.retry;
  if (p.expire)   body.expire   = p.expire;
  if (p.html)     body.html     = 1;

  try {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) form.set(k, String(v));
    const res = await fetch(PUSHOVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: text.slice(0, 200) }, 'pushover notify failed');
    }
  } catch (err) {
    logger.warn({ err }, 'pushover notify threw');
  }
}

function fmtPts(n: number): string { return (n >= 0 ? '+' : '') + n.toFixed(1); }
function fmtUsd(n: number): string { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }
function etTime(ts: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(ts));
}

export const pushover = {
  open(opts: { ruleId: string; direction: 'long' | 'short'; symbol: string; entry: number; tp: number; sl: number; pointValue: number; qty: number; }): void {
    const arrow = opts.direction === 'long' ? '↑' : '↓';
    const slRiskUsd = opts.sl * opts.pointValue * opts.qty;
    const tpPts = (opts.tp - opts.entry).toFixed(0);
    const slPts = (opts.direction === 'long' ? opts.entry - opts.sl : opts.sl - opts.entry).toFixed(0);
    void send({
      title:   `🟢 OPEN · ${opts.ruleId.toUpperCase()} ${opts.direction.toUpperCase()} ${arrow} ${opts.symbol}`,
      message: `@ ${opts.entry} (${etTime(Date.now())} ET)\nTP ${opts.tp.toFixed(2)} (+${tpPts})   SL ${opts.sl.toFixed(2)} (-${slPts})\nRisk ${fmtUsd(-Math.abs(slRiskUsd))}`,
      sound:    'magic',
      priority: 0,
    });
  },

  close(opts: { reason: 'TP_HIT' | 'SL_HIT' | 'OPP_SIG_EXIT' | 'CLOSE_AT_BELL' | string; ruleId: string; direction: 'long' | 'short'; symbol: string; exitPx: number; pnlPts: number; pnlUsd: number; }): void {
    const meta =
      opts.reason === 'TP_HIT'        ? { icon: '🔵', tag: 'TP',   sound: 'cashregister' } :
      opts.reason === 'SL_HIT'        ? { icon: '🔴', tag: 'SL',   sound: 'falling'      } :
      opts.reason === 'OPP_SIG_EXIT'  ? { icon: '🟡', tag: 'OPP',  sound: 'classical'    } :
      opts.reason === 'CLOSE_AT_BELL' ? { icon: '⏰', tag: 'BELL', sound: 'intermission' } :
                                        { icon: '⚪', tag: 'CLOSE', sound: 'pushover'    };
    void send({
      title:   `${meta.icon} ${meta.tag} · ${opts.symbol} ${opts.direction.toUpperCase()}`,
      message: `Exit @ ${opts.exitPx}\n${fmtPts(opts.pnlPts)} pts · ${fmtUsd(opts.pnlUsd)}\n${opts.reason}`,
      sound:    meta.sound,
      priority: 0,
    });
  },

  reject(opts: { ruleId: string; direction: string; symbol: string; reason: string; }): void {
    // Signal fired but the broker order didn't get placed — high priority so
    // it surfaces immediately even during quiet hours.
    void send({
      title:    `🚨 REJECT · ${opts.ruleId} ${opts.direction.toUpperCase()} ${opts.symbol}`,
      message:  opts.reason,
      sound:    'siren',
      priority: 1,
    });
  },

  block(opts: { ruleId: string; direction: string; symbol: string; blockReason: string; }): void {
    // Informational; signal didn't trade because of a risk gate. Low priority.
    void send({
      title:    `🛑 BLOCKED · ${opts.ruleId} ${opts.direction.toUpperCase()} ${opts.symbol}`,
      message:  opts.blockReason,
      sound:    'echo',
      priority: -1,
    });
  },

  orphan(opts: { symbol: string; detail: string; }): void {
    // Orphan bracket detected by position-watcher — possibly a manual flatten
    // with stale exit orders. Worth waking up for.
    void send({
      title:    `⚠️ ORPHAN · ${opts.symbol}`,
      message:  opts.detail,
      sound:    'siren',
      priority: 1,
    });
  },

  halt(reason: string): void {
    // Trader has tripped an unprotected-position or close-failure halt.
    // Emergency priority: bypasses Do Not Disturb, repeats until the
    // notification is acknowledged in the Pushover app.
    void send({
      title:    '🚨🚨🚨 TRADER HALTED',
      message:  reason,
      sound:    'persistent',
      priority: 2,
      retry:    60,
      expire:   300,
    });
  },

  startup(opts: { mode: string; rules: string[]; lossLimit: number; }): void {
    void send({
      title:    `▶️ Trader starting · ${opts.mode}`,
      message:  `rules=${opts.rules.join(',')}\ndaily-loss-cap=${fmtUsd(opts.lossLimit)}`,
      sound:    'none',
      priority: -1,
    });
  },

  dailySummary(opts: { trades: number; wins: number; losses: number; pnlPts: number; pnlUsd: number; }): void {
    const wr = opts.trades > 0 ? ((opts.wins / Math.max(opts.wins + opts.losses, 1)) * 100).toFixed(0) : '—';
    void send({
      title:    `📊 Daily summary · ${fmtUsd(opts.pnlUsd)}`,
      message:  `${opts.trades} trades · ${opts.wins}W ${opts.losses}L · WR ${wr}%\n${fmtPts(opts.pnlPts)} pts`,
      sound:    'none',
      priority: -1,
    });
  },
};
