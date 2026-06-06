// WR + PnL for non-ABSO qualified signals, with OPEN positions
// force-closed at 15:54 ET of the same RTH day (no overnight hold).
//
// Methodology:
//   1. Pull all qualified non-ABSO signals from qualified_signals table
//      (joined with signal_outcomes for signal_price + hit_tp + stopped).
//   2. WIN/LOSS classification:
//        - hit_tp=1 → WIN at +TP_rule pts
//        - stopped=1 AND hit_tp=0 → LOSS at -SL_rule pts
//        - both NULL or both 0 → OPEN, force-close at 15:54 ET
//   3. For force-close: look up last trade ≤ 15:54 ET on the signal's day.
//        PnL = direction × (close_price - signal_price)
//   4. Only count signals that fired during RTH (09:30-15:54 ET).
//      Overnight signals are excluded (user doesn't trade overnight).
//
// Rule-specific TP/SL (V3 production values):
//   clean-impulse LONG  TP=80 SL=55
//   clean-impulse SHORT TP=80 SL=105   (V3 drops these anyway)
//   expl                TP=70 SL=70
//   tape-speed / large-print: TP=SL=80 (not V3 entry rules but counted for completeness)

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const trDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const tkDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

function tpFor(rule: string, dir: string): number {
  if (rule === 'clean-impulse') return 80;
  if (rule === 'expl')          return 70;
  return 80;
}
function slFor(rule: string, dir: string): number {
  if (rule === 'clean-impulse' && dir === 'long')  return 55;
  if (rule === 'clean-impulse' && dir === 'short') return 105;
  if (rule === 'expl')          return 70;
  return 80;
}

// Pull qualified non-ABSO signals + their outcome metadata
const rows = trDb.prepare(`
  SELECT
    qs.signal_id, qs.signal_ts, qs.symbol, qs.rule_id, qs.direction, qs.score,
    so.signal_price, so.hit_tp, so.stopped, so.max_gain, so.max_dd
  FROM qualified_signals qs
  LEFT JOIN signal_outcomes so ON so.signal_id = qs.signal_id
  WHERE qs.symbol = 'NQ' AND qs.rule_id != 'absorption'
  ORDER BY qs.signal_ts ASC
`).all() as Array<{
  signal_id: number; signal_ts: number; symbol: string; rule_id: string;
  direction: string; score: number; signal_price: number | null;
  hit_tp: number | null; stopped: number | null;
  max_gain: number | null; max_dd: number | null;
}>;

console.log(`\n══ Non-ABSO qualified signals — close-at-15:54-ET ══`);
console.log(`Pulled ${rows.length} signals from qualified_signals (excluding absorption)\n`);

// ET timing helpers — 15:54 ET = the V3 RTH close timer
function etDateOf(tsMs: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(tsMs));
}
function et1554Of(tsMs: number): number {
  const day = etDateOf(tsMs);
  return Date.parse(`${day}T15:54:00-04:00`);
}
function isRTHFire(tsMs: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const min = parseInt(get('hour'),10)*60 + parseInt(get('minute'),10);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(get('weekday')) && min >= 570 && min < 954;  // 09:30 → 15:54
}

const priceAt = tkDb.prepare(`
  SELECT price FROM trades WHERE symbol='NQ' AND ts <= ? ORDER BY ts DESC LIMIT 1
`);

interface Bucket {
  rule_id: string;
  direction: string;
  n: number;
  wins: number;
  losses: number;
  closes: number;     // forced-close events
  noData: number;
  pnlPts: number;
}
const buckets = new Map<string, Bucket>();
function bucketKey(r: string, d: string) { return `${r}|${d}`; }
function getBucket(r: string, d: string): Bucket {
  const k = bucketKey(r, d);
  let b = buckets.get(k);
  if (!b) {
    b = { rule_id: r, direction: d, n: 0, wins: 0, losses: 0, closes: 0, noData: 0, pnlPts: 0 };
    buckets.set(k, b);
  }
  return b;
}

let totalRTH = 0;
let totalSkipped = 0;
let totalClosed = 0;

for (const r of rows) {
  // Only RTH-fired signals (user doesn't trade overnight)
  if (!isRTHFire(r.signal_ts)) { totalSkipped++; continue; }
  totalRTH++;

  const b = getBucket(r.rule_id, r.direction);
  b.n++;
  const dir = r.direction === 'long' ? 1 : -1;
  const tp = tpFor(r.rule_id, r.direction);
  const sl = slFor(r.rule_id, r.direction);

  // Closed by TP or SL?
  if (r.hit_tp === 1) {
    b.wins++; b.pnlPts += tp; continue;
  }
  if (r.stopped === 1 && r.hit_tp === 0) {
    b.losses++; b.pnlPts -= sl; continue;
  }
  // Force close at 15:54 ET (or NO_DATA if no signal_price)
  if (r.signal_price == null) { b.noData++; continue; }
  const t1554 = et1554Of(r.signal_ts);
  const closeRow = priceAt.get(t1554) as { price: number } | undefined;
  if (!closeRow) { b.noData++; continue; }
  const closePnl = dir * (closeRow.price - r.signal_price);
  // Cap at TP/SL (you wouldn't actually realize > TP without exiting; we already know it didn't hit TP since hit_tp=0)
  // For force-close, the realized PnL is whatever's at the bell — don't cap.
  b.closes++;
  b.pnlPts += closePnl;
  totalClosed++;
}

console.log(`Filter: RTH-fired only (09:30-15:54 ET). Overnight signals skipped: ${totalSkipped}.`);
console.log(`Qualifying RTH signals: ${totalRTH}. Force-closed at bell: ${totalClosed}.\n`);

