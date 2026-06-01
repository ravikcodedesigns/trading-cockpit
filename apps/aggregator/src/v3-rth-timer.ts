// V3 RTH-close timer.
//
// At config.v3.rthCloseEt (default '15:54:00' ET — 8 min before the broker
// 15:55 margin deadline), any currently-open V3 trade is force-closed at the
// most recent tick price.
//
// Mechanics:
//   - setInterval polls every 30s to see whether the ET clock has just
//     crossed the configured close time.
//   - Triggers at most once per RTH day (tracked by dateKey).
//   - For each symbol in config.v3.symbols with an open trade:
//       - Look up the latest tick price.
//       - Call tradeManager.onRthClose(symbol, px, ts) — emits CLOSE_AT_BELL.
//   - No-op when config.v3.activeMode === 'off'.
//
// Lifecycle: start() at boot, stop() on shutdown. Same shape as the tick
// router.

import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { tradeManager } from './trade-manager.js';

const CHECK_INTERVAL_MS = 30_000;

function etNow(): { date: string; hh: number; mm: number; ss: number } {
  const tsMs = Date.now();
  const d = new Date(tsMs - 4 * 60 * 60_000);  // EDT
  return {
    date: `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`,
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    ss: d.getUTCSeconds(),
  };
}

function parseHms(s: string): { h: number; m: number; sec: number } {
  const parts = s.split(':').map(Number);
  return { h: parts[0] ?? 0, m: parts[1] ?? 0, sec: parts[2] ?? 0 };
}

class V3RthTimer {
  private intervalHandle: NodeJS.Timeout | null = null;
  private xdb: Database.Database | null = null;
  private lastFiredDate = '';

  start(): void {
    if (this.intervalHandle) return;
    if (config.v3.activeMode === 'off') return;

    try {
      const ticksPath = path.join(path.dirname(config.dbPath), 'ticks.db');
      this.xdb = new Database(ticksPath, { readonly: true });
    } catch (err) {
      logger.error({ err: String(err) }, 'V3 RTH timer: ticks.db unavailable; disabling');
      return;
    }

    this.intervalHandle = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    logger.info({ closeEt: config.v3.rthCloseEt }, 'V3 RTH timer started');
  }

  stop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.intervalHandle = null;
    if (this.xdb) {
      try { this.xdb.close(); } catch { /* ignore */ }
    }
    this.xdb = null;
  }

  /** Public for tests: run the check logic once. */
  checkOnce(): void { this.check(); }

  private check(): void {
    if (!this.xdb) return;
    const now = etNow();
    if (now.date === this.lastFiredDate) return;     // already fired today
    const target = parseHms(config.v3.rthCloseEt);
    // Fire when ET clock has passed target. We use ≥ on hour/minute.
    const past = (now.hh > target.h)
              || (now.hh === target.h && now.mm >= target.m);
    if (!past) return;
    // Also avoid firing on a brand-new boot at 04:00 ET (e.g. machine started before market):
    // target hour 15 means we only fire after 15:00 ET. The check above handles that
    // because we compare to target hour/minute.
    this.fire(now.date);
  }

  private fire(dateKey: string): void {
    this.lastFiredDate = dateKey;
    const nowMs = Date.now();
    for (const sym of config.v3.symbols) {
      const t = tradeManager.getOpen(sym);
      if (!t) continue;
      const px = this.latestTickPrice(sym, nowMs);
      if (px == null) {
        logger.warn({ sym }, 'V3 RTH timer: no recent tick to close trade; using entry price');
      }
      tradeManager.onRthClose(sym, px ?? t.entry, nowMs);
    }
    logger.info({ dateKey, closeEt: config.v3.rthCloseEt }, 'V3 RTH timer fired');
  }

  private latestTickPrice(symbol: string, tsMs: number): number | null {
    if (!this.xdb) return null;
    const row = this.xdb.prepare(
      `SELECT price FROM trades WHERE symbol=? AND ts<=? ORDER BY ts DESC LIMIT 1`
    ).get(symbol, tsMs) as { price: number } | undefined;
    return row?.price ?? null;
  }
}

export const v3RthTimer = new V3RthTimer();
