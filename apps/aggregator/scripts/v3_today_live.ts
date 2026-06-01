/**
 * v3_today_live.ts — for each abso/FLIP/EXPL signal today, show whether
 * it would be V3-tradable (pass gate + pass V3 filters + not cooldown-skipped).
 * Run at any time during RTH to see "what's actionable now."
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { runCombinedCooldownBacktest, type RuleSpec, type SignalRow } from './lib/cooldown-backtest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

// Today's RTH open in UTC ms = 2026-05-29 13:30 UTC (09:30 EDT)
const TODAY = '2026-05-29';
const RTH_OPEN = Date.UTC(2026, 4, 29, 13, 30, 0, 0);

const rules: RuleSpec[] = [
  { ruleId: 'absorption',                     tp: 80, sl: 140,
    entryPriceFromRationale: /absorbed at (\d+\.?\d*)/ },
  { ruleId: 'clean-impulse', pattern: 'FLIP', tp: 80, sl: { long: 55, short: 105 } },
  { ruleId: 'expl',                           tp: 80, sl: 70, fallbackToTickPriceAtTs: true },
];

function rthOpenMsForSignal(tsMs: number): number {
  const d = new Date(tsMs - 4*60*60_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13, 30, 0, 0);
}
const stmtCvd = xdb.prepare(`
  SELECT SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) AS cvd
  FROM trades WHERE symbol='NQ' AND ts >= ? AND ts <= ?
`);
function cvdSessionAt(tsMs: number): number {
  const open = rthOpenMsForSignal(tsMs);
  const row = stmtCvd.get(open, tsMs) as {cvd: number | null};
  return row.cvd ?? 0;
}

const dropFlipShorts = (s: SignalRow) =>
  !(s.ruleId === 'clean-impulse' && s.pattern === 'FLIP' && s.direction === 'short');

const v3Filter = (s: SignalRow) => {
  if (!s.qualified || !dropFlipShorts(s)) return false;
  const cvd = cvdSessionAt(s.ts);
  if (s.direction === 'long'  && cvd <= -3000) return false;
  if (s.direction === 'short' && cvd >= +3000) return false;
  return true;
};

// Diagnostic listing of ALL signals today
const allToday = tdb.prepare(`
  SELECT s.id, s.ts, s.direction, s.rule_id AS ruleId,
         json_extract(s.payload,'$.pattern') AS pattern,
         s.score,
         CAST(json_extract(s.payload,'$.entry') AS REAL) AS entry,
         CASE WHEN q.signal_id IS NULL THEN 0 ELSE 1 END AS qualified
  FROM signals s LEFT JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.symbol='NQ' AND s.ts >= ?
    AND time(s.ts/1000,'unixepoch','-4 hours') >= '09:30:00'
    AND time(s.ts/1000,'unixepoch','-4 hours') <  '16:00:00'
    AND (s.rule_id='absorption'
      OR (s.rule_id='clean-impulse' AND json_extract(s.payload,'$.pattern')='FLIP')
      OR s.rule_id='expl')
  ORDER BY s.ts
`).all(RTH_OPEN) as any[];

function etTime(tsMs: number): string {
  const d = new Date(tsMs - 4*60*60_000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
}

console.log(`Today (${TODAY}) NQ signals so far — V3 eligibility report`);
console.log('=================================================================');
console.log(`Total signals fired today (abso/FLIP/EXPL): ${allToday.length}\n`);

if (allToday.length === 0) {
  console.log('No signals yet today.');
  process.exit(0);
}

console.log('time      rule           dir   score  entry      gate        V3 status');
console.log('--------  ------------   ----  -----  -------    ---------   ---------------------------');
for (const s of allToday) {
  const tag = `${s.ruleId}${s.pattern ? '/'+s.pattern : ''}`;
  const gate = s.qualified ? 'qualified' : 'silenced';
  let v3 = '✗ ';
  if (!s.qualified) {
    v3 += '(silenced by gate)';
  } else if (s.ruleId === 'clean-impulse' && s.pattern === 'FLIP' && s.direction === 'short') {
    v3 += '(V3 drops FLIP shorts)';
  } else {
    const cvd = cvdSessionAt(s.ts);
    if (s.direction === 'long' && cvd <= -3000) v3 = `✗ (CVD ${cvd} <= -3000, LONG blocked)`;
    else if (s.direction === 'short' && cvd >= 3000) v3 = `✗ (CVD ${cvd} >= +3000, SHORT blocked)`;
    else v3 = `✓ V3-PASS (cvdSession=${cvd})`;
  }
  console.log(
    `${etTime(s.ts)}  ${tag.padEnd(14)} ${s.direction.padEnd(5)} ${String(s.score).padStart(3)}    ${(s.entry ?? 0).toFixed(2).padStart(7)}    ${gate.padEnd(10)}  ${v3}`
  );
}

// Now run the cooldown simulation to see which V3-PASS signals would actually open trades
console.log('\n────── V3 trade simulation (with cooldown) ──────');
const results = runCombinedCooldownBacktest({
  symbol: 'NQ',
  tradingDb: tdb,
  ticksDb: xdb,
  rules,
  rthWindow: { startEt: '09:30:00', endEt: '16:00:00' },
  entryFilter: v3Filter,
  requireQualifiedExits: { long: true, short: false },
  tickFloor: RTH_OPEN,
});

const todayTrades = results.filter(r => r.outcome !== 'NO_DATA');
if (todayTrades.length === 0) {
  console.log('No V3 trades opened yet today.');
} else {
  let cum = 0;
  console.log('entryTime  rule           dir   entry      exitTime  outcome         pnl    cum');
  for (const r of todayTrades) {
    const tag = `${r.sig.ruleId}${r.sig.pattern ? '/'+r.sig.pattern : ''}`;
    cum += r.pnl;
    console.log(
      `${etTime(r.sig.ts).padEnd(9)}  ${tag.padEnd(14)} ${r.sig.direction.padEnd(5)} ` +
      `${(r.sig.entry ?? 0).toFixed(2).padStart(7)}    ${etTime(r.exitTs).padEnd(9)}  ` +
      `${r.outcome.padEnd(15)} ${String(r.pnl.toFixed(1)).padStart(7)}  ${String(cum.toFixed(1)).padStart(7)}`
    );
  }
  const net = todayTrades.reduce((a, r) => a + r.pnl, 0);
  const profitable = todayTrades.filter(r => r.pnl > 0).length;
  console.log(`\nNet so far: ${net.toFixed(0)}pt   Profitable: ${profitable}/${todayTrades.length}`);
}

tdb.close(); xdb.close();
