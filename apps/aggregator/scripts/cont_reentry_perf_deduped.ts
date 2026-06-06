// cont-reentry perf, deduplicated + optional score gate.
// Usage:
//   pnpm exec tsx scripts/cont_reentry_perf_deduped.ts            # all scores
//   pnpm exec tsx scripts/cont_reentry_perf_deduped.ts --score 90 # score ≥ 90 only

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });

const TP = 80, SL = 70;
const FWD_MS = 120 * 60_000;
const PV_NQ = 2;

const args = process.argv.slice(2);
const scoreIdx = args.indexOf('--score');
const SCORE_MIN = scoreIdx >= 0 ? Number(args[scoreIdx + 1]) : 0;

const rows = db.prepare(`
  SELECT MIN(id) AS id, ts, symbol, direction, score,
         json_extract(payload,'$.entry') AS entry
  FROM signals
  WHERE rule_id='cont-reentry'
    AND score >= ?
  GROUP BY ts, symbol, direction, score, entry
  ORDER BY ts ASC
`).all(SCORE_MIN) as Array<{ id: number; ts: number; symbol: string; direction: 'long'|'short'; score: number; entry: number }>;

const fwd = ticksDb.prepare(`SELECT price FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`);

interface Result { ts: number; sym: string; dir: 'long'|'short'; score: number; entry: number; outcome: 'W'|'L'|'O'; pts: number; }
const results: Result[] = [];

for (const s of rows) {
  if (!s.entry) continue;
  const ticks = fwd.all(s.symbol, s.ts, s.ts + FWD_MS) as Array<{ price: number }>;
  let outcome: 'W'|'L'|'O' = 'O', pts = 0;
  for (const t of ticks) {
    const m = s.direction === 'long' ? t.price - s.entry : s.entry - t.price;
    if (m >=  TP) { outcome = 'W'; pts =  TP; break; }
    if (m <= -SL) { outcome = 'L'; pts = -SL; break; }
  }
  if (outcome === 'O' && ticks.length) {
    const last = ticks[ticks.length-1]!.price;
    const m = s.direction === 'long' ? last - s.entry : s.entry - last;
    pts = m;
    outcome = m > 0 ? 'W' : m < 0 ? 'L' : 'O';
  }
  results.push({ ts: s.ts, sym: s.symbol, dir: s.direction, score: s.score, entry: s.entry, outcome, pts });
}

function summary(rs: Result[], label: string): void {
  const w = rs.filter(r => r.outcome === 'W').length;
  const l = rs.filter(r => r.outcome === 'L').length;
  const o = rs.filter(r => r.outcome === 'O').length;
  const wr = (w+l) ? (w/(w+l)*100).toFixed(1) : '--';
  const pts = rs.reduce((s, r) => s + r.pts, 0);
  const $ = pts * PV_NQ;
  const ev = rs.length ? (pts/rs.length).toFixed(2) : '0';
  console.log(`${label.padEnd(20)}  n=${String(rs.length).padStart(3)}  W=${String(w).padStart(3)}  L=${String(l).padStart(3)}  O=${String(o).padStart(2)}  WR=${String(wr).padStart(5)}%  EV=${String(ev).padStart(6)}pts  net=${pts.toFixed(0).padStart(5)}pts  $=${$>=0?'+$':'-$'}${Math.abs($).toFixed(0)}`);
}

console.log(`cont-reentry DEDUPED${SCORE_MIN ? ` (score >= ${SCORE_MIN})` : ''} signals: ${results.length}\n`);
console.log('═══ Headline ═══');
summary(results, 'ALL');
summary(results.filter(r => r.dir === 'long'),  '  LONG');
summary(results.filter(r => r.dir === 'short'), '  SHORT');

console.log('\n═══ By score band ═══');
for (const band of [[60,79],[80,89],[90,99]]) {
  const lo = band[0]!, hi = band[1]!;
  const rs = results.filter(r => r.score >= lo && r.score <= hi);
  if (rs.length) summary(rs, `score ${lo}-${hi}`);
}

console.log('\n═══ By day ═══');
const byDay = new Map<string, Result[]>();
for (const r of results) {
  const day = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(r.ts));
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day)!.push(r);
}
for (const [day, rs] of [...byDay.entries()].sort()) summary(rs, day);

console.log('\n═══ All signals (chronological) ═══');
console.log('day              dir   score entry      outcome  pts');
for (const r of results) {
  const et = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(r.ts));
  console.log(`${et}  ${r.dir.padEnd(5)} ${String(r.score).padStart(3)}   ${String(r.entry).padStart(9)}  ${r.outcome.padEnd(2)} ${(r.pts>=0?'+':'')}${r.pts.toFixed(1).padStart(6)}`);
}
