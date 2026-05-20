/**
 * score_h_expl.ts
 *
 * Outcome scorer for Strategy H (FLIP/CONT) and EXPL signals.
 * Unlike the time-window scorer, this tracks when targets were first hit
 * and what the drawdown was up to each hit — matching how these signals
 * are actually traded (exit when target reached, hold through if going further).
 *
 * For each signal records:
 *   - max_mfe / max_mae across the full scan window
 *   - hit20/40/60/80/100: did the signal ever reach that target?
 *   - time_to_hitN: minutes from signal to first N-pt hit
 *   - mae_at_hitN: worst drawdown from entry to the moment N pts was first hit
 *
 * Scan window: up to MAX_SCAN_BARS 1-min bars (240 = 4 hours), or until RTH closes.
 *
 * Run: cd apps/aggregator && npx tsx scripts/score_h_expl.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../../data/trading.db');

const MAX_SCAN_BARS = 240;          // 4 hours max forward scan
const TARGETS = [20, 40, 60, 80, 100] as const;

const db = new Database(DB_PATH);

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS h_expl_outcomes (
    signal_id       INTEGER PRIMARY KEY,
    signal_ts       INTEGER NOT NULL,
    strategy_version TEXT NOT NULL,
    direction       TEXT NOT NULL,
    pattern         TEXT,
    score           INTEGER,
    signal_price    REAL,
    max_gain        REAL,
    max_dd          REAL,
    hit20  INTEGER DEFAULT 0,  hit40  INTEGER DEFAULT 0,
    hit60  INTEGER DEFAULT 0,  hit80  INTEGER DEFAULT 0,
    hit100 INTEGER DEFAULT 0,
    time_to_hit20  INTEGER,    time_to_hit40  INTEGER,
    time_to_hit60  INTEGER,    time_to_hit80  INTEGER,
    time_to_hit100 INTEGER,
    dd_at_20   REAL,       dd_at_40   REAL,
    dd_at_60   REAL,       dd_at_80   REAL,
    dd_at_100  REAL,
    bars_scanned    INTEGER,
    computed_at     INTEGER NOT NULL,
    passed          INTEGER
  )
`);

// ── Bar helpers ───────────────────────────────────────────────────────────────
interface Bar { ts: number; open: number; high: number; low: number; close: number; }

function getEntryBar(symbol: string, ts: number): Bar | null {
  const row = db.prepare(`
    SELECT ts,
      CAST(json_extract(payload,'$.open')  AS REAL) AS open,
      CAST(json_extract(payload,'$.high')  AS REAL) AS high,
      CAST(json_extract(payload,'$.low')   AS REAL) AS low,
      CAST(json_extract(payload,'$.close') AS REAL) AS close
    FROM events
    WHERE source='bookmap' AND type='bar' AND symbol=?
      AND ts <= ?
    ORDER BY ts DESC, id DESC
    LIMIT 1
  `).get(symbol, ts) as Bar | undefined;
  return row ?? null;
}

function getForwardBars(symbol: string, tsStart: number, nBars: number): Bar[] {
  const tsEnd = tsStart + nBars * 60_000;
  const rows = db.prepare(`
    SELECT ts,
      CAST(json_extract(payload,'$.open')  AS REAL) AS open,
      CAST(json_extract(payload,'$.high')  AS REAL) AS high,
      CAST(json_extract(payload,'$.low')   AS REAL) AS low,
      CAST(json_extract(payload,'$.close') AS REAL) AS close
    FROM events
    WHERE source='bookmap' AND type='bar' AND symbol=?
      AND ts BETWEEN ? AND ?
    ORDER BY ts ASC, id DESC
  `).all(symbol, tsStart, tsEnd) as Bar[];

  // dedup: keep last insert per bucket (most complete)
  const by = new Map<number, Bar>();
  for (const r of rows) by.set(r.ts, r);
  return Array.from(by.values()).sort((a, b) => a.ts - b.ts);
}

// ── Scoring ───────────────────────────────────────────────────────────────────
interface Outcome {
  signal_price: number;
  max_gain: number;
  max_dd: number;
  hit20: boolean; hit40: boolean; hit60: boolean; hit80: boolean; hit100: boolean;
  time_to_hit20: number | null; time_to_hit40: number | null;
  time_to_hit60: number | null; time_to_hit80: number | null; time_to_hit100: number | null;
  dd_at_20: number | null;  dd_at_40: number | null;
  dd_at_60: number | null;  dd_at_80: number | null; dd_at_100: number | null;
  bars_scanned: number;
}

function scoreSignal(
  symbol: string,
  ts: number,
  direction: 'long' | 'short',
): Outcome | null {
  const entryBar = getEntryBar(symbol, ts);
  if (!entryBar) return null;

  // Entry price: close of the bar at signal time
  const signalPrice = entryBar.close;
  const bars = getForwardBars(symbol, ts, MAX_SCAN_BARS);
  if (bars.length === 0) return null;

  let maxGain = 0;
  let maxDd = 0;
  let curDd = 0;  // running drawdown up to current bar

  // Track time and drawdown when each target was first crossed
  const hitAt: Record<number, { barIdx: number; ddAtHit: number }> = {};

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const gain = direction === 'long'
      ? Math.max(0, b.high - signalPrice)
      : Math.max(0, signalPrice - b.low);
    const dd = direction === 'long'
      ? Math.max(0, signalPrice - b.low)
      : Math.max(0, b.high - signalPrice);

    if (gain > maxGain) maxGain = gain;
    if (dd > maxDd)   maxDd = dd;
    if (dd > curDd)   curDd = dd;  // curDd only grows

    for (const tgt of TARGETS) {
      if (!hitAt[tgt] && gain >= tgt) {
        hitAt[tgt] = { barIdx: i, ddAtHit: curDd };
      }
    }
  }

  const minsSince = (barIdx: number) =>
    Math.round((bars[barIdx]!.ts - ts) / 60_000);

  return {
    signal_price: signalPrice,
    max_gain: Math.round(maxGain * 4) / 4,
    max_dd:   Math.round(maxDd   * 4) / 4,
    hit20:  !!hitAt[20],  hit40:  !!hitAt[40],
    hit60:  !!hitAt[60],  hit80:  !!hitAt[80],  hit100: !!hitAt[100],
    time_to_hit20:  hitAt[20]  ? minsSince(hitAt[20].barIdx)  : null,
    time_to_hit40:  hitAt[40]  ? minsSince(hitAt[40].barIdx)  : null,
    time_to_hit60:  hitAt[60]  ? minsSince(hitAt[60].barIdx)  : null,
    time_to_hit80:  hitAt[80]  ? minsSince(hitAt[80].barIdx)  : null,
    time_to_hit100: hitAt[100] ? minsSince(hitAt[100].barIdx) : null,
    dd_at_20:  hitAt[20]  ? Math.round(hitAt[20].ddAtHit  * 4) / 4 : null,
    dd_at_40:  hitAt[40]  ? Math.round(hitAt[40].ddAtHit  * 4) / 4 : null,
    dd_at_60:  hitAt[60]  ? Math.round(hitAt[60].ddAtHit  * 4) / 4 : null,
    dd_at_80:  hitAt[80]  ? Math.round(hitAt[80].ddAtHit  * 4) / 4 : null,
    dd_at_100: hitAt[100] ? Math.round(hitAt[100].ddAtHit * 4) / 4 : null,
    bars_scanned: bars.length,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
const upsert = db.prepare(`
  INSERT OR REPLACE INTO h_expl_outcomes (
    signal_id, signal_ts, strategy_version, direction, pattern, score, signal_price,
    max_gain, max_dd,
    hit20, hit40, hit60, hit80, hit100,
    time_to_hit20, time_to_hit40, time_to_hit60, time_to_hit80, time_to_hit100,
    dd_at_20, dd_at_40, dd_at_60, dd_at_80, dd_at_100,
    bars_scanned, computed_at,
    passed
  ) VALUES (
    ?,?,?,?,?,?,?,?,?,
    ?,?,?,?,?,
    ?,?,?,?,?,
    ?,?,?,?,?,
    ?,?,?
  )
`);

const signals = db.prepare(`
  SELECT id, ts, symbol, direction, strategy_version,
    score,
    json_extract(payload, '$.pattern') AS pattern
  FROM signals
  WHERE strategy_version IN ('H','EXPL')
  ORDER BY ts ASC
`).all() as { id: number; ts: number; symbol: string; direction: string; strategy_version: string; score: number; pattern: string | null }[];

console.log(`Scoring ${signals.length} H/EXPL signals...`);

let done = 0;
for (const sig of signals) {
  const out = scoreSignal(sig.symbol, sig.ts, sig.direction as 'long' | 'short');
  if (!out) { console.warn(`  No bars for signal ${sig.id} at ${new Date(sig.ts).toISOString()}`); continue; }

  const passed = (out.hit20 && out.dd_at_20 !== null && out.dd_at_20 < 42) ? 1 : 0;
  upsert.run(
    sig.id, sig.ts, sig.strategy_version, sig.direction, sig.pattern ?? null, sig.score, out.signal_price,
    out.max_gain, out.max_dd,
    out.hit20 ? 1 : 0, out.hit40 ? 1 : 0, out.hit60 ? 1 : 0, out.hit80 ? 1 : 0, out.hit100 ? 1 : 0,
    out.time_to_hit20, out.time_to_hit40, out.time_to_hit60, out.time_to_hit80, out.time_to_hit100,
    out.dd_at_20, out.dd_at_40, out.dd_at_60, out.dd_at_80, out.dd_at_100,
    out.bars_scanned, Date.now(),
    passed,
  );
  done++;
}

db.close();
console.log(`Done. Scored ${done}/${signals.length} signals.`);

// ── Summary report ────────────────────────────────────────────────────────────
{
  const db2 = new Database(DB_PATH);
  console.log('\n── H FLIP outcomes ──────────────────────────────────────────');
  const flipRows = db2.prepare(`
    SELECT
      datetime(signal_ts/1000,'unixepoch','-4 hours') AS et,
      direction, score, passed,
      ROUND(max_gain,1) AS max_gain, ROUND(max_dd,1) AS max_dd,
      hit20, hit40, hit60,
      time_to_hit20 AS t20, time_to_hit40 AS t40, time_to_hit60 AS t60,
      ROUND(dd_at_20,1) AS dd20
    FROM h_expl_outcomes
    WHERE strategy_version='H' AND pattern='FLIP'
    ORDER BY signal_ts
  `).all() as any[];
  console.log('et                    dir   sc  pass  max_gain max_dd  h20 h40 h60  t20  t40  t60  dd@20');
  for (const r of flipRows) {
    console.log(
      String(r.et).padEnd(22) +
      String(r.direction).padEnd(6) +
      String(r.score).padStart(3) + '  ' +
      (r.passed ? 'PASS' : 'fail') + '  ' +
      String(r.max_gain ?? '-').padStart(8) + ' ' +
      String(r.max_dd   ?? '-').padStart(6) + '  ' +
      (r.hit20 ? 'Y' : 'n') + '   ' +
      (r.hit40 ? 'Y' : 'n') + '   ' +
      (r.hit60 ? 'Y' : 'n') + '  ' +
      String(r.t20 ?? '-').padStart(4) + ' ' +
      String(r.t40 ?? '-').padStart(4) + ' ' +
      String(r.t60 ?? '-').padStart(4) + '  ' +
      String(r.dd20 ?? '-').padStart(5)
    );
  }

  console.log('\n── EXPL outcomes ────────────────────────────────────────────');
  const explRows = db2.prepare(`
    SELECT
      datetime(signal_ts/1000,'unixepoch','-4 hours') AS et,
      direction, score, passed,
      ROUND(max_gain,1) AS max_gain, ROUND(max_dd,1) AS max_dd,
      hit20, hit40, hit60, hit80, hit100,
      time_to_hit20 AS t20, time_to_hit60 AS t60,
      ROUND(dd_at_20,1) AS dd20
    FROM h_expl_outcomes
    WHERE strategy_version='EXPL'
    ORDER BY signal_ts
  `).all() as any[];
  console.log('et                    dir   sc  pass  max_gain max_dd  h20 h40 h60 h80 h100  t20  t60  dd@20');
  for (const r of explRows) {
    console.log(
      String(r.et).padEnd(22) +
      String(r.direction).padEnd(6) +
      String(r.score).padStart(3) + '  ' +
      (r.passed ? 'PASS' : 'fail') + '  ' +
      String(r.max_gain ?? '-').padStart(8) + ' ' +
      String(r.max_dd   ?? '-').padStart(6) + '  ' +
      (r.hit20 ? 'Y' : 'n') + '   ' +
      (r.hit40 ? 'Y' : 'n') + '   ' +
      (r.hit60 ? 'Y' : 'n') + '   ' +
      (r.hit80 ? 'Y' : 'n') + '    ' +
      (r.hit100 ? 'Y' : 'n') + '  ' +
      String(r.t20 ?? '-').padStart(4) + ' ' +
      String(r.t60 ?? '-').padStart(4) + '  ' +
      String(r.dd20 ?? '-').padStart(5)
    );
  }
  // ── EXPL LONG aggregate summary by zone count ─────────────────────────────
  console.log('\n── EXPL LONG summary by zone count ─────────────────────────');
  const n  = (v: number | null) => v ?? 0;
  const pct = (a: number, b: number) => b === 0 ? ' n/a' : `${Math.round(a/b*100)}%`.padStart(4);
  const avg = (arr: number[]) => arr.length === 0 ? '-' : (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1);

  const zoneRows = db2.prepare(`
    SELECT score AS zones, direction,
      COUNT(*) AS total,
      SUM(hit20) AS h20, SUM(hit40) AS h40, SUM(hit60) AS h60,
      SUM(hit80) AS h80, SUM(hit100) AS h100,
      GROUP_CONCAT(dd_at_20)  AS dds20,
      GROUP_CONCAT(dd_at_40)  AS dds40,
      GROUP_CONCAT(time_to_hit20) AS t20s,
      GROUP_CONCAT(time_to_hit40) AS t40s
    FROM h_expl_outcomes
    WHERE strategy_version='EXPL' AND direction='long'
    GROUP BY score
    ORDER BY score DESC
  `).all() as any[];

  console.log('Zones   n    h20   h40   h60   h80  h100   AvgDD@20  AvgDD@40  AvgT→20  AvgT→40');
  console.log('─────────────────────────────────────────────────────────────────────────────────');
  let totals = { n:0, h20:0, h40:0, h60:0, h80:0, h100:0, dds20:[] as number[], dds40:[] as number[], t20:[] as number[], t40:[] as number[] };
  for (const r of zoneRows) {
    const dds20 = r.dds20 ? r.dds20.split(',').filter(Boolean).map(Number) : [];
    const dds40 = r.dds40 ? r.dds40.split(',').filter(Boolean).map(Number) : [];
    const t20s  = r.t20s  ? r.t20s.split(',').filter(Boolean).map(Number)  : [];
    const t40s  = r.t40s  ? r.t40s.split(',').filter(Boolean).map(Number)  : [];
    totals.n    += r.total; totals.h20 += r.h20; totals.h40 += r.h40;
    totals.h60  += r.h60;  totals.h80 += r.h80; totals.h100+= r.h100;
    totals.dds20.push(...dds20); totals.dds40.push(...dds40);
    totals.t20.push(...t20s);    totals.t40.push(...t40s);
    console.log(
      `  ${String(r.zones).padEnd(6)} ${String(r.total).padStart(3)}` +
      `   ${pct(r.h20,r.total)}  ${pct(r.h40,r.total)}  ${pct(r.h60,r.total)}` +
      `  ${pct(r.h80,r.total)}  ${pct(r.h100,r.total)}` +
      `     ${avg(dds20).padStart(5)}     ${avg(dds40).padStart(5)}` +
      `     ${avg(t20s).padStart(5)}    ${avg(t40s).padStart(5)}`
    );
  }
  console.log('─────────────────────────────────────────────────────────────────────────────────');
  console.log(
    `  ALL    ${String(totals.n).padStart(3)}` +
    `   ${pct(totals.h20,totals.n)}  ${pct(totals.h40,totals.n)}  ${pct(totals.h60,totals.n)}` +
    `  ${pct(totals.h80,totals.n)}  ${pct(totals.h100,totals.n)}` +
    `     ${avg(totals.dds20).padStart(5)}     ${avg(totals.dds40).padStart(5)}` +
    `     ${avg(totals.t20).padStart(5)}    ${avg(totals.t40).padStart(5)}`
  );

  db2.close();
}
