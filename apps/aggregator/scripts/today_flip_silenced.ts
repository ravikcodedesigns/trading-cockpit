/**
 * today_flip_silenced.ts — for each FLIP long today, show the payload's
 * delta5 / delta15 values and which gate condition silenced it.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');

const tdb = new Database(TRADING_DB, { readonly: true });

const TODAY_RTH_OPEN  = Date.UTC(2026, 4, 28, 13, 30, 0, 0);
const TODAY_RTH_CLOSE = Date.UTC(2026, 4, 28, 20, 0, 0, 0);

const flips = tdb.prepare(`
  SELECT s.id, s.ts, s.direction, s.score,
         json_extract(s.payload,'$.pattern')        AS pattern,
         CAST(json_extract(s.payload,'$.entry')      AS REAL) AS entry,
         CAST(json_extract(s.payload,'$.delta5')     AS REAL) AS delta5,
         CAST(json_extract(s.payload,'$.delta15')    AS REAL) AS delta15,
         CAST(json_extract(s.payload,'$.deltaT')     AS REAL) AS deltaT,
         CAST(json_extract(s.payload,'$.delta_last3') AS REAL) AS deltaLast3,
         json_extract(s.payload,'$.compPos')        AS compPos,
         CASE WHEN q.signal_id IS NULL THEN 'silenced' ELSE 'qualified' END AS gate
  FROM signals s
  LEFT JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.symbol='NQ' AND s.ts >= ? AND s.ts <= ?
    AND s.rule_id='clean-impulse'
    AND json_extract(s.payload,'$.pattern')='FLIP'
  ORDER BY s.ts
`).all(TODAY_RTH_OPEN, TODAY_RTH_CLOSE) as any[];

function etTime(tsMs: number): string {
  const d = new Date(tsMs - 4*60*60_000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
}

// Gate rules (per quality.ts:232-269 for Strategy H FLIP):
// 1. EXPL conflict check (we'll show this from data if any)
// 2. delta15 < 500 (LONG only) — buyer-dominant background blocks
// 3. delta5 ≤ -1000 (or -800 with same-dir EXPL) — sellers must have been pushing DOWN

// Look up recent EXPLs for context (60-min lookback per quality.ts)
const EXPL_LOOKBACK_MS = 60 * 60_000;
const stmtExpls = tdb.prepare(`
  SELECT ts, direction FROM signals
  WHERE rule_id='expl' AND symbol='NQ' AND ts >= ? AND ts < ?
  ORDER BY ts ASC
`);

console.log('FLIP signals today (2026-05-28 RTH NQ):\n');
console.log(' time      dir   score  entry      delta5    delta15    deltaT  d_last3  compPos  gate       silencing reason');
console.log(' --------  ----  -----  -------    ------    -------    ------  -------  -------  --------   ------------------------');
for (const s of flips) {
  const expls = stmtExpls.all(s.ts - EXPL_LOOKBACK_MS, s.ts) as { ts: number; direction: string }[];
  const sameDirExpl = expls.find(e => e.direction === s.direction);
  const oppExpl = [...expls].reverse().find(e => e.direction !== s.direction);
  const hasSameDir = !!sameDirExpl;
  const lastOppExpl = oppExpl ?? null;

  let reason = 'PASS';
  // 1. EXPL conflict
  if (lastOppExpl && (!sameDirExpl || lastOppExpl.ts > sameDirExpl.ts)) {
    const dT = Math.abs(s.deltaT ?? 0);
    const d5a = Math.abs(s.delta5 ?? 0);
    const dl  = Math.abs(s.deltaLast3 ?? 0);
    const denom = Math.max(d5a, dl);
    const ratio = denom === 0 ? 999 : dT / denom;
    if (ratio > 0.25) {
      const ago = Math.round((s.ts - lastOppExpl.ts) / 60_000);
      reason = `EXPL conflict: opp ${lastOppExpl.direction} ${ago}m ago (ratio=${ratio.toFixed(2)})`;
    }
  }
  // 2. delta15 < 500 (LONG only)
  if (reason === 'PASS' && s.direction === 'long' && s.delta15 !== null && s.delta15 >= 500) {
    reason = `delta15=+${s.delta15.toFixed(0)} (>=500) — buyers-dominant 15-bar background blocks LONG`;
  }
  // 3. delta5 threshold check
  if (reason === 'PASS') {
    const d5Threshold = hasSameDir ? 800 : 1000;
    const d5 = s.delta5 ?? 0;
    const d5Pass = s.direction === 'short' ? d5 >= d5Threshold : d5 <= -d5Threshold;
    if (!d5Pass) {
      reason = `delta5=${d5.toFixed(0)} (LONG needs <= -${d5Threshold}${hasSameDir ? ' EXPL-zone' : ''})`;
    }
  }
  console.log(
    ` ${etTime(s.ts)}  ${s.direction.padEnd(4)}  ${String(s.score).padStart(3)}    ${(s.entry ?? 0).toFixed(2).padStart(7)}  ` +
    `${String(s.delta5?.toFixed(0) ?? '-').padStart(7)}  ${String(s.delta15?.toFixed(0) ?? '-').padStart(8)}  ` +
    `${String(s.deltaT?.toFixed(0) ?? '-').padStart(6)}  ${String(s.deltaLast3?.toFixed(0) ?? '-').padStart(7)}  ` +
    `${String(s.compPos ?? '-').padStart(6)}   ${s.gate.padEnd(9)}  ${reason}`
  );
}

tdb.close();
