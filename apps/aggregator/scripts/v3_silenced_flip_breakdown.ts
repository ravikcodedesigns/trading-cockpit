// Decomposes the 89 V3-SILENCED NQ FLIP signals by quality.ts gate reason,
// then evaluates each bucket's standalone PnL to find which gate is dropping
// real money.
//
// quality.ts gates for clean-impulse FLIP (strategy='H'):
//   Gate A (LONG only): delta15 >= +500           → silence
//   Gate B (LONG):       delta5  > -1000          → silence (wrong-direction tape)
//   Gate B (SHORT):      delta5  <  +1000         → silence (wrong-direction tape)
//   else:                                          → gold
//
// We re-derive the gate reason from the signal's payload (delta15, delta5)
// since qualified_signals only stores PASS rows, not the silencing reason.

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });

const TP = 80;
const SL_LONG = 55;
const SL_SHORT = 105;
const FWD_MS = 120 * 60_000;
const PV_NQ = 2;
const DELTA15_LONG_MAX = 500;
const DELTA5_THRESHOLD = 1000;

// Pull all SILENCED (not in qualified_signals) NQ FLIPs with payload fields
const silenced = db.prepare(`
  SELECT s.id, s.ts, s.direction, s.score,
         json_extract(s.payload,'$.entry')   AS entry,
         json_extract(s.payload,'$.delta15') AS delta15,
         json_extract(s.payload,'$.delta5')  AS delta5,
         s.ctx_gm
  FROM signals s
  LEFT JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.rule_id='clean-impulse'
    AND s.symbol='NQ'
    AND json_extract(s.payload,'$.pattern')='FLIP'
    AND q.signal_id IS NULL
  ORDER BY s.ts ASC
`).all() as Array<{ id: number; ts: number; direction: 'long'|'short'; score: number; entry: number; delta15: number|null; delta5: number|null; ctx_gm: string|null }>;

console.log(`Silenced NQ FLIPs: ${silenced.length}\n`);

const fwd = ticksDb.prepare(`SELECT price FROM trades WHERE symbol='NQ' AND ts > ? AND ts <= ? ORDER BY ts ASC`);
function outcomeOf(entry: number, dir: 'long'|'short', startMs: number): 'W'|'L'|'O' {
  const slPts = dir === 'long' ? SL_LONG : SL_SHORT;
  const ticks = fwd.all(startMs, startMs + FWD_MS) as Array<{ price: number }>;
  for (const t of ticks) {
    const m = dir === 'long' ? t.price - entry : entry - t.price;
    if (m >=  TP)     return 'W';
    if (m <= -slPts)  return 'L';
  }
  return 'O';
}
function pnlPts(o: 'W'|'L'|'O', dir: 'long'|'short'): number {
  if (o === 'W') return TP;
  if (o === 'L') return dir === 'long' ? -SL_LONG : -SL_SHORT;
  return 0;
}

// Classify each silenced signal by gate reason
function gateReason(s: { direction: 'long'|'short'; delta15: number|null; delta5: number|null }): string {
  const d5 = s.delta5 ?? 0;
  if (s.direction === 'long') {
    const d15 = s.delta15 ?? null;
    if (d15 !== null && d15 >= DELTA15_LONG_MAX) {
      return `A: delta15>=${DELTA15_LONG_MAX}`;
    }
    if (d5 > -DELTA5_THRESHOLD) {
      return `B: delta5>-${DELTA5_THRESHOLD} (long)`;
    }
  } else {
    if (d5 < DELTA5_THRESHOLD) {
      return `B: delta5<+${DELTA5_THRESHOLD} (short)`;
    }
  }
  return 'PASS (should not be silenced?)';
}

interface Row { gate: string; dir: 'long'|'short'; outcome: 'W'|'L'|'O'; pts: number; delta15: number|null; delta5: number|null; score: number; ts: number; entry: number; }
const rows: Row[] = [];
for (const s of silenced) {
  const o = outcomeOf(s.entry, s.direction, s.ts);
  rows.push({
    gate: gateReason(s),
    dir: s.direction,
    outcome: o,
    pts: pnlPts(o, s.direction),
    delta15: s.delta15,
    delta5: s.delta5,
    score: s.score,
    ts: s.ts,
    entry: s.entry,
  });
}

function summary(rs: Row[], label: string): void {
  const w = rs.filter(r => r.outcome === 'W').length;
  const l = rs.filter(r => r.outcome === 'L').length;
  const o = rs.filter(r => r.outcome === 'O').length;
  const wr = (w+l) ? (w/(w+l)*100).toFixed(0) : '--';
  const pts = rs.reduce((s, r) => s + r.pts, 0);
  const $ = pts * PV_NQ;
  const ev = rs.length ? (pts/rs.length).toFixed(2) : '0';
  console.log(`${label.padEnd(40)}  n=${String(rs.length).padStart(3)}  W=${String(w).padStart(3)}  L=${String(l).padStart(3)}  O=${String(o).padStart(2)}  WR=${String(wr).padStart(4)}%  EV=${String(ev).padStart(6)}pts  net=${pts.toFixed(0).padStart(5)}pts  $=${$>=0?'+$':'-$'}${Math.abs($).toFixed(0)}`);
}

