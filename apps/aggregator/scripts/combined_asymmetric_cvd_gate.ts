/**
 * combined_asymmetric_cvd_gate.ts — Variant 2 (asymmetric qualified exits)
 * PLUS a CVD regime gate at entry:
 *   - LONG entries blocked if cvdSession <= -3000
 *   - SHORT entries blocked if cvdSession >= +3000
 *
 * cvdSession is anchored at 09:30 ET on the signal's same trading day
 * and summed up to the signal's ts (is_bid_aggressor=1 is BUY, empirical).
 *
 * Reports baseline (V2), V3 (V2 + CVD), and diagnostic of blocked entries.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { runCombinedCooldownBacktest, summarize, type RuleSpec, type SignalRow } from './lib/cooldown-backtest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

const CVD_LONG_FLOOR  = -3000;   // longs blocked when cvdSession <= this
const CVD_SHORT_FLOOR = +3000;   // shorts blocked when cvdSession >= this

const rules: RuleSpec[] = [
  { ruleId: 'absorption',                     tp: 80, sl: 140,
    entryPriceFromRationale: /absorbed at (\d+\.?\d*)/ },
  { ruleId: 'clean-impulse', pattern: 'FLIP', tp: 80, sl: { long: 55, short: 105 } },
  { ruleId: 'expl',                           tp: 80, sl: 70, fallbackToTickPriceAtTs: true },
];

const baseCfg = {
  symbol: 'NQ' as const,
  tradingDb: tdb,
  ticksDb: xdb,
  rules,
  rthWindow: { startEt: '09:30:00', endEt: '16:00:00' },
};

// CVD session lookup
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

const blockedDiagnostic: Array<{ ts: number; rule: string; direction: string; cvd: number }> = [];

const dropFlipShorts = (s: SignalRow) =>
  !(s.ruleId === 'clean-impulse' && s.pattern === 'FLIP' && s.direction === 'short');

const v2Filter = (s: SignalRow) => s.qualified && dropFlipShorts(s);

const v3Filter = (s: SignalRow) => {
  if (!v2Filter(s)) return false;
  const cvd = cvdSessionAt(s.ts);
  if (s.direction === 'long' && cvd <= CVD_LONG_FLOOR) {
    blockedDiagnostic.push({ ts: s.ts, rule: s.ruleId + (s.pattern ? '/' + s.pattern : ''), direction: 'long', cvd });
    return false;
  }
  if (s.direction === 'short' && cvd >= CVD_SHORT_FLOOR) {
    blockedDiagnostic.push({ ts: s.ts, rule: s.ruleId + (s.pattern ? '/' + s.pattern : ''), direction: 'short', cvd });
    return false;
  }
  return true;
};

console.log(`CVD floors: LONG blocked when cvdSession <= ${CVD_LONG_FLOOR}, SHORT blocked when cvdSession >= ${CVD_SHORT_FLOOR}\n`);

console.log('────── VARIANT 2 — asymmetric exits, no CVD gate ──────');
const v2 = runCombinedCooldownBacktest({
  ...baseCfg,
  entryFilter: v2Filter,
  requireQualifiedExits: { long: true, short: false },
});
summarize('V2: asymmetric exits', v2, { tp: 80, sl: 'per-rule' as any });

console.log('\n────── VARIANT 3 — asymmetric exits + CVD regime gate ──────');
const v3 = runCombinedCooldownBacktest({
  ...baseCfg,
  entryFilter: v3Filter,
  requireQualifiedExits: { long: true, short: false },
});
summarize('V3: V2 + CVD gate', v3, { tp: 80, sl: 'per-rule' as any });

if (blockedDiagnostic.length) {
  function etISO(tsMs: number): string {
    const d = new Date(tsMs - 4*60*60_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
  }
  console.log(`\n────── CVD-blocked signals (${blockedDiagnostic.length}) ──────`);
  for (const b of blockedDiagnostic) {
    console.log(`  ${etISO(b.ts)}  ${b.rule.padEnd(20)} ${b.direction.padEnd(5)}  cvdSession=${b.cvd}`);
  }
}

tdb.close(); xdb.close();
