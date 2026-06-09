// CvdSession — per-symbol cumulative volume delta anchored at the RTH open
// (09:30 ET). Used by the V3 trade manager as a regime gate at signal entry:
//   - LONG entries blocked when cvdSession <= cvdLongFloor
//   - SHORT entries blocked when cvdSession >= cvdShortFloor
//
// Conventions:
//   - is_bid_aggressor=1 is a BUY-aggressor trade (empirical; the Python
//     bookmap addon comment is misleading). +size for buys, -size for sells.
//   - Only ticks in [09:30 ET, 16:00 ET) accumulate. Pre/post-market ticks
//     do not move the counter.
//   - On a new ET day, the counter resets when the first in-RTH tick arrives.
//
// Lifecycle:
//   - construct → state empty
//   - hydrate() → on startup, scan ticks.db for today's RTH ticks and
//     compute the running CVD up to "now". Idempotent.
//   - onTick(symbol, ts, size, isBidAggressor) → fold a live tick.
//   - get(symbol) → current running CVD for the symbol.
//
// This module is standalone and zero-side-effect when nobody calls it.
// V3 hooks invoke it from state.ts and the tick router only when
// config.pipeline.activeMode === 'live'.

import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

type SymbolLike = string;

const ET_OFFSET_MS = 4 * 60 * 60_000;   // EDT (May 2026)
const RTH_OPEN_ET  = { h: 9,  m: 30 };
const RTH_CLOSE_ET = { h: 16, m: 0  };  // Strictly less-than 16:00 ET counts.

interface SessionState {
  etDate: string;   // YYYY-MM-DD in ET
  cvd: number;
}

function etDateOf(tsMs: number): string {
  const d = new Date(tsMs - ET_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function rthBoundsForEtDate(etDate: string): { openMs: number; closeMs: number } {
  // etDate format: YYYY-MM-DD. We compute UTC ms for 09:30 ET and 16:00 ET
  // on that ET-naive date. EDT = UTC-4: 09:30 ET = 13:30 UTC, 16:00 ET = 20:00 UTC.
  const parts = etDate.split('-').map(Number);
  const y = parts[0]!, m = parts[1]!, d = parts[2]!;
  const openMs  = Date.UTC(y, m - 1, d, RTH_OPEN_ET.h  + 4, RTH_OPEN_ET.m, 0, 0);
  const closeMs = Date.UTC(y, m - 1, d, RTH_CLOSE_ET.h + 4, RTH_CLOSE_ET.m, 0, 0);
  return { openMs, closeMs };
}

function isInsideRth(tsMs: number): boolean {
  const etDate = etDateOf(tsMs);
  const { openMs, closeMs } = rthBoundsForEtDate(etDate);
  return tsMs >= openMs && tsMs < closeMs;
}

export class CvdSession {
  private state: Map<SymbolLike, SessionState> = new Map();

  /**
   * Recompute today's RTH CVD for each configured symbol by scanning ticks.db.
   * Call once on startup (or after a long pause) to rebuild in-memory state.
   * Safe to call multiple times — it replaces existing state for those symbols.
   *
   * If the system is started before 09:30 ET, this is a no-op (no RTH ticks yet).
   */
  hydrate(symbols: readonly SymbolLike[]): void {
    const ticksDbPath = path.join(path.dirname(config.dbPath), 'ticks.db');
    let xdb: Database.Database | null = null;
    try {
      xdb = new Database(ticksDbPath, { readonly: true });
    } catch (err) {
      logger.warn({ err: String(err) }, 'CvdSession.hydrate: ticks.db unavailable; starting empty');
      return;
    }
    const now = Date.now();
    const etDate = etDateOf(now);
    const { openMs, closeMs } = rthBoundsForEtDate(etDate);
    const upTo = Math.min(now, closeMs);
    if (upTo <= openMs) {
      // Pre-market — nothing to count yet. Initialize entries so symbols
      // are tracked from cvd=0 once RTH opens.
      for (const sym of symbols) this.state.set(sym, { etDate, cvd: 0 });
      try { xdb.close(); } catch { /* ignore */ }
      logger.info({ etDate }, 'CvdSession.hydrate: pre-market, initialized at 0');
      return;
    }

    const stmt = xdb.prepare(`
      SELECT SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) AS cvd
      FROM trades
      WHERE symbol = ? AND ts >= ? AND ts <= ?
    `);
    for (const sym of symbols) {
      const row = stmt.get(sym, openMs, upTo) as { cvd: number | null } | undefined;
      const cvd = row?.cvd ?? 0;
      this.state.set(sym, { etDate, cvd });
      logger.info({ symbol: sym, etDate, cvd, scanned: `${openMs}→${upTo}` }, 'CvdSession.hydrate');
    }
    try { xdb.close(); } catch { /* ignore */ }
  }

  /**
   * Fold a live trade tick into the session counter.
   * Called from the tick-router for each NQ (or other tracked) trade.
   *
   * - Pre- or post-RTH ticks are dropped (no effect).
   * - If the ET date has rolled since the last in-RTH tick, the counter
   *   resets to 0 first.
   */
  onTick(symbol: SymbolLike, tsMs: number, size: number, isBidAggressor: 0 | 1): void {
    if (!isInsideRth(tsMs)) return;
    const etDate = etDateOf(tsMs);
    let s = this.state.get(symbol);
    if (!s || s.etDate !== etDate) {
      s = { etDate, cvd: 0 };
      this.state.set(symbol, s);
    }
    s.cvd += isBidAggressor === 1 ? size : -size;
  }

  /** Current cumulative session CVD for the symbol. 0 if not tracked or pre-RTH. */
  get(symbol: SymbolLike): number {
    const s = this.state.get(symbol);
    if (!s) return 0;
    // Stale check: if today's ET date differs from the stored snapshot,
    // the counter from a previous day is meaningless until the first
    // in-RTH tick arrives and resets it. Return 0 in that case.
    if (s.etDate !== etDateOf(Date.now())) return 0;
    return s.cvd;
  }

  /** For tests / diagnostics. */
  snapshot(): Array<{ symbol: SymbolLike; etDate: string; cvd: number }> {
    return [...this.state.entries()].map(([symbol, s]) => ({ symbol, etDate: s.etDate, cvd: s.cvd }));
  }
}

// Module-level singleton. Importers reuse the same instance.
export const cvdSession = new CvdSession();
