// PnL per silencing bucket for the 89 silenced NQ FLIPs.

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });

const TP = 80, SL_LONG = 55, SL_SHORT = 105, FWD_MS = 120 * 60_000, PV_NQ = 2;
const fwd = ticksDb.prepare(`SELECT price FROM trades WHERE symbol='NQ' AND ts > ? AND ts <= ? ORDER BY ts ASC`);

function outcome(entry: number, dir: 'long'|'short', startMs: number): { o: 'W'|'L'|'O'; pts: number } {
  const sl = dir === 'long' ? SL_LONG : SL_SHORT;
  const ticks = fwd.all(startMs, startMs + FWD_MS) as Array<{ price: number }>;
  for (const t of ticks) {
    const m = dir === 'long' ? t.price - entry : entry - t.price;
    if (m >=  TP) return { o: 'W', pts:  TP };
    if (m <= -sl) return { o: 'L', pts: -sl };
  }
  return { o: 'O', pts: 0 };
}

const rows = db.prepare(`
  SELECT s.id, s.ts, s.direction, s.score,
         json_extract(s.payload,'$.entry') AS entry,
         s.rs_filter_reason
  FROM signals s
  LEFT JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.rule_id='clean-impulse'
    AND s.symbol='NQ'
    AND json_extract(s.payload,'$.pattern')='FLIP'
    AND q.signal_id IS NULL
  ORDER BY s.ts ASC
`).all() as Array<{ id: number; ts: number; direction: 'long'|'short'; score: number; entry: number; rs_filter_reason: string|null }>;

function bucketOf(r: typeof rows[0]): string {
  if (r.rs_filter_reason === 'time-gate') return 'time-gate LONG';
  if (r.rs_filter_reason?.startsWith('SHORT blocked') && r.rs_filter_reason.includes('DD Band')) return 'DD-band SHORT';
  return `H-gate ${r.direction.toUpperCase()}`;
}

const buckets = new Map<string, Array<{ id: number; ts: number; dir: 'long'|'short'; score: number; entry: number; o: 'W'|'L'|'O'; pts: number }>>();
for (const r of rows) {
  const b = bucketOf(r);
  const out = outcome(r.entry, r.direction, r.ts);
  if (!buckets.has(b)) buckets.set(b, []);
  buckets.get(b)!.push({ id: r.id, ts: r.ts, dir: r.direction, score: r.score, entry: r.entry, o: out.o, pts: out.pts });
}

console.log('═══ Silenced NQ FLIPs by bucket — PnL summary ═══');
console.log(`${'bucket'.padEnd(20)}  n   W   L   O   WR    EV/sig    net pts    $`);
let totN = 0, totPts = 0, totW = 0, totL = 0;
for (const [b, rs] of [...buckets.entries()].sort((a,b) => b[1].length - a[1].length)) {
  const w = rs.filter(r => r.o === 'W').length;
  const l = rs.filter(r => r.o === 'L').length;
  const o = rs.filter(r => r.o === 'O').length;
  const wr = (w+l) ? (w/(w+l)*100).toFixed(0) : '--';
  const pts = rs.reduce((s, r) => s + r.pts, 0);
  const ev = (pts/rs.length).toFixed(1);
  const $ = pts * PV_NQ;
  console.log(`${b.padEnd(20)}  ${String(rs.length).padStart(2)}  ${String(w).padStart(2)}  ${String(l).padStart(2)}  ${String(o).padStart(2)}  ${String(wr).padStart(3)}%  ${ev.padStart(7)}pts  ${pts.toFixed(0).padStart(7)}pts  ${$>=0?'+$':'-$'}${Math.abs($).toFixed(0)}`);
  totN += rs.length; totPts += pts; totW += w; totL += l;
}
console.log(`${'TOTAL'.padEnd(20)}  ${String(totN).padStart(2)}  ${String(totW).padStart(2)}  ${String(totL).padStart(2)}      ${String((totW/(totW+totL)*100).toFixed(0)).padStart(3)}%             ${totPts.toFixed(0).padStart(7)}pts  ${totPts*PV_NQ>=0?'+$':'-$'}${Math.abs(totPts*PV_NQ).toFixed(0)}`);

// Detail: DD-band shorts (all 5)
console.log('\n═══ DD-band SHORT bucket (RS hard-filter "irrational territory") ═══');
for (const r of buckets.get('DD-band SHORT') ?? []) {
  const et = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(r.ts));
  console.log(`  ${et}  short  score=${r.score}  entry=${r.entry}  → ${r.o} ${r.pts>=0?'+':''}${r.pts}pts`);
}

// Detail: time-gate LONGs — split by ET hour
console.log('\n═══ time-gate LONG bucket — by ET hour ═══');
const tgLong = buckets.get('time-gate LONG') ?? [];
const byHour = new Map<string, typeof tgLong>();
for (const r of tgLong) {
  const et = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hour12:false}).format(new Date(r.ts));
  if (!byHour.has(et)) byHour.set(et, []);
  byHour.get(et)!.push(r);
}
for (const [h, rs] of [...byHour.entries()].sort()) {
  const w = rs.filter(r => r.o === 'W').length;
  const l = rs.filter(r => r.o === 'L').length;
  const wr = (w+l) ? (w/(w+l)*100).toFixed(0) : '--';
  const pts = rs.reduce((s, r) => s + r.pts, 0);
  console.log(`  ${h}:xx  n=${String(rs.length).padStart(2)}  W=${String(w).padStart(2)} L=${String(l).padStart(2)}  WR=${wr.padStart(3)}%  net=${pts.toFixed(0).padStart(5)}pts  $=${pts*PV_NQ>=0?'+':'-'}$${Math.abs(pts*PV_NQ).toFixed(0)}`);
}
