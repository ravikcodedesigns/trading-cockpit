/**
 * Outcome Report
 *
 * Prints a human-readable summary of signal outcomes from the matured table.
 * Breaks down by rule, session, score band; shows hit rates at 20/30/40 point
 * thresholds across 5/15/30/60 minute windows.
 *
 * Run: pnpm --filter aggregator score:report
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../../data/trading.db');

const db = new Database(DB_PATH, { readonly: true });

// --- Helpers ---

function classifySession(tsMs: number): 'overnight' | 'rth' | 'closed' {
  const d = new Date(tsMs);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const wd = parts.find(p => p.type === 'weekday')?.value ?? '';
  const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  const min = h * 60 + m;
  const isWeekday = ['Mon','Tue','Wed','Thu','Fri'].includes(wd);
  if (isWeekday && min >= 570 && min < 960) return 'rth';      // 9:30-16:00
  if (isWeekday && min >= 1080) return 'overnight';            // 18:00+
  if (isWeekday && min < 570) return 'overnight';              // pre-9:30
  if (wd === 'Sun' && min >= 1080) return 'overnight';
  return 'closed';
}

function scoreBand(score: number): string {
  if (score >= 90) return '90+';
  if (score >= 80) return '80-89';
  if (score >= 70) return '70-79';
  if (score >= 60) return '60-69';
  return '50-59';
}

function pad(s: string | number, n: number): string {
  const str = String(s);
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function pct(n: number, d: number): string {
  if (d === 0) return '  -';
  return `${Math.round(100 * n / d).toString().padStart(3)}%`;
}

// --- Main ---

interface MaturedRow {
  signal_id: number;
  signal_ts: number;
  symbol: string;
  rule_id: string;
  score: number;
  direction: 'long' | 'short';
  signal_price: number;
  w5_max_gain: number; w5_max_drawdown: number; w5_net: number; w5_hit20: number; w5_hit30: number; w5_hit40: number; w5_clean20: number; w5_clean30: number; w5_clean40: number;
  w15_max_gain: number; w15_max_drawdown: number; w15_net: number; w15_hit20: number; w15_hit30: number; w15_hit40: number; w15_clean20: number; w15_clean30: number; w15_clean40: number;
  w30_max_gain: number; w30_max_drawdown: number; w30_net: number; w30_hit20: number; w30_hit30: number; w30_hit40: number; w30_clean20: number; w30_clean30: number; w30_clean40: number;
  w60_max_gain: number; w60_max_drawdown: number; w60_net: number; w60_hit20: number; w60_hit30: number; w60_hit40: number; w60_clean20: number; w60_clean30: number; w60_clean40: number;
}

const all = db.prepare('SELECT * FROM signal_outcomes_matured ORDER BY signal_ts').all() as MaturedRow[];
const partialCount = (db.prepare('SELECT COUNT(*) AS c FROM signal_outcomes_partial').get() as { c: number }).c;

console.log('========================================');
console.log('   SIGNAL OUTCOMES REPORT');
console.log('========================================');
console.log(`Matured signals: ${all.length}`);
console.log(`Partial (in-progress): ${partialCount}`);

if (all.length === 0) {
  console.log('\nNo matured signals yet. Run after signals age 60+ minutes.');
  db.close();
  process.exit(0);
}

// Group by rule + session + score band
type Bucket = {
  count: number;
  totalGain5: number; totalGain15: number; totalGain30: number; totalGain60: number;
  totalDrawdown5: number; totalDrawdown15: number; totalDrawdown30: number; totalDrawdown60: number;
  hit20_5: number; hit20_15: number; hit20_30: number; hit20_60: number;
  hit30_5: number; hit30_15: number; hit30_30: number; hit30_60: number;
  hit40_5: number; hit40_15: number; hit40_30: number; hit40_60: number;
  clean30_60: number; clean40_60: number;  // clean wins at 60-min window
};

const groups = new Map<string, Bucket>();

function emptyBucket(): Bucket {
  return {
    count: 0,
    totalGain5: 0, totalGain15: 0, totalGain30: 0, totalGain60: 0,
    totalDrawdown5: 0, totalDrawdown15: 0, totalDrawdown30: 0, totalDrawdown60: 0,
    hit20_5: 0, hit20_15: 0, hit20_30: 0, hit20_60: 0,
    hit30_5: 0, hit30_15: 0, hit30_30: 0, hit30_60: 0,
    hit40_5: 0, hit40_15: 0, hit40_30: 0, hit40_60: 0,
    clean30_60: 0, clean40_60: 0,
  };
}

for (const r of all) {
  const session = classifySession(r.signal_ts);
  const band = scoreBand(r.score);
  const key = `${r.rule_id}|${session}|${band}`;
  const b = groups.get(key) ?? emptyBucket();
  b.count++;
  b.totalGain5 += r.w5_max_gain; b.totalGain15 += r.w15_max_gain; b.totalGain30 += r.w30_max_gain; b.totalGain60 += r.w60_max_gain;
  b.totalDrawdown5 += r.w5_max_drawdown; b.totalDrawdown15 += r.w15_max_drawdown; b.totalDrawdown30 += r.w30_max_drawdown; b.totalDrawdown60 += r.w60_max_drawdown;
  b.hit20_5 += r.w5_hit20; b.hit20_15 += r.w15_hit20; b.hit20_30 += r.w30_hit20; b.hit20_60 += r.w60_hit20;
  b.hit30_5 += r.w5_hit30; b.hit30_15 += r.w15_hit30; b.hit30_30 += r.w30_hit30; b.hit30_60 += r.w60_hit30;
  b.hit40_5 += r.w5_hit40; b.hit40_15 += r.w15_hit40; b.hit40_30 += r.w30_hit40; b.hit40_60 += r.w60_hit40;
  b.clean30_60 += r.w60_clean30;
  b.clean40_60 += r.w60_clean40;
  groups.set(key, b);
}

// Print sections grouped by rule
const rules = Array.from(new Set(all.map(r => r.rule_id))).sort();
const sessions: Array<'overnight' | 'rth' | 'closed'> = ['overnight', 'rth', 'closed'];
const bands = ['50-59', '60-69', '70-79', '80-89', '90+'];

for (const rule of rules) {
  console.log(`\n--- ${rule.toUpperCase()} ---`);

  for (const session of sessions) {
    // Skip empty session/rule combos
    let sessionTotal = 0;
    for (const band of bands) {
      const b = groups.get(`${rule}|${session}|${band}`);
      if (b) sessionTotal += b.count;
    }
    if (sessionTotal === 0) continue;

    console.log(`\n  ${session.toUpperCase()} (n=${sessionTotal})`);
    console.log(`  ${pad('score', 8)} ${pad('n', 5)} ${pad('avgGain60', 10)} ${pad('avgDrawdown60', 14)} ${pad('hit20@15', 9)} ${pad('hit20@60', 9)} ${pad('hit30@60', 9)} ${pad('hit40@60', 9)} ${pad('clean30@60', 11)}`);

    for (const band of bands) {
      const b = groups.get(`${rule}|${session}|${band}`);
      if (!b || b.count === 0) continue;
      const avgGain60 = (b.totalGain60 / b.count).toFixed(1);
      const avgDrawdown60 = (b.totalDrawdown60 / b.count).toFixed(1);
      console.log(`  ${pad(band, 8)} ${pad(b.count, 5)} ${pad(avgGain60, 10)} ${pad(avgDrawdown60, 14)} ${pad(pct(b.hit20_15, b.count), 9)} ${pad(pct(b.hit20_60, b.count), 9)} ${pad(pct(b.hit30_60, b.count), 9)} ${pad(pct(b.hit40_60, b.count), 9)} ${pad(pct(b.clean30_60, b.count), 11)}`);
    }
  }
}

console.log('\n========================================');
console.log('Legend:');
console.log('  avgGain60   = avg peak gain (in signal direction) within 60 min');
console.log('  avgDrawdown60     = avg peak drawdown (against signal) within 60 min');
console.log('  hit20@15    = % of signals where peak gain >= 20 pts within 15 min');
console.log('  hit20@60    = % where peak gain >= 20 pts within 60 min');
console.log('  clean30@60  = % where peak gain >= 30 AND drawdown < 5 within 60 min (clean win)');
console.log('========================================');

db.close();
