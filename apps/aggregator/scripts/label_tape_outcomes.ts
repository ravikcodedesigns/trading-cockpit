// TAPE outcome labeler — stamps every detected tape event with FIXED-HORIZON forward outcomes so
// each detector accrues a falsifiable sample (P(move | event kind/tier/at-structure) instead of
// hand-set weights). Runs nightly (com.cockpit.tape-outcomes) after the parquet converter settles.
//
//   out_30s / out_2m / out_5m — signed TICK move from the last trade at event time to the last
//   trade at t+horizon, SIGNED BY THE EVENT'S EXPECTED DIRECTION (src/tape/direction.ts — the
//   same table confluence scores with, so the score and the validation sample can't disagree).
//   Positive = price moved the way the event predicted.
//
// FIXED horizons only — never MFE/MAE (house rule). Events too fresh for the 5m horizon are left
// for the next run; days whose parquet hasn't converted yet are skipped and retried. Iceberg
// 'active' provisional rows are skipped (the episode upsert clears labels on every re-emit; only
// the resolved held/broke row is worth labeling).
//
// Idempotent + additive: only touches rows WHERE labeled_at IS NULL.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../src/lib/mbo-reader.js';
import { expectedDir } from '../src/tape/direction.js';
import type { TapeEvent } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../../data/tape-events.db');
const TICK = 0.25;
const HORIZONS: Array<[col: string, sec: number]> = [['out_30s', 30], ['out_2m', 120], ['out_5m', 300]];
const MAX_H = 300;

interface Row {
  id: number; symbol: string; t: number; kind: TapeEvent['kind']; side: 'buy' | 'sell';
  state: string | null; levels: number | null; at_struct: number | null;
}

function etDate(epochSec: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(epochSec * 1000));
}

async function frontContract(symbol: string, day: string): Promise<string | null> {
  const r: any[] = await query(`SELECT contract, count(*) n FROM mbo_trades WHERE symbol='${symbol}' AND date='${day}' GROUP BY contract ORDER BY n DESC LIMIT 1`);
  return r[0]?.contract ?? null;
}

// price at-or-before tsMs via binary search over the day's (sorted) trade tape; null before first trade
function priceAt(ts: Float64Array, px: Float64Array, tsMs: number): number | null {
  let lo = 0, hi = ts.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m]! <= tsMs) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? px[ans]! : null;
}

async function main(): Promise<void> {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 15000');   // the tape-worker holds this DB (WAL) — wait out its flushes
  // defensive: the labeler may run against a store the worker hasn't migrated yet
  for (const c of ['out_30s REAL', 'out_2m REAL', 'out_5m REAL', 'labeled_at REAL']) {
    try { db.exec(`ALTER TABLE tape_events ADD COLUMN ${c}`); } catch { /* present */ }
  }

  const nowSec = Date.now() / 1000;
  const pending = db.prepare(`
    SELECT id, symbol, t, kind, side, state, levels, at_struct FROM tape_events
    WHERE labeled_at IS NULL
      AND t <= ?
      AND (state IS NULL OR state != 'active')   -- unresolved lifecycles (iceberg/wall/stoprun) label at resolution
      AND (kind != 'iceberg' OR ep_id IS NOT NULL OR native = 1)
    ORDER BY symbol, t
    LIMIT 200000
  `).all(nowSec - MAX_H - 60) as Row[];
  if (!pending.length) { console.log('nothing to label'); return; }

  // group by (symbol, ET day) → one parquet read per day
  const groups = new Map<string, Row[]>();
  for (const r of pending) {
    const key = `${r.symbol}|${etDate(r.t)}`;
    let g = groups.get(key); if (!g) { g = []; groups.set(key, g); }
    g.push(r);
  }

  const upd = db.prepare('UPDATE tape_events SET out_30s = ?, out_2m = ?, out_5m = ?, labeled_at = ? WHERE id = ?');
  const today = etDate(nowSec);
  let labeled = 0, skippedDays = 0;
  const byKind = new Map<string, { n: number; sum30: number; sum2: number; sum5: number }>();

  for (const [key, rows] of groups) {
    const [symbol, day] = key.split('|') as [string, string];
    const c = await frontContract(symbol, day);
    if (!c) { skippedDays++; continue; }   // parquet hasn't converted this day yet → retry next run
    const tr: any[] = await query(`SELECT ts_ms, price FROM mbo_trades WHERE symbol='${symbol}' AND contract='${c}' AND date='${day}' AND size>0 ORDER BY ts_ms`);
    if (tr.length < 100) { skippedDays++; continue; }
    const ts = new Float64Array(tr.length), px = new Float64Array(tr.length);
    for (let i = 0; i < tr.length; i++) { ts[i] = Number(tr[i].ts_ms); px[i] = Number(tr[i].price); }
    const lastTs = ts[ts.length - 1]!;
    const dayFinal = day < today;   // a finished day: missing tail horizons will never materialize

    const txn = db.transaction((batch: Row[]) => {
      for (const r of batch) {
        const dir = expectedDir(r as any);
        const t0 = r.t * 1000;
        const p0 = priceAt(ts, px, t0);
        if (p0 == null) { if (dayFinal) upd.run(null, null, null, nowSec, r.id); continue; }
        const outs: Array<number | null> = [];
        let missing = false;
        for (const [, hSec] of HORIZONS) {
          const tH = t0 + hSec * 1000;
          if (tH > lastTs) { outs.push(null); missing = true; continue; }
          const pH = priceAt(ts, px, tH)!;
          outs.push(dir === 0 ? null : +(((pH - p0) / TICK) * dir).toFixed(1));
        }
        if (missing && !dayFinal) continue;   // horizons still filling in — retry next run
        upd.run(outs[0], outs[1], outs[2], nowSec, r.id);
        labeled++;
        // confluence rows split by decision cohort: family count, at-structure, session — the
        // splits the star graduates (or dies) on
        const et = new Date(r.t * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
        const rth = et >= '09:30:00' && et < '16:00:00';
        const k = r.kind === 'confluence'
          ? `${r.symbol} confluence·f${r.levels ?? '?'}${r.at_struct ? '@struct' : ''}·${rth ? 'RTH' : 'ON'}`
          : `${r.symbol} ${r.kind}${r.state ? ':' + r.state : ''}`;
        let s = byKind.get(k); if (!s) { s = { n: 0, sum30: 0, sum2: 0, sum5: 0 }; byKind.set(k, s); }
        s.n++; s.sum30 += outs[0] ?? 0; s.sum2 += outs[1] ?? 0; s.sum5 += outs[2] ?? 0;
      }
    });
    txn(rows);
    console.error(`  ${symbol} ${day}: ${rows.length} pending, tape ${tr.length} prints`);
  }

  console.log(`labeled ${labeled} events (${skippedDays} day-groups deferred — parquet not ready)`);
  console.log('mean signed ticks by kind (+ = moved as predicted):');
  for (const [k, s] of [...byKind.entries()].sort()) {
    console.log(`  ${k.padEnd(28)} n=${String(s.n).padStart(6)}  30s ${(s.sum30 / s.n).toFixed(2).padStart(7)}  2m ${(s.sum2 / s.n).toFixed(2).padStart(7)}  5m ${(s.sum5 / s.n).toFixed(2).padStart(7)}`);
  }
  process.exit(0);
}
main();
