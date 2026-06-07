// Combined V3-OPEN performance: FLIPs + cont-reentry (score ≥ 90 deduped).
//
// FLIPs go through the full V3 gate chain (qualified + CVD + cooldown).
// Cont-reentry would also pass through V3 if it weren't currently in
// forceShadowRules — so we hypothetically include the score≥90 deduped subset
// (the "tier we'd promote" subset).
//
// Both cohorts are evaluated independently (no inter-strategy cooldown)
// because the user's question is "what's the headline upside if I took every
// V3-quality signal across rules?"

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db      = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'),  { readonly: true });

const PV_NQ = 2;
const FLIP_TP = 80;
const FLIP_SL_LONG  = 55;
const FLIP_SL_SHORT = 105;
const CONT_TP = 80;
const CONT_SL = 70;
const FWD_MS = 120 * 60_000;
const CVD_LONG_FLOOR  = -3000;
const CVD_SHORT_FLOOR =  3000;

// ─── CVD lookup (RTH-anchored) ──────────────────────────────────────
const ET_OFFSET_MS = 4 * 60 * 60_000;
function etDateOf(tsMs: number): string {
  const d = new Date(tsMs - ET_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function rthOpenMs(etDate: string): number {
  const [y,m,d] = etDate.split('-').map(Number) as [number,number,number];
  return Date.UTC(y, m-1, d, 13, 30);
}
const dayCvd = new Map<string, { ts: number[]; cvd: number[] }>();
function ensureDayCvd(etDate: string): void {
  if (dayCvd.has(etDate)) return;
  const openMs = rthOpenMs(etDate);
  const ticks = ticksDb.prepare(`
    SELECT ts, size, is_bid_aggressor FROM trades
    WHERE symbol='NQ' AND ts >= ? AND ts < ?
    ORDER BY ts ASC
  `).all(openMs, openMs + 7 * 3600_000) as Array<{ts:number;size:number;is_bid_aggressor:number}>;
  const arrTs: number[] = [], arrCvd: number[] = [];
  let cvd = 0;
  for (const t of ticks) {
    cvd += t.is_bid_aggressor === 1 ? t.size : -t.size;
    arrTs.push(t.ts);
    arrCvd.push(cvd);
  }
  dayCvd.set(etDate, { ts: arrTs, cvd: arrCvd });
}
function cvdAt(tsMs: number): number {
  const etDate = etDateOf(tsMs);
  ensureDayCvd(etDate);
  const { ts, cvd } = dayCvd.get(etDate)!;
  if (!ts.length || tsMs < ts[0]!) return 0;
  let lo = 0, hi = ts.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! <= tsMs) { ans = mid; lo = mid + 1; }
    else                  { hi = mid - 1; }
  }
  return ans < 0 ? 0 : cvd[ans]!;
}

// ─── Tick walker for TP/SL outcome ──────────────────────────────────
const fwdStmt = ticksDb.prepare(`
  SELECT price FROM trades WHERE symbol='NQ' AND ts > ? AND ts <= ? ORDER BY ts ASC
`);
function simulate(entry: number, dir: 'long'|'short', startMs: number, tp: number, slLong: number, slShort: number): { o: 'W'|'L'|'O'; pts: number } {
  const sl = dir === 'long' ? slLong : slShort;
  const ticks = fwdStmt.all(startMs, startMs + FWD_MS) as Array<{ price: number }>;
  for (const t of ticks) {
    const m = dir === 'long' ? t.price - entry : entry - t.price;
    if (m >=  tp)  return { o: 'W', pts:  tp };
    if (m <= -sl)  return { o: 'L', pts: -sl };
  }
  if (!ticks.length) return { o: 'O', pts: 0 };
  const last = ticks[ticks.length-1]!.price;
  const m = dir === 'long' ? last - entry : entry - last;
  return { o: m>0?'W':m<0?'L':'O', pts: m };
}

interface Trade {
  cohort: 'FLIP' | 'CONT';
  ts: number; sym: string; dir: 'long'|'short'; score: number;
  outcome: 'W'|'L'|'O'; pts: number;
}
const trades: Trade[] = [];

// ─── FLIP V3-OPEN (qualified + CVD passes, NQ only) ─────────────────
const flipRows = db.prepare(`
  SELECT s.id, s.ts, s.symbol, s.direction, s.score,
         json_extract(s.payload,'$.entry') AS entry,
         CASE WHEN q.signal_id IS NOT NULL THEN 1 ELSE 0 END AS qualified
  FROM signals s
  LEFT JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.rule_id='clean-impulse'
    AND json_extract(s.payload,'$.pattern')='FLIP'
    AND s.symbol='NQ'
  ORDER BY s.ts ASC
`).all() as Array<{ id:number; ts:number; symbol:string; direction:'long'|'short'; score:number; entry:number; qualified:number }>;

