// Durable TAPE-event store — every detected order-flow event (all 9 kinds) is appended to
// data/tape-events.db so the cockpit can BACKFILL markers for ANY historical range (scroll back,
// analyze how price action played out after each event). Without this the events live only in a
// 400-deep in-memory ring that's wiped when the last viewer disconnects.
//
// WRITTEN by the dedicated tape-worker (always tailing, buffered flush); READ by the aggregator's
// /tape/history endpoint. WAL mode makes the concurrent worker-write + aggregator-read across the
// two processes safe. All writes are wrapped so a persistence failure can never kill the worker.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Symbol as Sym, TapeEvent } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../../../data/tape-events.db');

let _db: Database.Database | null = null;
let _insert: Database.Statement | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tape_events (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL,
      t REAL NOT NULL,          -- event time, epoch SECONDS (aligns with candle axis)
      kind TEXT NOT NULL,
      price REAL NOT NULL,
      side TEXT NOT NULL,
      size INTEGER,
      levels INTEGER,
      refills INTEGER,
      life_ms INTEGER,
      lam_ratio REAL,
      state TEXT,
      native INTEGER,
      dur_ms INTEGER,
      signals TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tape_sym_t ON tape_events(symbol, t);
  `);
  // additive migrations for stores created before these columns
  try { db.exec('ALTER TABLE tape_events ADD COLUMN native INTEGER'); } catch { /* already present */ }
  try { db.exec('ALTER TABLE tape_events ADD COLUMN dur_ms INTEGER'); } catch { /* already present */ }
  try { db.exec('ALTER TABLE tape_events ADD COLUMN signals TEXT'); } catch { /* already present */ }
  try { db.exec('ALTER TABLE tape_events ADD COLUMN ep_id TEXT'); } catch { /* already present */ }
  try { db.exec('ALTER TABLE tape_events ADD COLUMN exec_ct INTEGER'); } catch { /* already present */ }
  try { db.exec('ALTER TABLE tape_events ADD COLUMN queue_ct INTEGER'); } catch { /* already present */ }
  try { db.exec('ALTER TABLE tape_events ADD COLUMN last_fill_t REAL'); } catch { /* already present */ }
  // 2026-07-15 audit rebuild: structural proximity + confluence families + spoof repetition,
  // and the outcome-labeler columns (fixed-horizon signed tick moves, stamped nightly by
  // scripts/label_tape_outcomes.ts — the falsifiability layer for every detector)
  try { db.exec('ALTER TABLE tape_events ADD COLUMN at_struct INTEGER'); } catch { /* already present */ }
  try { db.exec('ALTER TABLE tape_events ADD COLUMN families TEXT'); } catch { /* already present */ }
  try { db.exec('ALTER TABLE tape_events ADD COLUMN repeats INTEGER'); } catch { /* already present */ }
  try { db.exec('ALTER TABLE tape_events ADD COLUMN flip INTEGER'); } catch { /* already present */ }
  try { db.exec('ALTER TABLE tape_events ADD COLUMN out_30s REAL'); } catch { /* already present */ }
  try { db.exec('ALTER TABLE tape_events ADD COLUMN out_2m REAL'); } catch { /* already present */ }
  try { db.exec('ALTER TABLE tape_events ADD COLUMN out_5m REAL'); } catch { /* already present */ }
  try { db.exec('ALTER TABLE tape_events ADD COLUMN labeled_at REAL'); } catch { /* already present */ }
  // iceberg EPISODES re-emit under one ep_id (provisional 'active' → final held/broke) — upsert so
  // the store keeps exactly ONE row per episode, updated in place. Non-episode rows (ep_id NULL)
  // never hit the partial index and insert as before.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tape_ep ON tape_events(ep_id) WHERE ep_id IS NOT NULL');
  _db = db;
  _insert = db.prepare(`
    INSERT INTO tape_events (symbol, t, kind, price, side, size, levels, refills, life_ms, lam_ratio, state, native, dur_ms, signals, ep_id, exec_ct, queue_ct, last_fill_t, at_struct, families, repeats, flip)
    VALUES (@symbol, @t, @kind, @price, @side, @size, @levels, @refills, @life_ms, @lam_ratio, @state, @native, @dur_ms, @signals, @ep_id, @exec_ct, @queue_ct, @last_fill_t, @at_struct, @families, @repeats, @flip)
    ON CONFLICT(ep_id) WHERE ep_id IS NOT NULL DO UPDATE SET
      t = excluded.t, price = excluded.price, size = excluded.size, refills = excluded.refills,
      state = excluded.state, dur_ms = excluded.dur_ms,
      exec_ct = excluded.exec_ct, queue_ct = excluded.queue_ct, last_fill_t = excluded.last_fill_t,
      at_struct = excluded.at_struct,
      labeled_at = NULL, out_30s = NULL, out_2m = NULL, out_5m = NULL`);
  return db;
}

// ── Writer (tape-worker) ──────────────────────────────────────────────────────
const _buf: Array<{ sym: Sym; ev: TapeEvent }> = [];
let _flushTimer: NodeJS.Timeout | null = null;

/** Queue an event for durable persistence (buffered; flushed in batches). */
export function enqueueTapeEvent(sym: Sym, ev: TapeEvent): void { _buf.push({ sym, ev }); }

function flush(): void {
  if (!_buf.length) return;
  const rows = _buf.splice(0, _buf.length);
  const tx = getDb().transaction(() => {
    for (const { sym, ev } of rows) {
      _insert!.run({
        symbol: sym, t: ev.t, kind: ev.kind, price: ev.price, side: ev.side,
        size: ev.size ?? null, levels: ev.levels ?? null, refills: ev.refills ?? null,
        life_ms: ev.lifeMs ?? null, lam_ratio: ev.lamRatio ?? null, state: ev.state ?? null,
        native: ev.native == null ? null : (ev.native ? 1 : 0),
        dur_ms: ev.durMs ?? null,
        signals: ev.signals ? ev.signals.join(',') : null,
        ep_id: ev.epId ?? null,
        exec_ct: ev.exec ?? null, queue_ct: ev.queueCt ?? null, last_fill_t: ev.lastFillT ?? null,
        at_struct: ev.atStruct == null ? null : (ev.atStruct ? 1 : 0),
        families: ev.families ? ev.families.join(',') : null,
        repeats: ev.repeats ?? null,
        flip: ev.flip == null ? null : (ev.flip ? 1 : 0),
      });
    }
  });
  tx();
}

/** Start the buffered-flush loop. Call ONCE from the tape-worker. */
export function startTapePersist(flushMs = 750): void {
  if (_flushTimer) return;
  getDb();
  _flushTimer = setInterval(() => { try { flush(); } catch { /* never kill the worker */ } }, flushMs);
  if (typeof _flushTimer.unref === 'function') _flushTimer.unref();
}

/** Stop the flush loop and drain any buffered events. */
export function stopTapePersist(): void {
  if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
  try { flush(); } catch { /* noop */ }
}

// ── Reader (aggregator /tape/history) ─────────────────────────────────────────
/** Events for `sym` in [fromSec, toSec], chronological. Read-only; safe from the aggregator. */
export function queryTapeEvents(sym: Sym, fromSec: number, toSec: number, limit = 20000): TapeEvent[] {
  // Icebergs: serve only EPISODIC rows (ep_id) + legacy natives. The pre-2026-07-14 rolling
  // detector wrote ~32k synthetic rows/hour — loading those floods the chart with thousands of
  // markers per view and makes crosshair/scroll unusably laggy. Rows stay in the DB (filtered
  // at read, not deleted).
  const rows = getDb().prepare(`
    SELECT t, kind, price, side, size, levels, refills, life_ms AS lifeMs, lam_ratio AS lamRatio, state, native, dur_ms AS durMs, signals, ep_id AS epId,
           exec_ct AS exec, queue_ct AS queueCt, last_fill_t AS lastFillT, at_struct AS atStruct, families, repeats, flip
    FROM tape_events WHERE symbol = ? AND t >= ? AND t <= ?
      AND (kind != 'iceberg' OR ep_id IS NOT NULL OR native = 1)
    ORDER BY t ASC LIMIT ?
  `).all(sym, fromSec, toSec, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const ev: TapeEvent = { t: r.t as number, kind: r.kind as TapeEvent['kind'], price: r.price as number, side: r.side as TapeEvent['side'], size: (r.size as number) ?? 0 };
    if (r.levels != null) ev.levels = r.levels as number;
    if (r.refills != null) ev.refills = r.refills as number;
    if (r.lifeMs != null) ev.lifeMs = r.lifeMs as number;
    if (r.lamRatio != null) ev.lamRatio = r.lamRatio as number;
    if (r.state != null) ev.state = r.state as TapeEvent['state'];
    if (r.native != null) ev.native = !!r.native;
    if (r.durMs != null) ev.durMs = r.durMs as number;
    if (r.signals != null) ev.signals = String(r.signals).split(',');
    if (r.epId != null) ev.epId = r.epId as string;
    if (r.exec != null) ev.exec = r.exec as number;
    if (r.queueCt != null) ev.queueCt = r.queueCt as number;
    if (r.lastFillT != null) ev.lastFillT = r.lastFillT as number;
    if (r.atStruct != null) ev.atStruct = !!r.atStruct;
    if (r.families != null) ev.families = String(r.families).split(',');
    if (r.repeats != null) ev.repeats = r.repeats as number;
    if (r.flip != null) ev.flip = !!r.flip;
    return ev;
  });
}
