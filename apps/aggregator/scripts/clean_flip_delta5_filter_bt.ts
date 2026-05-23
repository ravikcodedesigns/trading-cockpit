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
  SELECT id, ts, symbol, direction, score, payload
  FROM signals
  WHERE rule_id='clean-impulse' AND symbol='NQ'
  ORDER BY ts ASC
`).all() as any[];

type Row = {
  date: string; time: string; etm: number; direction: string; score: number;
  entry: number; stopDist: number;
  deltaT: number; delta5: number; delta15: number; deltaL3: number; compPos: number;
  maxGain: number; maxDD: number;
  outcome: 'W' | 'L' | 'O';
  filtered: boolean;
  filterReason: string;
};

const rows: Row[] = [];

for (const s of sigs) {
  const m = etMin(s.ts);
  if (m < 570 || m >= 960) continue;

  const p = JSON.parse(s.payload);
  const entry: number = p.entry ?? 0;
  if (!entry) continue;

  const delta5  = p.delta5  ?? 0;
  const delta15 = p.delta15 ?? 0;
  const dir = s.direction as string;

  // Proposed filter: when delta15 < -2500 for LONG (or > 2500 for SHORT),
  // require delta5 to also be < -2000 (or > 2000 for SHORT).
  let filtered = false;
  let filterReason = '';
  if (dir === 'long'  && delta15 < -2500 && delta5 > -2000) {
    filtered = true;
    filterReason = `delta15=${delta15} strong but delta5=${delta5} weak`;
  }
  if (dir === 'short' && delta15 > 2500  && delta5 < 2000) {
    filtered = true;
    filterReason = `delta15=${delta15} strong but delta5=${delta5} weak`;
  }

  const ticks = fwdQ.all(s.symbol, s.ts, s.ts + WINDOW_MS) as { price: number }[];
  let maxGain = 0, maxDD = 0, outcome: 'W' | 'L' | 'O' = 'O';
  const sign = dir === 'long' ? 1 : -1;
  for (const t of ticks) {
    const g = (t.price - entry) * sign;
    if (g > maxGain) maxGain = g;
    if (-g > maxDD)  maxDD = -g < 0 ? 0 : entry - t.price > 0 ? entry - t.price : t.price - entry;
    // correct maxDD
  }
  // redo maxDD correctly
  maxDD = 0;
  for (const t of ticks) {
    const dd = dir === 'long' ? entry - t.price : t.price - entry;
    if (dd > maxDD) maxDD = dd;
  }
  for (const t of ticks) {
    const g = (t.price - entry) * sign;
    if (outcome === 'O') {
      if (g >= TP)  { outcome = 'W'; break; }
      if (g <= -SL) { outcome = 'L'; break; }
    }
  }

  rows.push({
    date: etDate(s.ts), time: etStr(s.ts), etm: m,
    direction: dir, score: s.score, entry,
    stopDist: p.stopDist ?? 0,
    deltaT: p.deltaT ?? 0, delta5, delta15,
    deltaL3: p.deltaLast3 ?? 0,
    compPos: p.compPos ?? 0,
    maxGain, maxDD, outcome, filtered, filterReason,
  });
}

function pct(n: number, d: number) { return d ? `${(n/d*100).toFixed(0)}%` : '—'; }
function edge(w: number, l: number) {
  const t = w + l;
  return t ? `${((w * TP - l * SL) / t).toFixed(1)}pts/trade` : '—';
}

function print(label: string, subset: Row[]) {
  const W = subset.filter(r => r.outcome === 'W').length;
  const L = subset.filter(r => r.outcome === 'L').length;
  const O = subset.filter(r => r.outcome === 'O').length;
  console.log(`${label.padEnd(36)} N=${String(subset.length).padStart(3)}  W=${W} L=${L} O=${O}  WR=${pct(W,W+L).padStart(4)}  Edge=${edge(W,L)}`);
}

const kept     = rows.filter(r => !r.filtered);
const filtered = rows.filter(r => r.filtered);
const keptW    = kept.filter(r => r.outcome === 'W');
const keptL    = kept.filter(r => r.outcome === 'L');
const filtW    = filtered.filter(r => r.outcome === 'W');
const filtL    = filtered.filter(r => r.outcome === 'L');

console.log(`\n═══ CLEAN-FLIP NQ BOTH DIRECTIONS | SL=${SL} TP=${TP} | Filter: delta15 strong but delta5 weak ═══\n`);
print('BASELINE (all signals)',   rows);
print('AFTER FILTER (kept)',      kept);
print('  ↳ LONG kept',           kept.filter(r => r.direction === 'long'));
print('  ↳ SHORT kept',          kept.filter(r => r.direction === 'short'));
print('FILTERED OUT',            filtered);
print('  ↳ LONG filtered',       filtered.filter(r => r.direction === 'long'));
print('  ↳ SHORT filtered',      filtered.filter(r => r.direction === 'short'));

console.log(`\n── What the filter removes ──`);
console.log(`  Winners eliminated : ${filtW.length}`);
console.log(`  Losers  eliminated : ${filtL.length}`);
console.log(`  Net PnL saved      : ${(filtL.length * SL - filtW.length * TP).toFixed(0)}pts`);

console.log(`\n── Baseline vs filtered edge comparison ──`);
const bW = rows.filter(r => r.outcome === 'W').length;
const bL = rows.filter(r => r.outcome === 'L').length;
const bEdge = ((bW * TP - bL * SL) / (bW + bL)).toFixed(1);
const fW = keptW.length, fL = keptL.length;
const fEdge = (fW + fL) > 0 ? ((fW * TP - fL * SL) / (fW + fL)).toFixed(1) : '—';
console.log(`  Baseline : WR=${pct(bW,bW+bL)}  Edge=${bEdge}pts/trade`);
console.log(`  Filtered : WR=${pct(fW,fW+fL)}  Edge=${fEdge}pts/trade`);

console.log(`\n── Filtered-out signals detail ──`);
console.log(`${'Date'.padEnd(6)} ${'Time'.padEnd(6)} ${'Dir'.padEnd(6)} ${'d5'.padStart(7)} ${'d15'.padStart(8)} ${'cPos'.padStart(6)} ${'MxG'.padStart(6)} ${'MxDD'.padStart(6)}  Out  Reason`);
for (const r of filtered) {
  console.log(
    `${r.date.padEnd(6)} ${r.time.padEnd(6)} ${r.direction.padEnd(6)} ` +
    `${String(r.delta5).padStart(7)} ${String(r.delta15).padStart(8)} ` +
    `${r.compPos.toFixed(3).padStart(6)} ${r.maxGain.toFixed(1).padStart(6)} ${r.maxDD.toFixed(1).padStart(6)}  ${r.outcome}    ${r.filterReason}`
  );
}