console.log('═══ Silenced FLIPs by gate reason ═══');
const buckets = new Map<string, Row[]>();
for (const r of rows) {
  if (!buckets.has(r.gate)) buckets.set(r.gate, []);
  buckets.get(r.gate)!.push(r);
}
const sorted = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [gate, rs] of sorted) summary(rs, gate);

console.log('\n═══ Silenced by direction ═══');
summary(rows.filter(r => r.dir === 'long'),  'LONG silenced');
summary(rows.filter(r => r.dir === 'short'), 'SHORT silenced');

// Breakdown of gate-A bucket (LONG delta15 gate) by delta15 magnitude
console.log('\n═══ Gate A (delta15) — magnitude breakdown ═══');
const gateA = rows.filter(r => r.gate.startsWith('A'));
const bandA = [[500,999],[1000,1499],[1500,1999],[2000,Infinity]];
for (const band of bandA) {
  const lo = band[0]!, hi = band[1]!;
  const rs = gateA.filter(r => (r.delta15 ?? 0) >= lo && (r.delta15 ?? 0) <= hi);
  if (rs.length) summary(rs, `  delta15 ${lo}-${hi === Infinity ? '∞' : hi}`);
}

// Breakdown of gate-B bucket (delta5 wrong-direction) by direction + magnitude
console.log('\n═══ Gate B (delta5) — direction × magnitude ═══');
console.log('LONG (need d5 <= -1000):');
const gateBLong = rows.filter(r => r.dir === 'long' && r.gate.startsWith('B'));
const bandsBLong = [[-999,-500],[-499,0],[1,500],[501,1500],[1501,Infinity]];
for (const band of bandsBLong) {
  const lo = band[0]!, hi = band[1]!;
  const rs = gateBLong.filter(r => (r.delta5 ?? 0) >= lo && (r.delta5 ?? 0) <= hi);
  if (rs.length) summary(rs, `  delta5 ${lo}-${hi === Infinity ? '∞' : hi}`);
}
console.log('SHORT (need d5 >= +1000):');
const gateBShort = rows.filter(r => r.dir === 'short' && r.gate.startsWith('B'));
const bandsBShort = [[-Infinity,-1500],[-1499,-501],[-500,499],[500,999]];
for (const band of bandsBShort) {
  const lo = band[0]!, hi = band[1]!;
  const rs = gateBShort.filter(r => (r.delta5 ?? 0) >= lo && (r.delta5 ?? 0) <= hi);
  if (rs.length) summary(rs, `  delta5 ${lo === -Infinity ? '-∞' : lo}-${hi}`);
}

// What if we relaxed each gate? Show cumulative incremental impact.
console.log('\n═══ Relaxation analysis: what if we loosened each gate? ═══');

// Scenario: relax delta15 LONG threshold from 500 → X
console.log('Loosen Gate A (delta15 LONG) threshold:');
for (const newThresh of [500, 750, 1000, 1500, Infinity]) {
  // Signals that would PASS this looser threshold:
  const newPasses = gateA.filter(r => (r.delta15 ?? 0) < newThresh && !(r.gate.startsWith('B')));
  // But they still have to clear Gate B (delta5). For LONG: d5 <= -1000.
  const stillPass = newPasses.filter(r => (r.delta5 ?? 0) <= -DELTA5_THRESHOLD);
  if (stillPass.length || newThresh === 500) summary(stillPass, `  d15<${newThresh === Infinity ? '∞' : newThresh}`);
}

console.log('Loosen Gate B (delta5) threshold:');
for (const newThresh of [1000, 750, 500, 250, 0]) {
  // For each direction, allow signals with |d5| >= newThresh in the correct direction.
  const longPasses = gateBLong.filter(r => (r.delta5 ?? 0) <= -newThresh);
  const shortPasses = gateBShort.filter(r => (r.delta5 ?? 0) >= newThresh);
  const merged = [...longPasses, ...shortPasses];
  summary(merged, `  |d5|>=${newThresh}`);
}

// Detail: list the gate-A LONG silenced winners (where gate was wrong)
console.log('\n═══ Gate A (delta15) winners that were silenced ═══');
console.log('day              dir   score entry      d15      d5    outcome');
const gateAWinners = gateA.filter(r => r.outcome === 'W');
for (const r of gateAWinners.slice(-20)) {
  const et = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(r.ts));
  console.log(`${et}  ${r.dir.padEnd(5)} ${String(r.score).padStart(3)}   ${String(r.entry).padStart(9)}  ${String(r.delta15 ?? '-').padStart(6)}  ${String(r.delta5 ?? '-').padStart(6)}   ${r.outcome}`);
}

console.log('\n═══ Gate B (delta5) SHORT winners that were silenced (today\'s focus) ═══');
console.log('day              dir   score entry      d15      d5    outcome');
const gateBShortWinners = gateBShort.filter(r => r.outcome === 'W');
for (const r of gateBShortWinners.slice(-20)) {
  const et = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(r.ts));
  console.log(`${et}  ${r.dir.padEnd(5)} ${String(r.score).padStart(3)}   ${String(r.entry).padStart(9)}  ${String(r.delta15 ?? '-').padStart(6)}  ${String(r.delta5 ?? '-').padStart(6)}   ${r.outcome}`);
}
