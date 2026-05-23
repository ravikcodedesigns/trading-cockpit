import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });

const signals = db.prepare(`
  SELECT id, ts, symbol, direction, score,
    json_extract(payload, '$.entry')    AS entry_price,
    json_extract(payload, '$.stopDist') AS stopDist,
    json_extract(payload, '$.cvd15')    AS cvd15,
    json_extract(payload, '$.spikeDelta') AS spikeDelta
  FROM signals
  WHERE rule_id = 'trap' AND direction = 'long'
  ORDER BY ts ASC
`).all() as any[];

console.log(`Total trap LONG signals: ${signals.length}`);
console.log(`Score breakdown: ${[100,90,85,80].map(s=>`${s}: ${signals.filter((x:any)=>x.score===s).length}`).join(', ')}\n`);

const fwdQuery = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`
);

function getETMin(ts: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts));
  return parseInt(p.find(x => x.type === 'hour')?.value ?? '0', 10) * 60 + parseInt(p.find(x => x.type === 'minute')?.value ?? '0', 10);
}
function getETDate(ts: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
function getDOW(ts: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(ts));
}

interface Result {
  id: number; sym: string; date: string; dow: string; etMin: number;
  score: number; entry: number; stopDist: number; cvd15: number;
  maxGain: number; maxDD: number; outcome: 'W' | 'L' | 'O';
}

const WIN_PTS = 80;
const SL = 50;
const WINDOW_MS = 120 * 60_000;
const results: Result[] = [];

for (const sig of signals) {
  const etMin = getETMin(sig.ts);
  if (etMin < 570 || etMin >= 960) continue;
  const entry: number = sig.entry_price;
  if (!entry) continue;

  const fwd = fwdQuery.all(sig.symbol, sig.ts, sig.ts + WINDOW_MS) as { price: number }[];

  let maxGain = 0, maxDD = 0, hitTP = false, tpIdx = fwd.length;
  for (let i = 0; i < fwd.length; i++) {
    if (fwd[i].price - entry >= WIN_PTS) { hitTP = true; tpIdx = i; break; }
  }
  for (let i = 0; i <= (hitTP ? tpIdx : fwd.length - 1); i++) {
    const dd = entry - fwd[i].price; if (dd > maxDD) maxDD = dd;
  }
  for (const t of fwd) {
    const g = t.price - entry; if (g > maxGain) maxGain = g;
  }

  let outcome: 'W' | 'L' | 'O' = 'O';
  for (const t of fwd) {
    const g = t.price - entry;
    if (g >= WIN_PTS) { outcome = 'W'; break; }
    if (g <= -SL)     { outcome = 'L'; break; }
  }

  results.push({
    id: sig.id, sym: sig.symbol, date: getETDate(sig.ts), dow: getDOW(sig.ts),
    etMin, score: sig.score, entry, stopDist: sig.stopDist, cvd15: sig.cvd15,
    maxGain, maxDD, outcome,
  });
}

console.log(`Analyzable (RTH): ${results.length}\n`);

function stats(r: Result[], label: string) {
  const w = r.filter(x => x.outcome === 'W');
  const l = r.filter(x => x.outcome === 'L');
  const o = r.filter(x => x.outcome === 'O');
  const t = w.length + l.length;
  const pnl = w.length * WIN_PTS - l.length * SL;
  const wr  = t > 0 ? (w.length / t * 100).toFixed(0) + '%' : '—';
  const edge = t > 0 ? (pnl / t).toFixed(1) : '—';
  console.log(`${label.padEnd(32)} N=${String(r.length).padStart(3)} W=${String(w.length).padStart(2)} L=${String(l.length).padStart(2)} O=${String(o.length).padStart(2)} | WR=${wr.padStart(4)} | PnL=${String(pnl).padStart(6)}pts | Edge=${String(edge).padStart(6)}pts/trade`);
}

console.log('=== OVERALL ===');
stats(results, 'All trap LONG');
console.log();

console.log('=== BY SCORE ===');
for (const s of [100, 90, 85, 80]) stats(results.filter(x => x.score === s), `Score ${s}`);
stats(results.filter(x => x.score >= 90), 'Score >= 90');
console.log();

console.log('=== BY TIME OF DAY ===');
stats(results.filter(x => x.etMin >= 570 && x.etMin < 594), '09:30-09:53 (open)');
stats(results.filter(x => x.etMin >= 594 && x.etMin < 630), '09:54-10:29');
stats(results.filter(x => x.etMin >= 630 && x.etMin < 690), '10:30-11:29');
stats(results.filter(x => x.etMin >= 690 && x.etMin < 780), '11:30-12:59');
stats(results.filter(x => x.etMin >= 780 && x.etMin < 870), '13:00-14:29');
stats(results.filter(x => x.etMin >= 870 && x.etMin < 960), '14:30-16:00');
console.log();

console.log('=== BY DAY OF WEEK ===');
for (const dow of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) stats(results.filter(x => x.dow === dow), dow);
console.log();

console.log('=== PER TRADING DAY ===');
const byDate = new Map<string, Result[]>();
for (const r of results) { const d = byDate.get(r.date) ?? []; d.push(r); byDate.set(r.date, d); }
for (const [date, r] of [...byDate.entries()].sort()) stats(r, date);
console.log();

console.log('=== ALL SIGNALS DETAIL ===');
console.log(`${'Date'.padEnd(6)} ${'DOW'.padEnd(4)} ${'Sym'.padEnd(3)} ${'Time'.padEnd(6)} ${'Scr'.padEnd(4)} ${'Entry'.padStart(8)} ${'StpDst'.padStart(7)} ${'CVD15'.padStart(7)} ${'MaxGain'.padStart(8)} ${'MaxDD'.padStart(7)}  Out`);
console.log('-'.repeat(80));
for (const r of results) {
  const hh = Math.floor(r.etMin / 60).toString().padStart(2, '0');
  const mm = (r.etMin % 60).toString().padStart(2, '0');
  console.log(`${r.date.padEnd(6)} ${r.dow.padEnd(4)} ${r.sym.padEnd(3)} ${(hh+':'+mm).padEnd(6)} ${String(r.score).padEnd(4)} ${r.entry.toFixed(2).padStart(8)} ${r.stopDist.toFixed(1).padStart(7)} ${String(r.cvd15).padStart(7)} ${('+'+r.maxGain.toFixed(1)).padStart(8)} ${('-'+r.maxDD.toFixed(1)).padStart(7)}  ${r.outcome}`);
}

db.close();
ticksDb.close();
