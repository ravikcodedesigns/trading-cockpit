// Per-signal report for today's RTH: did each fire qualify? would V3 take it?
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCombinedCooldownBacktest, type RuleSpec, type SignalRow } from './lib/cooldown-backtest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

const TODAY_RTH_OPEN = Date.UTC(2026, 5, 1, 13, 30, 0);

// Pull every V3-relevant raw signal today + qualified-status JOIN
const rows = tdb.prepare(`
  SELECT s.id, s.ts, s.symbol, s.rule_id AS ruleId, s.direction, s.score,
         json_extract(s.payload,'$.pattern') AS pattern,
         CAST(json_extract(s.payload,'$.entry') AS REAL) AS entry,
         CASE WHEN q.signal_id IS NULL THEN 0 ELSE 1 END AS qualified
  FROM signals s
  LEFT JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.symbol='NQ' AND s.ts >= ?
    AND ( s.rule_id='absorption'
       OR s.rule_id='expl'
       OR (s.rule_id='clean-impulse' AND json_extract(s.payload,'$.pattern')='FLIP'))
  ORDER BY s.ts
`).all(TODAY_RTH_OPEN) as any[];

// Run V3 backtest scoped to today to identify which signals V3 takes
const rules: RuleSpec[] = [
  { ruleId: 'absorption', tp: 80, sl: 140, entryPriceFromRationale: /absorbed at (\d+\.?\d*)/ },
  { ruleId: 'clean-impulse', pattern: 'FLIP', tp: 80, sl: { long: 55, short: 105 } },
  { ruleId: 'expl', tp: 80, sl: 70, fallbackToTickPriceAtTs: true },
];
const stmtCvd = xdb.prepare(`
  SELECT SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) AS cvd
  FROM trades WHERE symbol='NQ' AND ts >= ? AND ts <= ?
`);
function rthOpenMsForSignal(tsMs: number): number {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13, 30, 0, 0);
}
const cvdAt = (tsMs: number): number => {
  const row = stmtCvd.get(rthOpenMsForSignal(tsMs), tsMs) as { cvd: number | null } | undefined;
  return row?.cvd ?? 0;
};
const v3Filter = (s: SignalRow) => {
  if (!s.qualified) return false;
  if (s.ruleId === 'clean-impulse' && s.pattern === 'FLIP' && s.direction === 'short') return false;
  const cvd = cvdAt(s.ts);
  if (s.direction === 'long' && cvd <= -3000) return false;
  if (s.direction === 'short' && cvd >= +3000) return false;
  return true;
};

const v3Results = runCombinedCooldownBacktest({
  symbol: 'NQ', tradingDb: tdb, ticksDb: xdb, rules,
  rthWindow: { startEt: '09:30:00', endEt: '16:00:00' },
  entryFilter: v3Filter,
  requireQualifiedExits: { long: true, short: false },
  tickFloor: TODAY_RTH_OPEN,
});
const v3TakenIds = new Set(v3Results.map(r => r.sig.id));

function etTime(tsMs: number): string {
  const d = new Date(tsMs - 4*60*60_000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
}

console.log(`\n══ Today's RTH NQ signal report (2026-06-01 09:30 ET → now) ══\n`);
console.log('Total V3-universe raw signals (abso / FLIP / EXPL):', rows.length);

const qCount = rows.filter(r => r.qualified === 1).length;
const v3Count = v3Results.length;
console.log(`Qualified (gold-tier broadcast): ${qCount}`);
console.log(`V3 evaluable (would have traded): ${v3Count}`);
console.log('');

console.log('time      rule                 dir   score  entry      gate       V3?    V3 outcome');
console.log('--------  -------------------  ----  -----  --------   --------   -----  -----------');
for (const r of rows) {
  const tag = `${r.ruleId}${r.pattern ? '/'+r.pattern : ''}`;
  const gate = r.qualified === 1 ? 'qualified' : 'silenced';
  const v3 = v3TakenIds.has(r.id) ? 'YES' : 'no ';
  const v3R = v3Results.find(x => x.sig.id === r.id);
  const v3Out = v3R ? `${v3R.outcome} pnl=${v3R.pnl.toFixed(0)}` : '';
  console.log(
    `${etTime(r.ts)}  ${tag.padEnd(20)} ${r.direction.padEnd(5)} ${String(r.score).padStart(3)}    ` +
    `${(r.entry ?? 0).toFixed(2).padStart(8)}   ${gate.padEnd(10)} ${v3.padEnd(5)}  ${v3Out}`
  );
}

console.log('\n── V3 outcome summary ──');
const w = v3Results.filter(r => r.outcome === 'WIN').length;
const l = v3Results.filter(r => r.outcome === 'LOSS').length;
const ea = v3Results.filter(r => r.outcome === 'EXIT_OPP_ENTRY').length;
const es = v3Results.filter(r => r.outcome === 'EXIT_OPP_STRUCT').length;
const c = v3Results.filter(r => r.outcome === 'CLOSE').length;
const o = v3Results.filter(r => r.outcome === 'NO_DATA').length;
const net = v3Results.reduce((a, r) => a + r.pnl, 0);
console.log(`  WIN: ${w}    LOSS: ${l}    EXIT_OPP_ENTRY: ${ea}    EXIT_OPP_STRUCT: ${es}    CLOSE: ${c}    NO_DATA: ${o}`);
console.log(`  Net PnL today: ${net.toFixed(0)} pt`);

tdb.close(); xdb.close();
