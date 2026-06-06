import fs from 'node:fs';
import { config } from './config.js';
import { posDb } from './db.js';
import { logger } from './logger.js';

const HALT_FILE = '/tmp/trader.halt';

function isRTH(tsMs: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(get('weekday')) && min >= 570 && min < 960;
}

export type BlockReason =
  | 'halt_file'
  | 'outside_rth'
  | 'daily_loss_limit'
  | 'max_positions'
  | 'duplicate_signal'
  | 'news_blackout'
  | 'flip_long_pre_1030'
  | 'after_1430_stop'
  | null;

// ── News blackout window ─────────────────────────────────────────────────────
// Hard-coded list of high-impact economic releases for June 2026.
// Time format: ET (HH:MM, 24h). Trader will block new OPEN signals within
// ±15 min of each release. Update monthly.
//
// Sources for typical timing: FOMC press release usually 14:00 ET on meeting
// day; CPI/PPI/retail-sales/NFP at 08:30 ET on release day.
const NEWS_BLACKOUT_WINDOW_MS = 15 * 60_000;
const NEWS_EVENTS_2026_06: Array<{ date: string; time: string; label: string }> = [
  // FOMC June 17-18 meeting → decision 2026-06-18 14:00 ET; minutes 3 weeks later (skip).
  { date: '2026-06-18', time: '14:00', label: 'FOMC decision' },
  // CPI: typically mid-month at 08:30 ET (June 11 2026 expected).
  { date: '2026-06-11', time: '08:30', label: 'CPI' },
  // PPI: day after CPI (June 12 2026).
  { date: '2026-06-12', time: '08:30', label: 'PPI' },
  // Retail Sales: typically mid-month (June 17 2026).
  { date: '2026-06-17', time: '08:30', label: 'Retail Sales' },
  // NFP: 1st Friday of month (June 5 2026 — TOMORROW).
  { date: '2026-06-05', time: '08:30', label: 'NFP (Nonfarm Payrolls)' },
  // ADP: Wednesday before NFP (June 3 2026 — already past).
  { date: '2026-06-03', time: '08:15', label: 'ADP Employment' },
];

function etDateTimeToMs(dateStr: string, timeStr: string): number {
  // Convert "YYYY-MM-DD" + "HH:MM" ET to UTC milliseconds.
  // June 2026 is EDT (UTC-4).
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return Date.UTC(y!, m! - 1, d!, hh! + 4, mm!);
}

function checkNewsBlackout(nowMs: number): { blocked: boolean; label?: string; minutesAway?: number } {
  for (const ev of NEWS_EVENTS_2026_06) {
    const eventMs = etDateTimeToMs(ev.date, ev.time);
    const diff = Math.abs(nowMs - eventMs);
    if (diff <= NEWS_BLACKOUT_WINDOW_MS) {
      const minutesAway = Math.round((nowMs - eventMs) / 60_000);
      return { blocked: true, label: ev.label, minutesAway };
    }
  }
  return { blocked: false };
}

// ── Time-of-day gate (data-driven 2026-06-04) ────────────────────────────────
// FLIP LONG: trade 10:30+ only. Qualified LONG WR 09:30-10:30 = 40% (n=5), too weak.
//            10:30+ = 65% WR / +$2,481 cumulative over 60-day backtest.
// FLIP SHORT: trade all RTH (chart "take all", 78% WR / +$1,400 over 18 quals).
// Universal STOP after 14:30 ET for NEW opens (existing positions still close
// via TP/SL/opp/bell). No qualified FLIPs after 14:30 in the dataset, so this
// is effectively a no-op for FLIPs but is a safe universal cutoff.
const FLIP_LONG_START_MIN = 10 * 60 + 30;   // 10:30 ET
const UNIVERSAL_STOP_MIN  = 14 * 60 + 30;   // 14:30 ET

function getETMin(tsMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(tsMs));
  const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  return h * 60 + m;
}

function checkTimeWindow(direction: 'long' | 'short', nowMs: number): BlockReason {
  const etMin = getETMin(nowMs);
  if (etMin >= UNIVERSAL_STOP_MIN) return 'after_1430_stop';
  if (direction === 'long' && etMin < FLIP_LONG_START_MIN) return 'flip_long_pre_1030';
  return null;
}

export function checkCanTrade(signalTs: number, direction: 'long' | 'short'): BlockReason {
  // Manual kill switch
  if (fs.existsSync(HALT_FILE)) {
    logger.warn('HALT FILE present — all trading blocked');
    return 'halt_file';
  }

  // RTH only — bypass with TRADER_BYPASS_RTH=1 for after-hours demo testing
  if (!isRTH(Date.now()) && process.env.TRADER_BYPASS_RTH !== '1') {
    return 'outside_rth';
  }
  if (process.env.TRADER_BYPASS_RTH === '1' && !isRTH(Date.now())) {
    logger.warn('TRADER_BYPASS_RTH=1 — RTH check skipped (test mode)');
  }

  // News blackout (FOMC/CPI/NFP ±15min)
  const news = checkNewsBlackout(Date.now());
  if (news.blocked) {
    logger.warn({ event: news.label, minutesFromEvent: news.minutesAway }, 'news blackout — trading blocked');
    return 'news_blackout';
  }

  // Time-of-day window (data-driven, 2026-06-04): FLIP LONG ≥10:30, all STOP ≥14:30.
  // Same TRADER_BYPASS_RTH flag also bypasses this gate so after-hours tests work.
  if (process.env.TRADER_BYPASS_RTH !== '1') {
    const todBlock = checkTimeWindow(direction, Date.now());
    if (todBlock) {
      logger.info({ block: todBlock, direction, etMin: getETMin(Date.now()) }, 'time-window gate blocked signal');
      return todBlock;
    }
  }

  // Daily loss limit
  const todayPnl = posDb.todayPnl();
  if (todayPnl <= config.risk.maxDailyLoss) {
    logger.warn({ todayPnl, limit: config.risk.maxDailyLoss }, 'daily loss limit hit — trading blocked');
    return 'daily_loss_limit';
  }

  // Max concurrent positions
  const open = posDb.openPositions();
  if (open.length >= config.risk.maxPositions) {
    return 'max_positions';
  }

  // Duplicate signal (same signal_ts already in DB)
  const existing = posDb.getBySignalTs(signalTs);
  if (existing) {
    return 'duplicate_signal';
  }

  return null;
}

export function createHaltFile(reason: string) {
  fs.writeFileSync(HALT_FILE, `${new Date().toISOString()} — ${reason}\n`);
  logger.error({ reason }, 'halt file created — trader stopped');
}

export function removeHaltFile() {
  try { fs.unlinkSync(HALT_FILE); } catch { /* already gone */ }
}
