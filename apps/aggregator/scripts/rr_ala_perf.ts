// Quick historical perf for RR + ALA signals.
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

interface RR { id: number; ts: number; entry: number; stop: number; t1: number; t2: number; t3: number; lvlSrc: string; }

const rrRows = tdb.prepare(`
  SELECT id, ts, payload FROM signals WHERE rule_id='reject-resistance' ORDER BY ts
`).all() as Array<{id:number;ts:number;payload:string}>;

const rrSigs: RR[] = rrRows.map(r => {
  const p = JSON.parse(r.payload);
  // T1/T2/T3 prices from rationale (T1=X T2=Y T3=Z) since payload doesn't store them directly
  const m = (p.rationale as string).match(/T1=(\d+\.?\d*)\s+T2=(\d+\.?\d*)\s+T3=(\d+\.?\d*)/);
  return {
    id: r.id, ts: r.ts,
    entry: p.entry, stop: p.stopLevel,
    t1: m ? parseFloat(m[1]) : p.entry - 10,
    t2: m ? parseFloat(m[2]) : p.entry - 20,
    t3: m ? parseFloat(m[3]) : p.entry - 30,
    lvlSrc: p.levelSource ?? '?',
  };
});

const stmtTicks = xdb.prepare(`
  SELECT ts, price FROM trades WHERE symbol='NQ' AND ts > ? AND ts <= ?
  ORDER BY ts ASC, id ASC
`).raw(true);

function rthCloseMs(tsMs: number): number {
  const d = new Date(tsMs - 4*60*60_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20, 0, 0, 0);
}
function etTime(tsMs: number): string {
  const d = new Date(tsMs - 4*60*60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

console.log('═══════════════════════════════════════');
console.log('Strategy RR (Reject Resistance) — historical perf');
console.log('═══════════════════════════════════════\n');
console.log(`Signals fired: ${rrSigs.length}  (all SHORTS, all BACKFILLED historical)`);
console.log('Geometry: stop = level + 0.25;  T1/T2/T3 = entry − stopDist/2/3pt scaled\n');

// For each: walk ticks forward to RTH close. Track which targets hit + if stop hit first.
console.log('id  date              lvl   entry    stop     T1       T2       T3      maxAdv    maxFav    outcome');
console.log('--- ----------------  ----  -------  -------  -------  -------  ------  --------  --------  ----------');

let wT1 = 0, wT2 = 0, wT3 = 0, stops = 0, neither = 0;
let netT1 = 0, netT2 = 0, netT3 = 0;

for (const s of rrSigs) {
  const closeMs = rthCloseMs(s.ts);
  const iter = stmtTicks.iterate(s.ts, closeMs) as IterableIterator<[number, number]>;
  let firstStopTs = -1, t1Ts = -1, t2Ts = -1, t3Ts = -1;
  let minPx = Infinity;
  let maxPx = -Infinity;
  for (const [ts, px] of iter) {
    if (px > maxPx) maxPx = px;
    if (px < minPx) minPx = px;
    if (firstStopTs < 0 && px >= s.stop) firstStopTs = ts;
    if (t1Ts < 0 && px <= s.t1) t1Ts = ts;
    if (t2Ts < 0 && px <= s.t2) t2Ts = ts;
    if (t3Ts < 0 && px <= s.t3) t3Ts = ts;
    if (firstStopTs > 0 && t3Ts > 0) break;
  }
  if ((iter as any).return) (iter as any).return();

  // Stop hit before any T?
  const stopBeforeT1 = firstStopTs > 0 && (t1Ts < 0 || firstStopTs < t1Ts);
  const stopBeforeT2 = firstStopTs > 0 && (t2Ts < 0 || firstStopTs < t2Ts);
  const stopBeforeT3 = firstStopTs > 0 && (t3Ts < 0 || firstStopTs < t3Ts);

  const stopDist = s.stop - s.entry;
  const maxAdv = maxPx - s.entry;   // adverse (price up = bad for short)
  const maxFav = s.entry - minPx;   // favorable (price down = good for short)

  let outcome = '';
  let pnl = 0;
  if (t1Ts > 0 && !stopBeforeT1) { wT1++; outcome += 'T1✓'; netT1 += (s.entry - s.t1); pnl = s.entry - s.t1; }
  if (t2Ts > 0 && !stopBeforeT2) { wT2++; outcome += ' T2✓'; netT2 += (s.entry - s.t2); }
  if (t3Ts > 0 && !stopBeforeT3) { wT3++; outcome += ' T3✓'; netT3 += (s.entry - s.t3); }
  if (firstStopTs > 0) { stops++; outcome += ' STOP'; pnl = -stopDist; if (t1Ts < 0 || stopBeforeT1) netT1 += -stopDist; }
  if (!outcome) { neither++; outcome = 'no resolution'; }

  console.log(
    `${String(s.id).padStart(3)}  ${etTime(s.ts)}  ${s.lvlSrc.padEnd(4)}  ${s.entry.toFixed(2).padStart(7)}  ${s.stop.toFixed(2).padStart(7)}  ${s.t1.toFixed(2).padStart(7)}  ${s.t2.toFixed(2).padStart(7)}  ${s.t3.toFixed(2).padStart(6)}  ${maxAdv.toFixed(2).padStart(8)}  ${maxFav.toFixed(2).padStart(8)}  ${outcome}`
  );
}

console.log('\n─── Aggregate ───');
console.log(`T1 hits: ${wT1}/${rrSigs.length}  T2 hits: ${wT2}/${rrSigs.length}  T3 hits: ${wT3}/${rrSigs.length}`);
console.log(`Stops:   ${stops}/${rrSigs.length}`);
console.log(`No resolution by RTH close: ${neither}`);
console.log(`\nIf trading T1 only with full stop: net = ${netT1.toFixed(1)} pt across ${rrSigs.length} trades`);

// ALA check
console.log('\n\n═══════════════════════════════════════');
console.log('Strategy ALA (Absorption at Level) — historical perf');
console.log('═══════════════════════════════════════');
const alaRows = tdb.prepare(`SELECT COUNT(*) AS n FROM signals WHERE rule_id LIKE 'ala%'`).get() as {n:number};
console.log(`Signals fired: ${alaRows.n}`);
if (alaRows.n === 0) {
  console.log('No ALA signals in DB. Strategy was deployed but has not satisfied');
  console.log('all firing gates (cvdSession ≥ 4000 + level proximity + bar pattern)');
  console.log('in any historical session within tick coverage.');
}

tdb.close(); xdb.close();
