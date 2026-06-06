/**
 * v3_daily_pnl.ts — V3 (asymmetric exits + CVD regime gate) broken down
 * day-by-day. Shows the experience of running V3 live across the 24 RTH days.
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

const CVD_LONG_FLOOR  = -3000;
const CVD_SHORT_FLOOR = +3000;

const rules: RuleSpec[] = [
  // ABSO removed from V3 backtest 2026-06-02 — no clear edge in historical WR,
  // muted from V3 (entry + opp-exit) and Discord. Detection + qualified_signals
  // logging continue for future research. Use scripts/abso_*.ts for ABSO-only
  // analysis; this script's V3 aggregate intentionally excludes it.
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
  entryFilter: v3Filter,
  requireQualifiedExits: { long: true, short: false },
});

// Bucket by ET date
function etDate(tsMs: number): string {
  const d = new Date(tsMs - 4*60*60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function etTime(tsMs: number): string {
  const d = new Date(tsMs - 4*60*60_000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

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

// Also collect all RTH-NQ trading days that appear in the signal universe
// (zero-trade days are part of the experience)
const tickFloorMs = (xdb.prepare(`SELECT MIN(ts) AS t FROM trades WHERE symbol='NQ'`).get() as {t:number}).t;
const allDays = tdb.prepare(`
  SELECT DISTINCT date(ts/1000,'unixepoch','-4 hours') AS d
  FROM signals
  WHERE symbol='NQ' AND ts >= ?
    AND time(ts/1000,'unixepoch','-4 hours') >= '09:30:00'
    AND time(ts/1000,'unixepoch','-4 hours') <  '16:00:00'
  ORDER BY d
`).all(tickFloorMs) as { d: string }[];
const tickFloorDate = etDate(tickFloorMs);

console.log(`Day-by-day P&L for V3 (asymmetric exits + CVD regime gate)`);
console.log(`TP=80 · SL: abso 140 · FLIP L:55/S:105 · EXPL 70`);
console.log(`Tick coverage starts: ${tickFloorDate}\n`);

console.log('date          n   W  L  Prof  Net      Cum         path');
console.log('----------    -- --- --- ----  -------  ----------  ---------------------------');
let cum = 0;
let bestDay: DayStat | null = null;
let worstDay: DayStat | null = null;
const dailyNets: number[] = [];
let zeroTradeDays = 0;

for (const { d } of allDays) {
  if (d < tickFloorDate) continue;
  const ds = days.get(d);
  if (!ds) {
    zeroTradeDays++;
    console.log(`${d}     -    -  -    -  ${'(no qualified entries)'.padEnd(8)}  ${cum.toFixed(0).padStart(7)}pt`);
    continue;
  }
  cum += ds.net;
  dailyNets.push(ds.net);
  if (!bestDay  || ds.net > bestDay.net)  bestDay  = ds;
  if (!worstDay || ds.net < worstDay.net) worstDay = ds;
  // Trade path: e.g. +80 −55 +80 = win/loss/win
  const path = ds.trades.map(r => {
    const sign = r.pnl >= 0 ? '+' : '';
    return `${sign}${r.pnl.toFixed(0)}`;
  }).join(' ');
  console.log(`${d}    ${String(ds.trades.length).padStart(2)}  ${String(ds.wins).padStart(2)}  ${String(ds.losses).padStart(2)}  ${String(ds.profitable).padStart(2)}  ${ds.net.toFixed(0).padStart(7)}  ${cum.toFixed(0).padStart(7)}pt  ${path}`);
}

console.log(`\n────── Aggregate (${dailyNets.length} active days, ${zeroTradeDays} zero-trade days) ──────`);
const tradingDays = dailyNets.length;
const totalNet = dailyNets.reduce((a,b)=>a+b, 0);
const avgDailyNet = tradingDays ? totalNet / tradingDays : 0;
const totalTrades = results.filter(r => r.outcome !== 'NO_DATA').length;
const winningDays = dailyNets.filter(n => n > 0).length;
const losingDays  = dailyNets.filter(n => n < 0).length;
const flatDays    = dailyNets.filter(n => n === 0).length;
const stdev = (() => {
  if (tradingDays < 2) return 0;
  const mean = avgDailyNet;
  const variance = dailyNets.reduce((a, b) => a + (b - mean) ** 2, 0) / (tradingDays - 1);
  return Math.sqrt(variance);
})();

console.log(`Total net:          ${totalNet.toFixed(0)}pt over ${tradingDays} active days`);
console.log(`Avg active day:     ${avgDailyNet.toFixed(1)}pt`);
console.log(`Avg incl zero days: ${(totalNet / (tradingDays + zeroTradeDays)).toFixed(1)}pt per calendar day`);
console.log(`Daily stdev:        ${stdev.toFixed(1)}pt`);
console.log(`Sharpe-like:        ${avgDailyNet / (stdev || 1)} (daily mean / daily stdev)`);
console.log(`Winning days:       ${winningDays} / ${tradingDays} = ${(winningDays/tradingDays*100).toFixed(0)}%`);
console.log(`Losing days:        ${losingDays} / ${tradingDays}`);
console.log(`Flat days:          ${flatDays} / ${tradingDays}`);
console.log(`Zero-entry days:    ${zeroTradeDays}`);
console.log(`Best day:           ${bestDay!.date} = ${bestDay!.net.toFixed(0)}pt  (${bestDay!.trades.length} trades)`);
console.log(`Worst day:          ${worstDay!.date} = ${worstDay!.net.toFixed(0)}pt  (${worstDay!.trades.length} trades)`);

// Max drawdown from peak
let peak = 0, dd = 0, maxDD = 0;
let runningCum = 0;
for (const n of dailyNets) {
  runningCum += n;
  if (runningCum > peak) peak = runningCum;
  dd = peak - runningCum;
  if (dd > maxDD) maxDD = dd;
}
console.log(`Max drawdown:       ${maxDD.toFixed(0)}pt from peak`);
console.log(`Final equity:       ${totalNet.toFixed(0)}pt`);

// What % of total comes from the best 3 days?
const sortedDays = [...dailyNets].sort((a, b) => b - a);
const top3 = sortedDays.slice(0, 3).reduce((a,b)=>a+b, 0);
const top5 = sortedDays.slice(0, 5).reduce((a,b)=>a+b, 0);
console.log(`\nConcentration check:`);
console.log(`  Top 3 days contribute: ${top3.toFixed(0)}pt = ${(top3/totalNet*100).toFixed(0)}% of total`);
console.log(`  Top 5 days contribute: ${top5.toFixed(0)}pt = ${(top5/totalNet*100).toFixed(0)}% of total`);

tdb.close(); xdb.close();
