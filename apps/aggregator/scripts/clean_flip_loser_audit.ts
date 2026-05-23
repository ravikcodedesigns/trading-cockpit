import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db      = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const SL = 55;
const TP = 80;
const WINDOW_MS = 120 * 60_000;

const fwdQ = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`
);

function etMin(ts: number) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ts));
  return parseInt(p.find(x => x.type === 'hour')!.value, 10) * 60
       + parseInt(p.find(x => x.type === 'minute')!.value, 10);
}
function etStr(ts: number) {
  const m = etMin(ts);
  return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
}
function etDate(ts: number) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: '2-digit', day: '2-digit',
  }).format(new Date(ts));
}

const sigs = db.prepare(`
  SELECT id, ts, direction, score, payload
  FROM signals
  WHERE rule_id='clean-impulse' AND symbol='NQ' AND direction='long'
  ORDER BY ts ASC
`).all() as any[];

type Row = {
  id: number; ts: number; date: string; time: string; etm: number;
  score: number; entry: number; stopDist: number;
  deltaT: number; delta5: number; delta15: number; deltaL3: number; compPos: number;
  maxGain: number; maxDD: number;
  outcome: 'W' | 'L' | 'O';
};

const rows: Row[] = [];

for (const s of sigs) {
  const m = etMin(s.ts);
  if (m < 570 || m >= 960) continue;

  const p = JSON.parse(s.payload);
  const entry: number = p.entry ?? 0;
  if (!entry) continue;

  const ticks = fwdQ.all(s.symbol ?? 'NQ', s.ts, s.ts + WINDOW_MS) as { price: number }[];

  let maxGain = 0, maxDD = 0, outcome: 'W' | 'L' | 'O' = 'O';
  for (const t of ticks) {
    const g = t.price - entry;
    if (g > maxGain) maxGain = g;
    if (entry - t.price > maxDD) maxDD = entry - t.price;
    if (outcome === 'O') {
      if (g >= TP)  { outcome = 'W'; break; }
      if (g <= -SL) { outcome = 'L'; break; }
    }
  }

  rows.push({
    id: s.id, ts: s.ts, date: etDate(s.ts), time: etStr(s.ts), etm: m,
    score: s.score, entry,
    stopDist: p.stopDist ?? 0,
    deltaT:   p.deltaT  ?? 0,
    delta5:   p.delta5  ?? 0,
    delta15:  p.delta15 ?? 0,
    deltaL3:  p.deltaLast3 ?? 0,
    compPos:  p.compPos ?? 0,
    maxGain, maxDD, outcome,
  });
}

const W = rows.filter(r => r.outcome === 'W');
const L = rows.filter(r => r.outcome === 'L');
const O = rows.filter(r => r.outcome === 'O');

function avg(arr: number[]) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function pct(n: number, d: number) { return d ? (n/d*100).toFixed(0)+'%' : '—'; }

console.log(`\n═══ CLEAN-FLIP LONG | NQ | SL=${SL} TP=${TP} | RTH only ═══`);
console.log(`Total: ${rows.length}  W:${W.length} L:${L.length} O:${O.length}  WR: ${pct(W.length, W.length+L.length)}\n`);

// ── Factor comparison ──────────────────────────────────────────────────────
console.log('─── Factor averages: Winners vs Losers ───');
console.log(`${'Factor'.padEnd(14)} ${'Winners avg'.padStart(12)} ${'Losers avg'.padStart(12)}`);
const fields: [string, keyof Row][] = [
  ['deltaT',    'deltaT'],
  ['delta5',    'delta5'],
  ['delta15',   'delta15'],
  ['deltaLast3','deltaL3'],
  ['compPos',   'compPos'],
  ['stopDist',  'stopDist'],
  ['score',     'score'],
];
for (const [label, key] of fields) {
  const wa = avg(W.map(r => r[key] as number));
  const la = avg(L.map(r => r[key] as number));
  console.log(`${label.padEnd(14)} ${wa.toFixed(1).padStart(12)} ${la.toFixed(1).padStart(12)}`);
}

// ── compPos distribution ───────────────────────────────────────────────────
console.log('\n─── compPos buckets ───');
const buckets = [
  ['compPos < 0',        (r: Row) => r.compPos < 0],
  ['compPos 0–0.20',     (r: Row) => r.compPos >= 0    && r.compPos < 0.20],
  ['compPos 0.20–0.50',  (r: Row) => r.compPos >= 0.20 && r.compPos < 0.50],
  ['compPos >= 0.50',    (r: Row) => r.compPos >= 0.50],
] as [string, (r: Row) => boolean][];

for (const [label, fn] of buckets) {
  const sub = rows.filter(fn);
  const sw = sub.filter(r => r.outcome==='W').length;
  const sl = sub.filter(r => r.outcome==='L').length;
  console.log(`${label.padEnd(22)} N=${String(sub.length).padStart(3)}  WR=${pct(sw,sw+sl).padStart(5)}  W=${sw} L=${sl}`);
}

// ── delta15 distribution ───────────────────────────────────────────────────
console.log('\n─── delta15 buckets (short-term pressure context) ───');
const d15buckets = [
  ['delta15 < -3000',       (r: Row) => r.delta15 < -3000],
  ['delta15 -3000 to -1000',(r: Row) => r.delta15 >= -3000 && r.delta15 < -1000],
  ['delta15 -1000 to 0',    (r: Row) => r.delta15 >= -1000 && r.delta15 < 0],
  ['delta15 >= 0',          (r: Row) => r.delta15 >= 0],
] as [string, (r: Row) => boolean][];

for (const [label, fn] of d15buckets) {
  const sub = rows.filter(fn);
  const sw = sub.filter(r => r.outcome==='W').length;
  const sl = sub.filter(r => r.outcome==='L').length;
  console.log(`${label.padEnd(28)} N=${String(sub.length).padStart(3)}  WR=${pct(sw,sw+sl).padStart(5)}  W=${sw} L=${sl}`);
}

// ── stopDist distribution ─────────────────────────────────────────────────
console.log('\n─── stopDist buckets ───');
const sdBuckets = [
  ['stopDist <= 20',      (r: Row) => r.stopDist <= 20],
  ['stopDist 20–30',      (r: Row) => r.stopDist > 20  && r.stopDist <= 30],
  ['stopDist 30–40',      (r: Row) => r.stopDist > 30  && r.stopDist <= 40],
  ['stopDist > 40',       (r: Row) => r.stopDist > 40],
] as [string, (r: Row) => boolean][];

for (const [label, fn] of sdBuckets) {
  const sub = rows.filter(fn);
  const sw = sub.filter(r => r.outcome==='W').length;
  const sl = sub.filter(r => r.outcome==='L').length;
  console.log(`${label.padEnd(22)} N=${String(sub.length).padStart(3)}  WR=${pct(sw,sw+sl).padStart(5)}  W=${sw} L=${sl}`);
}

// ── Time of day ──────────────────────────────────────────────────────────
console.log('\n─── Time of day ───');
const timeBuckets = [
  ['09:30–09:53', (r: Row) => r.etm >= 570 && r.etm < 594],
  ['09:54–10:29', (r: Row) => r.etm >= 594 && r.etm < 630],
  ['10:30–11:29', (r: Row) => r.etm >= 630 && r.etm < 690],
  ['11:30–12:59', (r: Row) => r.etm >= 690 && r.etm < 780],
  ['13:00–14:29', (r: Row) => r.etm >= 780 && r.etm < 870],
  ['14:30–16:00', (r: Row) => r.etm >= 870 && r.etm < 960],
] as [string, (r: Row) => boolean][];

for (const [label, fn] of timeBuckets) {
  const sub = rows.filter(fn);
  const sw = sub.filter(r => r.outcome==='W').length;
  const sl = sub.filter(r => r.outcome==='L').length;
  console.log(`${label.padEnd(22)} N=${String(sub.length).padStart(3)}  WR=${pct(sw,sw+sl).padStart(5)}  W=${sw} L=${sl}`);
}

// ── Spotlight: today's 10:08 signal vs all losers ────────────────────────
console.log('\n─── TODAY 10:08 signal vs all Losers ───');
const loser1008ts = 1779458880000;
const r1008 = rows.find(r => r.ts === loser1008ts);
if (r1008) {
  console.log(`\n10:08 signal:`);
  console.log(`  entry=${r1008.entry}  stopDist=${r1008.stopDist}  compPos=${r1008.compPos.toFixed(3)}`);
  console.log(`  deltaT=${r1008.deltaT}  delta5=${r1008.delta5}  delta15=${r1008.delta15}  deltaL3=${r1008.deltaL3}`);
  console.log(`  maxGain=${r1008.maxGain.toFixed(1)}  maxDD=${r1008.maxDD.toFixed(1)}  outcome=${r1008.outcome}`);
}

console.log(`\nAll ${L.length} Losers:`);
console.log(`${'Date'.padEnd(6)} ${'Time'.padEnd(6)} ${'Scr'.padEnd(4)} ${'Entry'.padStart(8)} ${'StpD'.padStart(5)} ${'cPos'.padStart(6)} ${'dT'.padStart(6)} ${'d5'.padStart(7)} ${'d15'.padStart(8)} ${'dL3'.padStart(7)} ${'MxG'.padStart(6)} ${'MxDD'.padStart(6)}`);
for (const r of L) {
  console.log(
    `${r.date.padEnd(6)} ${r.time.padEnd(6)} ${String(r.score).padEnd(4)} ${r.entry.toFixed(2).padStart(8)} ` +
    `${r.stopDist.toFixed(1).padStart(5)} ${r.compPos.toFixed(3).padStart(6)} ` +
    `${String(r.deltaT).padStart(6)} ${String(r.delta5).padStart(7)} ${String(r.delta15).padStart(8)} ${String(r.deltaL3).padStart(7)} ` +
    `${r.maxGain.toFixed(1).padStart(6)} ${r.maxDD.toFixed(1).padStart(6)}`
  );
}

console.log(`\nAll ${W.length} Winners (factors):`);
console.log(`${'Date'.padEnd(6)} ${'Time'.padEnd(6)} ${'Scr'.padEnd(4)} ${'Entry'.padStart(8)} ${'StpD'.padStart(5)} ${'cPos'.padStart(6)} ${'dT'.padStart(6)} ${'d5'.padStart(7)} ${'d15'.padStart(8)} ${'dL3'.padStart(7)}`);
for (const r of W) {
  console.log(
    `${r.date.padEnd(6)} ${r.time.padEnd(6)} ${String(r.score).padEnd(4)} ${r.entry.toFixed(2).padStart(8)} ` +
    `${r.stopDist.toFixed(1).padStart(5)} ${r.compPos.toFixed(3).padStart(6)} ` +
    `${String(r.deltaT).padStart(6)} ${String(r.delta5).padStart(7)} ${String(r.delta15).padStart(8)} ${String(r.deltaL3).padStart(7)}`
  );
}

db.close();
ticksDb.close();
