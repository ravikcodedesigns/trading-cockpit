/**
 * v3_daily_pnl_no_outliers.ts — same V3 simulation as v3_daily_pnl.ts,
 * but excludes 2026-05-08 and 2026-05-12 (the two outlier days that carried
 * 60% of total net) to see if the strategy is robust without them.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { runCombinedCooldownBacktest, type RuleSpec, type SignalRow, type TradeRecord } from './lib/cooldown-backtest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

const EXCLUDED_DAYS = new Set(['2026-05-08', '2026-05-12']);
const CVD_LONG_FLOOR  = -3000;
const CVD_SHORT_FLOOR = +3000;

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
function etDate(tsMs: number): string {
  const d = new Date(tsMs - 4*60*60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
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

const v3FilterNoOutliers = (s: SignalRow) => {
  if (EXCLUDED_DAYS.has(etDate(s.ts))) return false;
  if (!s.qualified || !dropFlipShorts(s)) return false;
  const cvd = cvdSessionAt(s.ts);
  if (s.direction === 'long'  && cvd <= CVD_LONG_FLOOR)  return false;
  if (s.direction === 'short' && cvd >= CVD_SHORT_FLOOR) return false;
  return true;
};

const results = runCombinedCooldownBacktest({
  symbol: 'NQ',
  tradingDb: tdb,
  ticksDb: xdb,
  rules,
  rthWindow: { startEt: '09:30:00', endEt: '16:00:00' },
  entryFilter: v3FilterNoOutliers,
  requireQualifiedExits: { long: true, short: false },
});

interface DayStat {
  date: string;
  trades: TradeRecord[];
  net: number;
  wins: number; losses: number; profitable: number;
}
const days = new Map<string, DayStat>();
for (const r of results) {
  if (r.outcome === 'NO_DATA') continue;
  const d = etDate(r.sig.ts);
  if (!days.has(d)) days.set(d, { date: d, trades: [], net: 0, wins: 0, losses: 0, profitable: 0 });
  const ds = days.get(d)!;
  ds.trades.push(r);
  ds.net += r.pnl;
  if (r.outcome === 'WIN')  ds.wins++;
  if (r.outcome === 'LOSS') ds.losses++;
  if (r.pnl > 0) ds.profitable++;
}

const tickFloorMs = (xdb.prepare(`SELECT MIN(ts) AS t FROM trades WHERE symbol='NQ'`).get() as {t:number}).t;
const tickFloorDate = etDate(tickFloorMs);
const allDays = tdb.prepare(`
  SELECT DISTINCT date(ts/1000,'unixepoch','-4 hours') AS d
  FROM signals
  WHERE symbol='NQ' AND ts >= ?
    AND time(ts/1000,'unixepoch','-4 hours') >= '09:30:00'
    AND time(ts/1000,'unixepoch','-4 hours') <  '16:00:00'
  ORDER BY d
`).all(tickFloorMs) as { d: string }[];

console.log(`V3 day-by-day P&L — EXCLUDING ${[...EXCLUDED_DAYS].join(', ')}`);
console.log(`TP=80 · SL: abso 140 · FLIP L:55/S:105 · EXPL 70\n`);

console.log('date          n   W  L  Prof  Net      Cum       Path');
console.log('----------    -- --- --- ----  -------  ------    ---------------------------');
let cum = 0;
let bestDay: DayStat | null = null;
let worstDay: DayStat | null = null;
const dailyNets: number[] = [];
let zeroTradeDays = 0;
let excludedDaysSeen = 0;

for (const { d } of allDays) {
  if (d < tickFloorDate) continue;
  if (EXCLUDED_DAYS.has(d)) {
    excludedDaysSeen++;
    console.log(`${d}     -    -  -    -  (EXCLUDED)             ${cum.toFixed(0).padStart(6)}pt`);
    continue;
  }
  const ds = days.get(d);
  if (!ds) {
    zeroTradeDays++;
    console.log(`${d}     -    -  -    -  (no qualified entries) ${cum.toFixed(0).padStart(6)}pt`);
    continue;
  }
  cum += ds.net;
  dailyNets.push(ds.net);
  if (!bestDay  || ds.net > bestDay.net)  bestDay  = ds;
  if (!worstDay || ds.net < worstDay.net) worstDay = ds;
  const path = ds.trades.map(r => (r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(0)).join(' ');
  console.log(`${d}    ${String(ds.trades.length).padStart(2)}  ${String(ds.wins).padStart(2)}  ${String(ds.losses).padStart(2)}  ${String(ds.profitable).padStart(2)}  ${ds.net.toFixed(0).padStart(7)}  ${cum.toFixed(0).padStart(6)}pt  ${path}`);
}

console.log(`\n────── Aggregate (no outliers: ${dailyNets.length} active days, ${zeroTradeDays} zero-trade days, ${excludedDaysSeen} excluded days) ──────`);
const tradingDays = dailyNets.length;
const totalNet = dailyNets.reduce((a,b)=>a+b, 0);
const avgDailyNet = tradingDays ? totalNet / tradingDays : 0;
const winningDays = dailyNets.filter(n => n > 0).length;
const losingDays  = dailyNets.filter(n => n < 0).length;
const stdev = (() => {
  if (tradingDays < 2) return 0;
  const mean = avgDailyNet;
  const variance = dailyNets.reduce((a, b) => a + (b - mean) ** 2, 0) / (tradingDays - 1);
  return Math.sqrt(variance);
})();
let peak = 0, dd = 0, maxDD = 0, runningCum = 0;
for (const n of dailyNets) {
  runningCum += n;
  if (runningCum > peak) peak = runningCum;
  dd = peak - runningCum;
  if (dd > maxDD) maxDD = dd;
}

console.log(`Total net (ex outliers): ${totalNet.toFixed(0)}pt over ${tradingDays} active days`);
console.log(`Avg active day:          ${avgDailyNet.toFixed(1)}pt`);
console.log(`Daily stdev:             ${stdev.toFixed(1)}pt`);
console.log(`Sharpe-like:             ${(avgDailyNet / (stdev || 1)).toFixed(2)}`);
console.log(`Winning days:            ${winningDays}/${tradingDays} = ${(winningDays/tradingDays*100).toFixed(0)}%`);
console.log(`Losing days:             ${losingDays}/${tradingDays}`);
console.log(`Max drawdown:            ${maxDD.toFixed(0)}pt`);
console.log(`Best day (ex outliers):  ${bestDay!.date} = ${bestDay!.net.toFixed(0)}pt`);
console.log(`Worst day:               ${worstDay!.date} = ${worstDay!.net.toFixed(0)}pt`);

// Concentration on the reduced set
const sortedDays = [...dailyNets].sort((a, b) => b - a);
const top3 = sortedDays.slice(0, 3).reduce((a,b)=>a+b, 0);
const top5 = sortedDays.slice(0, 5).reduce((a,b)=>a+b, 0);
console.log(`\nConcentration (reduced set):`);
console.log(`  Top 3 days: ${top3.toFixed(0)}pt = ${(top3/totalNet*100).toFixed(0)}% of remaining total`);
console.log(`  Top 5 days: ${top5.toFixed(0)}pt = ${(top5/totalNet*100).toFixed(0)}% of remaining total`);

tdb.close(); xdb.close();
