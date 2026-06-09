// V3 tick router — drains new trade ticks from ticks.db and feeds them to
// CvdSession (for session-CVD updates) and TradeManager (for TP/SL checks
// on the currently open trade).
//
// Why polling vs an event bus: the aggregator currently has no central tick
// event bus. Strategies poll the tick-store (or query ticks.db) on their
// own cadence. Rather than introduce a new event bus, V3 does the same
// thing — polls ticks.db every 250ms when active.
//
// Lifecycle:
//   - start() — opens read-only handle, initializes lastSeenTs to "now",
//     and schedules the polling loop. Idempotent.
//   - stop()  — clears interval and closes the handle.
//
// Lifecycle guarantees:
//   - start() should be called AFTER CvdSession.hydrate(). lastSeenTs is
//     initialized to start time so we don't double-count ticks already
//     scanned by hydration.
//   - Runs unconditionally — pipeline is the only path post-cutover.
//   - When stopped, ticks pile up in ticks.db but are not consumed —
//     CvdSession will fall behind real cvd until restarted. Restart on a
//     fresh process re-hydrates from ticks.db, catching back up correctly.
//
// Failure modes:
//   - ticks.db inaccessible → router logs once and disables itself for the
//     session. Restart the process to recover.
//   - Poll query throws → logged, but the interval keeps trying so a
//     transient failure self-heals on the next poll.

import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { cvdSession } from './cvd-session.js';
import { tradeManager } from './trade-manager.js';

const POLL_INTERVAL_MS = 250;

interface TickRow {
  ts: number;
  price: number;
  size: number;
  is_bid_aggressor: number;
}

class TickRouter {
  private xdb: Database.Database | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;
  private lastSeenTs = new Map<string, number>();
  private disabled = false;

  /**
   * Start the polling loop. Idempotent — calling twice has no effect.
   * Runs unconditionally post-2026-06-09 pipeline cutover.
   */
  start(): void {
    if (this.intervalHandle || this.disabled) return;

    try {
      const ticksPath = path.join(path.dirname(config.dbPath), 'ticks.db');
      this.xdb = new Database(ticksPath, { readonly: true });
    } catch (err) {
      logger.error({ err: String(err) }, 'V3 tick router: ticks.db unavailable; disabling');
      this.disabled = true;
      return;
    }

    // Start at "now" — CvdSession.hydrate already counted everything up to here.
    const now = Date.now();
    for (const sym of config.pipeline.symbols) this.lastSeenTs.set(sym, now);

    this.intervalHandle = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    logger.info({ symbols: config.pipeline.symbols, pollMs: POLL_INTERVAL_MS }, 'V3 tick router started');
  }

  /** Stop the polling loop and close the DB handle. Safe to call repeatedly. */
  stop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.intervalHandle = null;
    if (this.xdb) {
      try { this.xdb.close(); } catch { /* ignore */ }
    }
    this.xdb = null;
  }

  /** Manual one-shot poll — exposed for tests. */
  pollOnce(): { delivered: number } {
    return this.poll();
  }

  private poll(): { delivered: number } {
    if (!this.xdb) return { delivered: 0 };

    const stmt = this.xdb.prepare(`
      SELECT ts, price, size, is_bid_aggressor FROM trades
      WHERE symbol = ? AND ts > ? AND ts <= ?
      ORDER BY ts ASC, id ASC
    `);
    const now = Date.now();
    let totalDelivered = 0;

    for (const sym of config.pipeline.symbols) {
      const since = this.lastSeenTs.get(sym) ?? 0;
      let rows: TickRow[];
      try {
        rows = stmt.all(sym, since, now) as TickRow[];
      } catch (err) {
        logger.warn({ err: String(err), sym }, 'V3 tick router: poll query failed');
        continue;
      }
      if (rows.length === 0) continue;

      let maxTs = since;
      for (const r of rows) {
        cvdSession.onTick(sym, r.ts, r.size, r.is_bid_aggressor as 0 | 1);
        tradeManager.onTick(sym, r.ts, r.price);
        if (r.ts > maxTs) maxTs = r.ts;
      }
      this.lastSeenTs.set(sym, maxTs);
      totalDelivered += rows.length;
    }
    return { delivered: totalDelivered };
  }
}

export const tickRouter = new TickRouter();
