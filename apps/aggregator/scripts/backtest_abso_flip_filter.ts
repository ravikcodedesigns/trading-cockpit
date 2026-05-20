/**
 * backtest_abso_flip_filter.ts
 *
 * Tests whether requiring "last H FLIP same direction within 60 min"
 * improves gold-tier absorption signal performance.
 *
 * Gold tier = strategy_version='B', conviction in ('+','++'), score >= 50, RTH session.
 * Win = w15_hit20 = 1 (hits 20pt target within 15-min window).
 *
 * Run: cd apps/aggregator && npx tsx scripts/backtest_abso_flip_filter.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../../data/trading.db');
const db = new Database(DB_PATH, { readonly: true });

const FLIP_LOOKBACK = 30 * 60_000; // 30 min

function isRth(tsMs: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  const isWeekday = ['Mon','Tue','Wed','Thu','Fri'].includes(weekday);
  return isWeekday && min >= 570 && min < 960;
}

// Load all gold B signals with outcomes
const goldB = db.prepare(`
  SELECT s.id, s.ts, s.symbol, s.direction, s.score,
    json_extract(s.payload,'$.conviction') AS conviction,
    o.w15_hit20, o.w15_clean20, o.w15_net, o.w15_max_gain, o.w15_max_drawdown
  FROM signals s
  JOIN signal_outcomes_matured o ON o.signal_id = s.id
  WHERE s.strategy_version = 'B'
    AND json_extract(s.payload,'$.conviction') IN ('+','++')
    AND s.score >= 50
  ORDER BY s.ts ASC
`).all() as any[];

// Filter to RTH only
const rthB = goldB.filter(s => isRth(s.ts));

// Load all H FLIP signals (need full set for lookback)
const allFlips = db.prepare(`
  SELECT ts, symbol, direction
  FROM signals
  WHERE strategy_version = 'H'
    AND json_extract(payload,'$.pattern') = 'FLIP'
  ORDER BY ts ASC
`).all() as { ts: number; symbol: string; direction: string }[];

// For each gold B signal, check if there's a same-symbol, same-direction FLIP within 60 min
function lastFlipInWindow(sig: any): { found: boolean; flipTs?: number; flipDir?: string } {
  const candidates = allFlips.filter(f =>
    f.symbol === sig.symbol &&
    f.ts < sig.ts &&
    f.ts >= sig.ts - FLIP_LOOKBACK
  );
  if (candidates.length === 0) return { found: false };
  const last = candidates.at(-1)!;
  return { found: last.direction === sig.direction, flipTs: last.ts, flipDir: last.direction };
}

// Bucket results
interface Bucket { n: number; wins: number; totalNet: number; }
const newBucket = (): Bucket => ({ n: 0, wins: 0, totalNet: 0 });

const all      = newBucket();
const filtered = newBucket(); // passes the FLIP filter
const blocked  = newBucket(); // blocked by FLIP filter
const noFlip   = newBucket(); // no FLIP in window at all

for (const sig of rthB) {
  const isWin = sig.w15_hit20 === 1;
  const net   = sig.w15_net ?? 0;

  all.n++; if (isWin) all.wins++; all.totalNet += net;

  const ctx = lastFlipInWindow(sig);
  if (!ctx.found) {
    // No same-dir FLIP in window — check if there was ANY flip (opposing or none)
    const anyFlip = allFlips.find(f =>
      f.symbol === sig.symbol && f.ts < sig.ts && f.ts >= sig.ts - FLIP_LOOKBACK
    );
    if (!anyFlip) {
      noFlip.n++; if (isWin) noFlip.wins++; noFlip.totalNet += net;
    }
    blocked.n++; if (isWin) blocked.wins++; blocked.totalNet += net;
  } else {
    filtered.n++; if (isWin) filtered.wins++; filtered.totalNet += net;
  }
}

const pct  = (b: Bucket) => b.n ? (b.wins / b.n * 100).toFixed(1) + '%' : '-';
const avgN = (b: Bucket) => b.n ? (b.totalNet / b.n).toFixed(2) : '-';

console.log('\n══ Absorption + FLIP Direction Filter Backtest ══════════════════════════');
console.log(`  Gold B signals in RTH with outcomes: ${rthB.length}`);
console.log('');
console.log('  Segment                    n      win%   avg_net_15m');
console.log('  ─────────────────────────────────────────────────────');
console.log(`  All gold RTH              ${String(all.n).padStart(5)}   ${pct(all).padStart(6)}   ${avgN(all)}`);
console.log(`  FLIP-filtered (pass)      ${String(filtered.n).padStart(5)}   ${pct(filtered).padStart(6)}   ${avgN(filtered)}`);
console.log(`  FLIP-blocked (fail+opp)   ${String(blocked.n).padStart(5)}   ${pct(blocked).padStart(6)}   ${avgN(blocked)}`);
console.log(`  No FLIP in window at all  ${String(noFlip.n).padStart(5)}   ${pct(noFlip).padStart(6)}   ${avgN(noFlip)}`);

// Break filtered by symbol
console.log('\n── Filtered signals by symbol ───────────────────────────────────────────');
for (const sym of ['NQ','ES']) {
  const symsigs = rthB.filter(s => s.symbol === sym);
  const symFilt = symsigs.filter(s => lastFlipInWindow(s).found);
  const symBlk  = symsigs.filter(s => !lastFlipInWindow(s).found);
  const symWin  = (arr: any[]) => arr.length ? (arr.filter(s => s.w15_hit20 === 1).length / arr.length * 100).toFixed(1) + '%' : '-';
  console.log(`  ${sym}: all=${symsigs.length} (${symWin(symsigs)})  filtered=${symFilt.length} (${symWin(symFilt)})  blocked=${symBlk.length} (${symWin(symBlk)})`);
}

// Break filtered by conviction level
console.log('\n── Filtered signals by conviction ───────────────────────────────────────');
for (const conv of ['++', '+']) {
  const c = rthB.filter(s => s.conviction === conv);
  const cf = c.filter(s => lastFlipInWindow(s).found);
  const cb = c.filter(s => !lastFlipInWindow(s).found);
  const w  = (arr: any[]) => arr.length ? (arr.filter(s => s.w15_hit20 === 1).length / arr.length * 100).toFixed(1) + '%' : '-';
  console.log(`  conv=${conv}: all=${c.length} (${w(c)})  filtered=${cf.length} (${w(cf)})  blocked=${cb.length} (${w(cb)})`);
}

// Sample of filtered passes and their dates
console.log('\n── Sample filtered PASS signals (FLIP-context wins) ─────────────────────');
const fmt = (ts: number) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(ts)).replace(',', '');

const filteredSigs = rthB.filter(s => lastFlipInWindow(s).found);
const wins = filteredSigs.filter(s => s.w15_hit20 === 1);
const losses = filteredSigs.filter(s => s.w15_hit20 !== 1);
console.log(`  Wins: ${wins.length}  Losses: ${losses.length}`);
console.log('  time          sym  dir    sc  conv  net15   flipCtx');
for (const sig of filteredSigs.slice(-30)) {
  const ctx = lastFlipInWindow(sig);
  const minsAgo = ctx.flipTs ? Math.round((sig.ts - ctx.flipTs!) / 60_000) : '-';
  console.log(
    '  ' + fmt(sig.ts).padEnd(14) +
    sig.symbol.padEnd(5) +
    sig.direction.padEnd(7) +
    String(sig.score).padStart(3) + '  ' +
    (sig.conviction ?? '-').padEnd(4) + '  ' +
    String((sig.w15_net ?? 0).toFixed(1)).padStart(6) + '  ' +
    `FLIP ${ctx.flipDir} ${minsAgo}m ago`
  );
}

db.close();
