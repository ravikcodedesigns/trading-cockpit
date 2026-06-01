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
  | null;

export function checkCanTrade(signalTs: number): BlockReason {
  // Manual kill switch
  if (fs.existsSync(HALT_FILE)) {
    logger.warn('HALT FILE present — all trading blocked');
    return 'halt_file';
  }

  // RTH only
  if (!isRTH(Date.now())) {
    return 'outside_rth';
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