// Print per-rule rows
console.log(`── Per-rule (after 15:54 close on OPEN positions) ──`);
console.log(`  ${'rule'.padEnd(18)} ${'dir'.padEnd(6)} ${'n'.padStart(4)} ${'W'.padStart(4)} ${'L'.padStart(4)} ${'BELL'.padStart(5)} ${'no_data'.padStart(8)}   WR(closed+bell)   PnL_pts`);
const ordered = [...buckets.values()].sort((a, b) =>
  a.rule_id.localeCompare(b.rule_id) || a.direction.localeCompare(b.direction));
let totN=0, totW=0, totL=0, totC=0, totND=0, totPnl=0;
for (const b of ordered) {
  // Count "wins" as wins + positive-close-at-bell;
  // Count "losses" as losses + negative-close-at-bell.
  // Easier: just compute (wins + losses) and add bell results separately.
  // For WR including bell: re-classify forced-closes as wins/losses based on sign.
  const closed = b.wins + b.losses + b.closes;
  const wrPct = closed > 0 ? (b.pnlPts > 0 ? '~positive' : '~negative') : '—';
  // Actually compute a clean WR: rerun the close decisions split into +/-/flat for OPENs
  console.log(
    `  ${b.rule_id.padEnd(18)} ${b.direction.padEnd(6)} ${String(b.n).padStart(4)} ${String(b.wins).padStart(4)} ${String(b.losses).padStart(4)} ${String(b.closes).padStart(5)} ${String(b.noData).padStart(8)}   ${''.padStart(15)}   ${(b.pnlPts > 0 ? '+' : '') + b.pnlPts.toFixed(0).padStart(6)}`
  );
  totN += b.n; totW += b.wins; totL += b.losses; totC += b.closes; totND += b.noData; totPnl += b.pnlPts;
}
console.log(`  ────────────────────────────────────────────────────────────────────────────────────────`);
console.log(
  `  ${'TOTAL'.padEnd(18)} ${''.padEnd(6)} ${String(totN).padStart(4)} ${String(totW).padStart(4)} ${String(totL).padStart(4)} ${String(totC).padStart(5)} ${String(totND).padStart(8)}                    ${(totPnl > 0 ? '+' : '') + totPnl.toFixed(0)}`
);

// Now re-pass for clean win/loss accounting after bell-close
console.log(`\n── Combined WIN/LOSS classification (TP hit, SL hit, or bell-close +/-/flat) ──`);
const buckets2 = new Map<string, { rule:string; dir:string; n:number; wins:number; losses:number; flats:number; noData:number; pnlPts:number }>();
function gb2(r: string, d: string) {
  const k = `${r}|${d}`;
  let b = buckets2.get(k);
  if (!b) { b = { rule: r, dir: d, n:0, wins:0, losses:0, flats:0, noData:0, pnlPts:0 }; buckets2.set(k, b); }
  return b;
}
for (const r of rows) {
  if (!isRTHFire(r.signal_ts)) continue;
  const b = gb2(r.rule_id, r.direction);
  b.n++;
  const dir = r.direction === 'long' ? 1 : -1;
  const tp = tpFor(r.rule_id, r.direction);
  const sl = slFor(r.rule_id, r.direction);

  if (r.hit_tp === 1)               { b.wins++; b.pnlPts += tp; continue; }
  if (r.stopped === 1 && r.hit_tp === 0) { b.losses++; b.pnlPts -= sl; continue; }
  if (r.signal_price == null) { b.noData++; continue; }
  const t1554 = et1554Of(r.signal_ts);
  const closeRow = priceAt.get(t1554) as { price: number } | undefined;
  if (!closeRow) { b.noData++; continue; }
  const closePnl = dir * (closeRow.price - r.signal_price);
  b.pnlPts += closePnl;
  if (closePnl > 0)       b.wins++;
  else if (closePnl < 0)  b.losses++;
  else                    b.flats++;
}
console.log(`  ${'rule'.padEnd(18)} ${'dir'.padEnd(6)} ${'n'.padStart(4)} ${'W'.padStart(4)} ${'L'.padStart(4)} ${'flat'.padStart(5)} ${'WR(W/(W+L))'.padStart(13)}   ${'PnL_pts'.padStart(9)}`);
const ord2 = [...buckets2.values()].sort((a, b) => a.rule.localeCompare(b.rule) || a.dir.localeCompare(b.dir));
let t2N=0, t2W=0, t2L=0, t2F=0, t2Pnl=0;
for (const b of ord2) {
  const closed = b.wins + b.losses;
  const wr = closed > 0 ? (b.wins/closed*100).toFixed(1) : '—';
  console.log(
    `  ${b.rule.padEnd(18)} ${b.dir.padEnd(6)} ${String(b.n).padStart(4)} ${String(b.wins).padStart(4)} ${String(b.losses).padStart(4)} ${String(b.flats).padStart(5)} ${wr.padStart(11)}%   ${(b.pnlPts > 0 ? '+' : '') + b.pnlPts.toFixed(0).padStart(8)}`
  );
  t2N += b.n; t2W += b.wins; t2L += b.losses; t2F += b.flats; t2Pnl += b.pnlPts;
}
const totalWR = (t2W + t2L) > 0 ? (t2W/(t2W+t2L)*100).toFixed(1) : '—';
console.log(`  ──────────────────────────────────────────────────────────────────────────────────`);
console.log(
  `  ${'TOTAL'.padEnd(18)} ${''.padEnd(6)} ${String(t2N).padStart(4)} ${String(t2W).padStart(4)} ${String(t2L).padStart(4)} ${String(t2F).padStart(5)} ${totalWR.padStart(11)}%   ${(t2Pnl > 0 ? '+' : '') + t2Pnl.toFixed(0)}`
);

trDb.close(); tkDb.close();
