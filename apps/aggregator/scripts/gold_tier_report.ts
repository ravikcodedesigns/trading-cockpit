/**
 * gold_tier_report.ts
 *
 * Analyzes gold-tier RTH signals (score >= 80) from strategies A/B/D/E.
 * Focus: time to reach T1/T2/T3 (20/40/60pts) and max DD before each hit.
 * Uses raw tick data for precision — not window-bucket approximations.
 *
 * Run: cd apps/aggregator && npx tsx scripts/gold_tier_report.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const GOLD_SCORE = 80;
const T1 = 20, T2 = 40, T3 = 60;
const WINDOW_MS = 60 * 60_000;   // 1 hour max follow-through window

// ── helpers ───────────────────────────────────────────────────────────────────

function toET(ms: number) {
  return new Date(ms).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function isRTH(ms: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  const wd  = parts.find(p => p.type === 'weekday')?.value ?? '';
  const h   = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const min = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  const tot = h * 60 + min;
  return ['Mon','Tue','Wed','Thu','Fri'].includes(wd) && tot >= 570 && tot < 960;
}

function avg(arr: number[]): string {
  if (!arr.length) return '  -';
  return (arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1);
}
function med(arr: number[]): string {
  if (!arr.length) return '  -';
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return (s.length % 2 === 0 ? ((s[m-1]! + s[m]!) / 2) : s[m]!).toFixed(1);
}
function pct(n: number, d: number): string {
  return d === 0 ? '  -' : `${Math.round(100 * n / d)}%`;
}

// ── per-signal outcome ────────────────────────────────────────────────────────

interface SignalResult {
  rule:        string;
  strategy:    string;
  score:       number;
  direction:   'long' | 'short';
  entryPrice:  number;
  entryTs:     number;
  noData:      boolean;         // true = no ticks found for this window (excluded from stats)
  // null = did not reach within 1 hour
  t1MinsSec:   number | null;   // minutes to hit T1
  t2MinsSec:   number | null;
  t3MinsSec:   number | null;
  ddAtT1:      number | null;   // max adverse pts before hitting T1
  ddAtT2:      number | null;
  ddAtT3:      number | null;
  maxGain:     number;          // peak gain at any point in window
  maxDD:       number;          // worst drawdown in window
  finalPnl:    number;          // PnL at 1 hour
}

function analyzeSignal(
  ticksDb: Database.Database,
  entryTs: number,
  entryPrice: number,
  direction: 'long' | 'short',
): Omit<SignalResult, 'rule' | 'strategy' | 'score' | 'direction' | 'entryPrice' | 'entryTs'> {
  const trades = ticksDb.prepare(`
    SELECT ts, price FROM trades
    WHERE symbol = 'NQ' AND ts > ? AND ts <= ?
    ORDER BY ts ASC
  `).all(entryTs, entryTs + WINDOW_MS) as { ts: number; price: number }[];

  if (trades.length === 0) {
    return {
      noData: true,
      t1MinsSec: null, t2MinsSec: null, t3MinsSec: null,
      ddAtT1: null, ddAtT2: null, ddAtT3: null,
      maxGain: 0, maxDD: 0, finalPnl: 0,
    };
  }

  let maxGain = 0;
  let maxDD   = 0;
  let t1Ts: number | null = null;
  let t2Ts: number | null = null;
  let t3Ts: number | null = null;
  let ddAtT1: number | null = null;
  let ddAtT2: number | null = null;
  let ddAtT3: number | null = null;
  let runningMaxDD = 0;

  for (const t of trades) {
    const pnl = direction === 'long'
      ? t.price - entryPrice
      : entryPrice - t.price;

    if (pnl > maxGain) maxGain = pnl;
    const dd = -Math.min(0, pnl);   // adverse excursion (positive number)
    if (dd > runningMaxDD) runningMaxDD = dd;
    if (dd > maxDD) maxDD = dd;

    if (t1Ts === null && pnl >= T1) {
      t1Ts   = t.ts;
      ddAtT1 = runningMaxDD;
    }
    if (t2Ts === null && pnl >= T2) {
      t2Ts   = t.ts;
      ddAtT2 = runningMaxDD;
    }
    if (t3Ts === null && pnl >= T3) {
      t3Ts   = t.ts;
      ddAtT3 = runningMaxDD;
    }
  }

  const toMins = (ts: number | null) =>
    ts === null ? null : (ts - entryTs) / 60_000;

  const finalTrade = trades[trades.length - 1];
  const finalPnl = finalTrade
    ? (direction === 'long' ? finalTrade.price - entryPrice : entryPrice - finalTrade.price)
    : 0;

  return {
    noData: false,
    t1MinsSec: toMins(t1Ts),
    t2MinsSec: toMins(t2Ts),
    t3MinsSec: toMins(t3Ts),
    ddAtT1, ddAtT2, ddAtT3,
    maxGain, maxDD, finalPnl,
  };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const trDb   = new Database(TRADING_DB, { readonly: true });
  const ticksDb = new Database(TICKS_DB,  { readonly: true });

  const signals = trDb.prepare(`
    SELECT s.id, s.ts, s.rule_id, s.score, s.direction, s.strategy_version,
      COALESCE(json_extract(s.payload,'$.entry'), m.signal_price) as entry_price
    FROM signals s
    LEFT JOIN signal_outcomes_matured m ON m.signal_id = s.id
    WHERE s.strategy_version IN ('A','B','D','E')
      AND s.score >= ?
    ORDER BY s.ts ASC
  `).all(GOLD_SCORE) as {
    id: number; ts: number; rule_id: string; score: number;
    direction: 'long' | 'short'; strategy_version: string; entry_price: number;
  }[];

  // Only RTH signals with a valid entry price
  const rthSignals = signals.filter(s =>
    s.entry_price != null && isRTH(s.ts)
  );

  console.log(`\n${'='.repeat(68)}`);
  console.log('  GOLD TIER REPORT  (score >= 80, RTH only, A/B/D/E)');
  console.log(`${'='.repeat(68)}`);
  console.log(`Total signals qualifying: ${rthSignals.length}\n`);

  // Group results by strategy+rule
  const byRule = new Map<string, SignalResult[]>();

  for (const sig of rthSignals) {
    // entry is at signal bar close (ts is bar open for most strategies)
    const entryTs = sig.ts;
    const outcome = analyzeSignal(ticksDb, entryTs, sig.entry_price, sig.direction);
    const result: SignalResult = {
      rule: sig.rule_id, strategy: sig.strategy_version,
      score: sig.score, direction: sig.direction,
      entryPrice: sig.entry_price, entryTs: sig.ts,
      ...outcome,
    };
    const key = `${sig.strategy_version}/${sig.rule_id}`;
    const arr = byRule.get(key) ?? [];
    arr.push(result);
    byRule.set(key, arr);
  }

  // ── per-rule summary ───────────────────────────────────────────────────────
  for (const [key, allInRule] of [...byRule.entries()].sort()) {
    const noDataCount = allInRule.filter(r => r.noData).length;
    const results = allInRule.filter(r => !r.noData);
    const n = results.length;
    if (n === 0) {
      console.log(`\n${'─'.repeat(68)}`);
      console.log(`  ${key.toUpperCase()}  — no tick data (${noDataCount} signals skipped)`);
      continue;
    }
    const hitT1 = results.filter(r => r.t1MinsSec !== null);
    const hitT2 = results.filter(r => r.t2MinsSec !== null);
    const hitT3 = results.filter(r => r.t3MinsSec !== null);

    console.log(`\n${'─'.repeat(68)}`);
    const skipNote = noDataCount > 0 ? `  [${noDataCount} skipped — no tick data]` : '';
    console.log(`  ${key.toUpperCase()}  (n=${n}${skipNote})`);
    console.log(`${'─'.repeat(68)}`);

    // TP hit rates
    console.log(`\n  TARGET HIT RATES (within 60 min)`);
    console.log(`    T1 +20pts: ${pct(hitT1.length, n).padStart(4)}  (${hitT1.length}/${n})`);
    console.log(`    T2 +40pts: ${pct(hitT2.length, n).padStart(4)}  (${hitT2.length}/${n})`);
    console.log(`    T3 +60pts: ${pct(hitT3.length, n).padStart(4)}  (${hitT3.length}/${n})`);

    // Time to hit (of those that hit)
    const t1Mins = hitT1.map(r => r.t1MinsSec!);
    const t2Mins = hitT2.map(r => r.t2MinsSec!);
    const t3Mins = hitT3.map(r => r.t3MinsSec!);

    console.log(`\n  TIME TO HIT (minutes, of signals that hit)`);
    console.log(`    T1 +20pts:  avg ${avg(t1Mins).padStart(5)}m  median ${med(t1Mins).padStart(5)}m`);
    console.log(`    T2 +40pts:  avg ${avg(t2Mins).padStart(5)}m  median ${med(t2Mins).padStart(5)}m`);
    console.log(`    T3 +60pts:  avg ${avg(t3Mins).padStart(5)}m  median ${med(t3Mins).padStart(5)}m`);

    // DD before each TP
    const dd1 = hitT1.map(r => r.ddAtT1!);
    const dd2 = hitT2.map(r => r.ddAtT2!);
    const dd3 = hitT3.map(r => r.ddAtT3!);

    console.log(`\n  MAX DD BEFORE HITTING TP (pts adverse, of signals that hit)`);
    console.log(`    DD before T1: avg ${avg(dd1).padStart(5)}pts  median ${med(dd1).padStart(5)}pts`);
    console.log(`    DD before T2: avg ${avg(dd2).padStart(5)}pts  median ${med(dd2).padStart(5)}pts`);
    console.log(`    DD before T3: avg ${avg(dd3).padStart(5)}pts  median ${med(dd3).padStart(5)}pts`);

    // Clean hits: T1 with DD < 10
    const cleanT1 = hitT1.filter(r => r.ddAtT1! < 10).length;
    const cleanT2 = hitT2.filter(r => r.ddAtT2! < 10).length;
    const cleanT1_5 = hitT1.filter(r => r.ddAtT1! < 5).length;
    console.log(`\n  CLEAN HITS (low DD trade quality)`);
    console.log(`    T1 with DD < 5pts:  ${pct(cleanT1_5, n).padStart(4)}  (${cleanT1_5}/${n})`);
    console.log(`    T1 with DD < 10pts: ${pct(cleanT1, n).padStart(4)}  (${cleanT1}/${n})`);
    console.log(`    T2 with DD < 10pts: ${pct(cleanT2, n).padStart(4)}  (${cleanT2}/${n})`);

    // Overall gain/DD profile
    const allMaxGain = results.map(r => r.maxGain);
    const allMaxDD   = results.map(r => r.maxDD);
    const allFinal   = results.map(r => r.finalPnl);
    console.log(`\n  OVERALL 60-MIN PROFILE`);
    console.log(`    Avg peak gain:   ${avg(allMaxGain).padStart(6)}pts`);
    console.log(`    Avg max DD:      ${avg(allMaxDD).padStart(6)}pts`);
    console.log(`    Avg final PnL:   ${avg(allFinal).padStart(6)}pts`);

    // Score band breakdown for T1 hit rate
    console.log(`\n  BY SCORE BAND (T1 hit rate / avg DD before T1)`);
    const bands = [[80,89],[90,100]] as const;
    for (const [lo, hi] of bands) {
      const sub  = results.filter(r => r.score >= lo && r.score <= hi);
      const sub1 = sub.filter(r => r.t1MinsSec !== null);
      if (!sub.length) continue;
      const ddSub = sub1.map(r => r.ddAtT1!);
      console.log(`    ${lo}-${hi}:  n=${sub.length}  T1=${pct(sub1.length,sub.length).padStart(4)}  ` +
        `avgDD=${avg(ddSub).padStart(5)}pts  medTime=${med(sub1.map(r=>r.t1MinsSec!)).padStart(5)}m`);
    }

    // Direction breakdown
    console.log(`\n  BY DIRECTION (T1 hit rate)`);
    for (const dir of ['long','short'] as const) {
      const sub  = results.filter(r => r.direction === dir);
      const sub1 = sub.filter(r => r.t1MinsSec !== null);
      if (!sub.length) continue;
      const ddSub = sub1.map(r => r.ddAtT1!);
      console.log(`    ${dir.padEnd(6)}:  n=${sub.length}  T1=${pct(sub1.length,sub.length).padStart(4)}  ` +
        `avgDD=${avg(ddSub).padStart(5)}pts  medTime=${med(sub1.map(r=>r.t1MinsSec!)).padStart(5)}m`);
    }

    // Worst losers (high DD, missed T1)
    const missedT1 = results.filter(r => r.t1MinsSec === null)
      .sort((a,b) => b.maxDD - a.maxDD).slice(0, 3);
    if (missedT1.length) {
      console.log(`\n  MISSED T1 — worst cases`);
      for (const r of missedT1) {
        console.log(`    ${toET(r.entryTs)}  ${r.direction.padEnd(5)} score=${r.score}  maxDD=${r.maxDD.toFixed(1)}pts  finalPnL=${r.finalPnl.toFixed(1)}pts`);
      }
    }
  }

  // ── cross-strategy top-line summary ───────────────────────────────────────
  const allResults = [...byRule.values()].flat().filter(r => !r.noData);
  const skippedTotal = [...byRule.values()].flat().filter(r => r.noData).length;
  const allHitT1 = allResults.filter(r => r.t1MinsSec !== null);
  const allHitT2 = allResults.filter(r => r.t2MinsSec !== null);
  const allHitT3 = allResults.filter(r => r.t3MinsSec !== null);

  console.log(`\n${'='.repeat(68)}`);
  console.log('  COMBINED GOLD-TIER SUMMARY (all A/B/D/E)');
  console.log(`${'='.repeat(68)}`);
  console.log(`  Total signals: ${allResults.length}  (${skippedTotal} skipped — no tick data)`);
  console.log(`  T1 (+20pts):  ${pct(allHitT1.length, allResults.length).padStart(4)}   avg time ${avg(allHitT1.map(r=>r.t1MinsSec!)).padStart(5)}m  medDDbefore=${med(allHitT1.map(r=>r.ddAtT1!)).padStart(5)}pts`);
  console.log(`  T2 (+40pts):  ${pct(allHitT2.length, allResults.length).padStart(4)}   avg time ${avg(allHitT2.map(r=>r.t2MinsSec!)).padStart(5)}m  medDDbefore=${med(allHitT2.map(r=>r.ddAtT2!)).padStart(5)}pts`);
  console.log(`  T3 (+60pts):  ${pct(allHitT3.length, allResults.length).padStart(4)}   avg time ${avg(allHitT3.map(r=>r.t3MinsSec!)).padStart(5)}m  medDDbefore=${med(allHitT3.map(r=>r.ddAtT3!)).padStart(5)}pts`);
  const cleanAll = allHitT1.filter(r => r.ddAtT1! < 10).length;
  console.log(`  Clean T1 (DD<10pts): ${pct(cleanAll, allResults.length).padStart(4)}   (${cleanAll}/${allResults.length})`);
  console.log(`  Avg peak gain (60m): ${avg(allResults.map(r=>r.maxGain)).padStart(6)}pts`);
  console.log(`  Avg max DD (60m):    ${avg(allResults.map(r=>r.maxDD)).padStart(6)}pts`);
  console.log(`${'='.repeat(68)}\n`);

  trDb.close();
  ticksDb.close();
}

main().catch(err => { console.error(err); process.exit(1); });