for (const f of flipRows) {
  if (!f.entry || !f.qualified) continue;
  const cvd = cvdAt(f.ts);
  if (f.direction === 'long'  && cvd <= CVD_LONG_FLOOR)  continue;
  if (f.direction === 'short' && cvd >= CVD_SHORT_FLOOR) continue;
  const r = simulate(f.entry, f.direction, f.ts, FLIP_TP, FLIP_SL_LONG, FLIP_SL_SHORT);
  trades.push({ cohort: 'FLIP', ts: f.ts, sym: f.symbol, dir: f.direction, score: f.score, outcome: r.o, pts: r.pts });
}

// ─── CONT V3-OPEN proxy (score ≥ 90 deduped, since cont is force-shadow today)
const contRows = db.prepare(`
  SELECT MIN(id) AS id, ts, symbol, direction, score,
         json_extract(payload,'$.entry') AS entry
  FROM signals
  WHERE rule_id='cont-reentry' AND symbol='NQ' AND score >= 90
  GROUP BY ts, symbol, direction, score, entry
  ORDER BY ts ASC
`).all() as Array<{ id:number; ts:number; symbol:string; direction:'long'|'short'; score:number; entry:number }>;

for (const c of contRows) {
  if (!c.entry) continue;
  const r = simulate(c.entry, c.direction, c.ts, CONT_TP, CONT_SL, CONT_SL);
  trades.push({ cohort: 'CONT', ts: c.ts, sym: c.symbol, dir: c.direction, score: c.score, outcome: r.o, pts: r.pts });
}

// ─── Report ─────────────────────────────────────────────────────────
function summary(rs: Trade[], label: string): void {
  const w = rs.filter(r => r.outcome === 'W').length;
  const l = rs.filter(r => r.outcome === 'L').length;
  const o = rs.filter(r => r.outcome === 'O').length;
  const wr = (w+l) ? (w/(w+l)*100).toFixed(1) : '--';
  const pts = rs.reduce((s, r) => s + r.pts, 0);
  const $ = pts * PV_NQ;
  const ev = rs.length ? (pts/rs.length).toFixed(2) : '0';
  console.log(`${label.padEnd(28)}  n=${String(rs.length).padStart(3)}  W=${String(w).padStart(3)}  L=${String(l).padStart(3)}  O=${String(o).padStart(2)}  WR=${String(wr).padStart(5)}%  EV=${String(ev).padStart(7)}pts  net=${pts.toFixed(0).padStart(6)}pts  $=${$>=0?'+$':'-$'}${Math.abs($).toFixed(0)}`);
}

console.log('═══ V3-OPEN Combined: FLIP + CONT (NQ, inception → today) ═══');
console.log('FLIP: qualified + CVD-floor passes (TP=80, SL=55L/105S)');
console.log('CONT: score≥90 deduped — hypothetical (CONT is force-shadow today, TP=80, SL=70)\n');

console.log('═══ Headline ═══');
summary(trades, 'ALL (FLIP + CONT)');
summary(trades.filter(t => t.cohort === 'FLIP'), '  FLIP only');
summary(trades.filter(t => t.cohort === 'CONT'), '  CONT only');

console.log('\n═══ By direction ═══');
summary(trades.filter(t => t.dir === 'long'),  'LONG total');
summary(trades.filter(t => t.dir === 'short'), 'SHORT total');
summary(trades.filter(t => t.cohort === 'FLIP' && t.dir === 'long'),  '  FLIP long');
summary(trades.filter(t => t.cohort === 'FLIP' && t.dir === 'short'), '  FLIP short');
summary(trades.filter(t => t.cohort === 'CONT' && t.dir === 'long'),  '  CONT long');
summary(trades.filter(t => t.cohort === 'CONT' && t.dir === 'short'), '  CONT short');

console.log('\n═══ By month ═══');
const byMonth = new Map<string, Trade[]>();
for (const t of trades) {
  const day = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(t.ts));
  const mo  = day.slice(0,7);
  if (!byMonth.has(mo)) byMonth.set(mo, []);
  byMonth.get(mo)!.push(t);
}
for (const [mo, rs] of [...byMonth.entries()].sort()) summary(rs, mo);

console.log('\n═══ By day (combined) — last 10 trading days ═══');
const byDay = new Map<string, Trade[]>();
for (const t of trades) {
  const day = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(t.ts));
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day)!.push(t);
}
const recent = [...byDay.entries()].sort().slice(-10);
for (const [day, rs] of recent) summary(rs, day);
