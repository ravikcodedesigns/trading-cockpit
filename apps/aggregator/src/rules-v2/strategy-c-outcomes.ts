// Strategy C Outcome Tracker
//
// For every Strategy C signal, tracks price at fixed checkpoints:
//   5m, 10m, 20m, 30m, 40m, 60m after signal
//
// Key metrics:
//   - Did it move 20pts in signal direction? How long?
//   - Did it move 40pts in signal direction? How long?
//   - Max adverse excursion (drawdown) before the move
//   - Stop hit (8pts adverse) before target reached?
//
// Results stored in signal_outcomes_c table.
// Report via: pnpm --filter aggregator score:report:c

import { db } from '../db.js';
import { getRecentTrades } from './tick-client.js';
import type { Symbol } from '@trading/contracts';
import { logger } from '../logger.js';

const CHECKPOINTS_MIN = [5, 10, 20, 30, 40, 60];
const TARGET_20 = 20;
const TARGET_40 = 40;
const STOP_PTS = 8;

interface PendingOutcome {
  signalId: number;
  symbol: Symbol;
  direction: 'long' | 'short';
  entryPrice: number;
  signalTs: number;
  levelLabel: string;
  levelPrice: number;
  touchCount: number;
  timeToConfirmMs: number;
  checkpoints: Record<number, number | null>;  // min -> price
  hit20: boolean;
  hit20At: number | null;   // ms after signal
  hit40: boolean;
  hit40At: number | null;
  maxAdverse: number;
  stopped: boolean;
  matured: boolean;
}

const _pending: Map<number, PendingOutcome> = new Map();

// Called once at startup to create table if not exists
export function initOutcomeTable(): void {
  (db as any)._db?.exec(`
    CREATE TABLE IF NOT EXISTS signal_outcomes_c (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_price REAL NOT NULL,
      signal_ts INTEGER NOT NULL,
      level_label TEXT NOT NULL,
      level_price REAL NOT NULL,
      touch_count INTEGER NOT NULL,
      time_to_confirm_ms INTEGER NOT NULL,
      p5m REAL, p10m REAL, p20m REAL, p30m REAL, p40m REAL, p60m REAL,
      hit20 INTEGER DEFAULT 0,
      hit20_ms INTEGER,
      hit40 INTEGER DEFAULT 0,
      hit40_ms INTEGER,
      max_adverse REAL DEFAULT 0,
      stopped INTEGER DEFAULT 0,
      matured_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sc_signal_id ON signal_outcomes_c(signal_id);
    CREATE INDEX IF NOT EXISTS idx_sc_level ON signal_outcomes_c(level_label);
  `);
}

export function trackSignalC(
  signalId: number,
  symbol: Symbol,
  direction: 'long' | 'short',
  entryPrice: number,
  signalTs: number,
  levelLabel: string,
  levelPrice: number,
  touchCount: number,
  timeToConfirmMs: number
): void {
  _pending.set(signalId, {
    signalId, symbol, direction, entryPrice, signalTs,
    levelLabel, levelPrice, touchCount, timeToConfirmMs,
    checkpoints: {}, hit20: false, hit20At: null,
    hit40: false, hit40At: null, maxAdverse: 0,
    stopped: false, matured: false,
  });
  logger.debug({ signalId, symbol, direction, entryPrice, levelLabel }, 'strategy-C: tracking outcome');
}

export async function tickOutcomes(nowMs: number): Promise<void> {
  for (const [id, p] of _pending.entries()) {
    if (p.matured) continue;

    const elapsedMin = (nowMs - p.signalTs) / 60_000;

    // Get latest price from tick-store
    const trades = await getRecentTrades(p.symbol, nowMs - 5000);
    if (!trades.length) continue;
    const currentPrice = trades[trades.length - 1].price;

    // Movement in signal direction
    const movement = p.direction === 'long'
      ? currentPrice - p.entryPrice
      : p.entryPrice - currentPrice;

    // Adverse excursion (drawdown)
    const adverse = p.direction === 'long'
      ? p.entryPrice - currentPrice
      : currentPrice - p.entryPrice;

    if (adverse > p.maxAdverse) p.maxAdverse = adverse;

    // Stop check (8pts adverse before target)
    if (!p.stopped && !p.hit20 && adverse >= STOP_PTS) {
      p.stopped = true;
    }

    // Target checks (only if not stopped)
    if (!p.stopped) {
      if (!p.hit20 && movement >= TARGET_20) {
        p.hit20 = true;
        p.hit20At = nowMs - p.signalTs;
      }
      if (!p.hit40 && movement >= TARGET_40) {
        p.hit40 = true;
        p.hit40At = nowMs - p.signalTs;
      }
    }

    // Checkpoint price recording
    for (const cp of CHECKPOINTS_MIN) {
      if (p.checkpoints[cp] === undefined && elapsedMin >= cp) {
        p.checkpoints[cp] = currentPrice;
      }
    }

    // Maturity: 60 min after signal
    if (elapsedMin >= 60) {
      p.matured = true;

      // Write to DB
      try {
        (db as any)._db?.prepare(`
          INSERT OR REPLACE INTO signal_outcomes_c (
            signal_id, symbol, direction, entry_price, signal_ts,
            level_label, level_price, touch_count, time_to_confirm_ms,
            p5m, p10m, p20m, p30m, p40m, p60m,
            hit20, hit20_ms, hit40, hit40_ms,
            max_adverse, stopped, matured_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          p.signalId, p.symbol, p.direction, p.entryPrice, p.signalTs,
          p.levelLabel, p.levelPrice, p.touchCount, p.timeToConfirmMs,
          p.checkpoints[5] ?? null, p.checkpoints[10] ?? null,
          p.checkpoints[20] ?? null, p.checkpoints[30] ?? null,
          p.checkpoints[40] ?? null, p.checkpoints[60] ?? null,
          p.hit20 ? 1 : 0, p.hit20At ?? null,
          p.hit40 ? 1 : 0, p.hit40At ?? null,
          p.maxAdverse, p.stopped ? 1 : 0, nowMs
        );

        logger.info({
          signalId: p.signalId, symbol: p.symbol, direction: p.direction,
          levelLabel: p.levelLabel, hit20: p.hit20, hit40: p.hit40,
          hit20Min: p.hit20At ? (p.hit20At / 60000).toFixed(1) : null,
          hit40Min: p.hit40At ? (p.hit40At / 60000).toFixed(1) : null,
          maxAdverse: p.maxAdverse.toFixed(1), stopped: p.stopped,
        }, 'strategy-C: outcome matured');
      } catch (err) {
        logger.warn({ err, signalId: id }, 'strategy-C: failed to write outcome');
      }

      _pending.delete(id);
    }
  }
}

export function getPendingCount(): number {
  return _pending.size;
}
