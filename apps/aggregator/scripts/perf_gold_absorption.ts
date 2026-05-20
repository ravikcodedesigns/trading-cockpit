/**
 * perf_gold_absorption.ts
 *
 * Performance analysis: NQ Gold-tier absorption signals (++ and +, score >= 45, RTH, v2)
 *
 * Metrics per score band:
 *   - % that hit 20 / 40 / 60 pts
 *   - median & avg time (mins) to first hit each target
 *   - avg max drawdown BEFORE hitting each target (0 if never hit)
 *   - avg max drawdown across all signals (regardless of hit)
 *
 * Run: cd apps/aggregator && npx tsx scripts/perf_gold_absorption.ts
 */

import Database from 'better-sqlite3';

const TRADING_DB = '/Users/ravikumarbasker/trading-cockpit/data/trading.db';
const TICKS_DB   = '/Users/ravikumarbasker/trading-cockpit/data/ticks.db';

const db    = new Database(TRADING_DB, { readonly: true });
const ticks = new Database(TICKS_DB,   { readonly: true });

// ── RTH classifier ─────────────────────────────────────────────────────────
function isRTH(tsMs: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const wd = parts.find(p => p.type === 'weekday')?.value ?? '';
  const h  = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0');
  const m  = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0');
  return ['Mon','Tue','Wed','Thu','Fri'].includes(wd) && (h*60+m) >= 570 && (h*60+m) < 960;
}

// ── Tick query ─────────────────────────────────────────────────────────────
interface Trade { ts: number; price: number; }
const tickQuery = ticks.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol='NQ' AND ts >= ? AND ts <= ?
  ORDER BY ts ASC
`);

// ── Per-signal analysis ────────────────────────────────────────────────────
const TARGETS = [20, 40, 60] as const;
const WINDOW_MS = 60 * 60_000; // 60-minute window max

interface SignalResult {
  score: number;
  conviction: string;
  band: string;
  // For each target: ms to first hit (-1 = never), max DD before hit (NaN if never)
  hitMs20: number; ddBefore20: number;
  hitMs40: number; ddBefore40: number;
  hitMs60: number; ddBefore60: number;
  maxDD: number; // overall max drawdown in window
  mfe60m: number; // max favorable in window
}

function bandOf(score: number): string {
  if (score >= 80) return '80+';
  if (score >= 70) return '70-79';
  if (score >= 60) return '60-69';
  if (score >= 50) return '50-59';
  if (score >= 40) return '40-49';
  if (score >= 30) return '30-39';
  if (score >= 20) return '20-29';
  return '<20';
}

function analyzeSignal(entry: number, direction: 'long'|'short', signalTs: number, score: number, conviction: string): SignalResult {
  const sign = direction === 'long' ? 1 : -1;
  const trades = tickQuery.all(signalTs, signalTs + WINDOW_MS) as Trade[];

  let maxDD = 0;
  let mfe = 0;

  // Track hit time and max DD before hit for each target
  const hitMs    = [TARGETS[0], TARGETS[1], TARGETS[2]].map(() => -1);
  const ddBefore = [TARGETS[0], TARGETS[1], TARGETS[2]].map(() => NaN);
  let runningDD  = 0; // max adverse seen so far

  for (const t of trades) {
    const fav = sign * (t.price - entry);
    const adv = -fav;

    runningDD = Math.max(runningDD, adv);
    maxDD     = Math.max(maxDD,     adv);
    mfe       = Math.max(mfe,       fav);

    for (let i = 0; i < TARGETS.length; i++) {
      if (hitMs[i] === -1 && fav >= TARGETS[i]!) {
        hitMs[i]    = t.ts - signalTs;
        ddBefore[i] = runningDD;
      }
    }
  }

  return {
    score, conviction, band: bandOf(score),
    hitMs20: hitMs[0]!, ddBefore20: ddBefore[0]!,
    hitMs40: hitMs[1]!, ddBefore40: ddBefore[1]!,
    hitMs60: hitMs[2]!, ddBefore60: ddBefore[2]!,
    maxDD, mfe60m: mfe,
  };
}

// ── Load signals ────────────────────────────────────────────────────────────
interface SigRow {
  id: number; ts: number; score: number; direction: string;
  entry: number | null; conviction: string | null;
}

const sigs = db.prepare(`
  SELECT id, ts, score, direction,
    CAST(COALESCE(
      json_extract(payload,'$.entry'),
      CAST(SUBSTR(json_extract(payload,'$.rationale'),
           INSTR(json_extract(payload,'$.rationale'),'absorbed at ')+12,
           INSTR(SUBSTR(json_extract(payload,'$.rationale'),
                 INSTR(json_extract(payload,'$.rationale'),'absorbed at ')+12),' ')-1) AS REAL)
    ) AS REAL) AS entry,
    json_extract(payload,'$.conviction') AS conviction
  FROM signals
  WHERE rule_id='absorption' AND symbol='NQ'
    AND strategy_version='B'
    AND meta LIKE '%v2%'
    AND json_extract(payload,'$.conviction') IN ('++','+')
  ORDER BY ts ASC
`).all() as SigRow[];

// Filter RTH only
const rthSigs = sigs.filter(s => isRTH(s.ts));

console.log(`\nRTH NQ absorption — all conviction signals (++ / +, v2 scoring, all scores)`);
console.log(`Total signals: ${sigs.length}  |  RTH: ${rthSigs.length}\n`);

// ── Run analysis ────────────────────────────────────────────────────────────
const results: SignalResult[] = [];
let noData = 0;

for (const sig of rthSigs) {
  if (!sig.entry) continue;
  const trades = tickQuery.all(sig.ts, sig.ts + 1000) as Trade[];
  if (trades.length === 0) { noData++; continue; }

  const r = analyzeSignal(sig.entry, sig.direction as 'long'|'short', sig.ts, sig.score, sig.conviction ?? 'none');
  results.push(r);
}

console.log(`Analyzed: ${results.length}  |  No tick data: ${noData}\n`);

// ── Aggregation helpers ─────────────────────────────────────────────────────
function median(arr: number[]): number {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a,b) => a-b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m-1]! + s[m]!) / 2 : s[m]!;
}
function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : NaN;
}
function fmt(n: number, decimals = 1): string {
  return isNaN(n) ? ' n/a' : n.toFixed(decimals);
}
function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${Math.round(100*n/d)}%`;
}

// ── Print per-band breakdown ────────────────────────────────────────────────
const BAND_ORDER = ['80+','70-79','60-69','50-59','40-49','30-39','20-29','<20'];

function printBand(label: string, rows: SignalResult[]) {
  if (!rows.length) return;

  const hit20 = rows.filter(r => r.hitMs20 >= 0);
  const hit40 = rows.filter(r => r.hitMs40 >= 0);
  const hit60 = rows.filter(r => r.hitMs60 >= 0);

  const time20m = hit20.map(r => r.hitMs20 / 60_000);
  const time40m = hit40.map(r => r.hitMs40 / 60_000);
  const time60m = hit60.map(r => r.hitMs60 / 60_000);

  const n = rows.length;

  console.log(`┌${'─'.repeat(68)}┐`);
  console.log(`│  ${label.padEnd(66)}│`);
  console.log(`│  n=${n}  ++=${rows.filter(r=>r.conviction==='++').length}  +=${rows.filter(r=>r.conviction==='+').length}`.padEnd(69) + '│');
  console.log(`├${'─'.repeat(68)}┤`);
  console.log(`│  ${'Target'.padEnd(8)} ${'Hit%'.padStart(5)} ${'Avg time'.padStart(10)} ${'Med time'.padStart(10)} ${'Avg DD before'.padStart(14)} ${'Avg max DD'.padStart(11)}│`);
  console.log(`├${'─'.repeat(68)}┤`);

  for (const [target, hitRows, timeMins] of [
    [20, hit20, time20m] as const,
    [40, hit40, time40m] as const,
    [60, hit60, time60m] as const,
  ]) {
    const ddKey = target === 20 ? 'ddBefore20' : target === 40 ? 'ddBefore40' : 'ddBefore60';
    const ddVals = hitRows.map(r => r[ddKey]).filter(v => !isNaN(v));
    const allDD  = rows.map(r => r.maxDD);

    const line = [
      `${target}pts`.padEnd(8),
      pct(hitRows.length, n).padStart(5),
      `${fmt(avg(timeMins))}m`.padStart(10),
      `${fmt(median(timeMins))}m`.padStart(10),
      `${fmt(avg(ddVals))}pts`.padStart(14),
      `${fmt(avg(allDD))}pts`.padStart(11),
    ].join(' ');
    console.log(`│  ${line}│`);
  }

  console.log(`├${'─'.repeat(68)}┤`);
  const avgMfe = avg(rows.map(r => r.mfe60m));
  const avgMaxDD = avg(rows.map(r => r.maxDD));
  console.log(`│  Avg MFE (60m): ${fmt(avgMfe)}pts    Avg max DD: ${fmt(avgMaxDD)}pts`.padEnd(69) + '│');
  console.log(`└${'─'.repeat(68)}┘\n`);
}

// All gold tier
printBand('ALL RTH CONVICTION SIGNALS (++ / +, all scores)', results);

// By conviction
for (const cv of ['++', '+']) {
  const rows = results.filter(r => r.conviction === cv);
  if (rows.length) printBand(`CONVICTION ${cv}`, rows);
}

// By band
for (const b of BAND_ORDER) {
  const rows = results.filter(r => r.band === b);
  if (rows.length) printBand(`SCORE BAND ${b}`, rows);
}

// By band x conviction
for (const b of BAND_ORDER) {
  for (const cv of ['++', '+']) {
    const rows = results.filter(r => r.band === b && r.conviction === cv);
    if (rows.length >= 3) printBand(`${b}  ${cv}`, rows);
  }
}

db.close();
ticks.close();
