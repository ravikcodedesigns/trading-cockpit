/**
 * rr_cvd_analysis.ts — recompute each BSR_short_locked (RR) trigger and
 * attach session CVD at signal time. Show WR by CVD bucket.
 *
 * Hypothesis: RR works on seller-dominant sessions (low or negative CVD at
 * signal time). Buyer-dominant sessions (positive CVD) should produce more
 * RR losses because the upward bias overpowers the local breakdown.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const HORIZON_MS = 10 * 60_000;
const MFE_PTS    = 30;
const MAE_PTS    = 10;

const DATES = [
  '2026-05-05','2026-05-06','2026-05-08','2026-05-11','2026-05-12',
  '2026-05-13','2026-05-14','2026-05-15','2026-05-18','2026-05-19',
  '2026-05-20','2026-05-21','2026-05-22','2026-05-26','2026-05-27',
];

const RTH_OPEN_MIN = 9 * 60 + 30;
const RTH_END_MIN  = 15 * 60 + 55;

type Trade = { ts: number; price: number; size: number; isBidAgg: 0|1 };
type Bar = {
  minStartTs: number;
  open: number; high: number; low: number; close: number;
  vol: number; delta: number;
};

type LevelSource = 'PDH'|'PDL'|'PMH'|'PML'|'WkH'|'WkL'|'ORH'|'ORL'|'ONL';
type Level = { source: LevelSource; price: number };

function etMin(tsMs: number): number {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function etHHMM(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

function loadTrades(db: Database.Database, dateStr: string): Trade[] {
  const startTs = Date.parse(`${dateStr}T04:00:00-04:00`);
  const endTs   = Date.parse(`${dateStr}T16:30:00-04:00`);
  return db.prepare(
    `SELECT ts, price, size, is_bid_aggressor AS isBidAgg FROM trades
     WHERE symbol='NQ' AND ts >= ? AND ts < ? ORDER BY ts ASC, id ASC`
  ).all(startTs, endTs) as Trade[];
}

function buildBars(trades: Trade[]): Bar[] {
  const bars: Bar[] = [];
  let cur: Bar | null = null;
  for (const t of trades) {
    const bk = Math.floor(t.ts / 60_000) * 60_000;
    if (!cur || cur.minStartTs !== bk) {
      if (cur) bars.push(cur);
      cur = { minStartTs: bk, open: t.price, high: t.price, low: t.price, close: t.price, vol: 0, delta: 0 };
    }
    if (t.price > cur.high) cur.high = t.price;
    if (t.price < cur.low)  cur.low  = t.price;
    cur.close = t.price;
    cur.vol += t.size;
    if (t.isBidAgg === 1) cur.delta += t.size;
    else                  cur.delta -= t.size;
  }
  if (cur) bars.push(cur);
  return bars;
}

// ─── Levels ─────────────────────────────────────────────────────────────────

function prevTradingDays(date: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${date}T12:00:00Z`);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function queryHighLow(db: Database.Database, date: string, from: string, to: string): { hi: number; lo: number } | null {
  const startTs = Date.parse(`${date}T${from}-04:00`);
  const endTs   = Date.parse(`${date}T${to}-04:00`);
  const row = db.prepare(
    `SELECT MAX(price) hi, MIN(price) lo FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?`
  ).get(startTs, endTs) as { hi: number; lo: number } | undefined;
  if (!row || row.hi == null || row.lo == null) return null;
  return row;
}

function overnightHL(db: Database.Database, prevDate: string, today: string): { hi: number; lo: number } | null {
  const startTs = Date.parse(`${prevDate}T16:00:00-04:00`);
  const endTs   = Date.parse(`${today}T09:30:00-04:00`);
  const row = db.prepare(
    `SELECT MAX(price) hi, MIN(price) lo FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?`
  ).get(startTs, endTs) as { hi: number; lo: number } | undefined;
  if (!row || row.hi == null || row.lo == null) return null;
  return row;
}

function computeLevels(db: Database.Database, dateStr: string, bars: Bar[]): Level[] {
  const out: Level[] = [];
  const prev1 = prevTradingDays(dateStr, 1)[0]!;
  const pd = queryHighLow(db, prev1, '09:30', '16:00');
  if (pd) { out.push({ source: 'PDL', price: pd.lo }); out.push({ source: 'PDH', price: pd.hi }); }
  const pm = queryHighLow(db, dateStr, '04:00', '09:30');
  if (pm) { out.push({ source: 'PML', price: pm.lo }); out.push({ source: 'PMH', price: pm.hi }); }
  const on = overnightHL(db, prev1, dateStr);
  if (on) { out.push({ source: 'ONL', price: on.lo }); }
  // Weekly low (past 5 RTH sessions rolling)
  let wkLo = Infinity, anyWk = false;
  for (const d of prevTradingDays(dateStr, 5)) {
    const r = queryHighLow(db, d, '09:30', '16:00');
    if (r) { if (r.lo < wkLo) wkLo = r.lo; anyWk = true; }
  }
  if (anyWk) out.push({ source: 'WkL', price: wkLo });
  // Opening range low (09:30-10:00)
  let orLo = Infinity, orAny = false;
  for (const b of bars) {
    const m = etMin(b.minStartTs);
    if (m >= 9*60+30 && m < 10*60) {
      if (b.low < orLo) orLo = b.low;
      orAny = true;
    }
  }
  if (orAny) out.push({ source: 'ORL', price: orLo });
  return out;
}

// ─── BSR_short_locked detector (same as live RR) ────────────────────────────

interface Trigger {
  date: string; barTs: number;
  level: LevelSource; levelPrice: number;
  close: number; range: number; body: number; bodyPct: number;
  upperWick: number; closeInRangePct: number;
  delta: number; vol: number;
  prev15Net: number;
  cvdSession: number;
  result: 'WIN' | 'LOSS' | 'TIMEOUT';
  maxGain: number; maxDd: number;
}

function detectTriggers(date: string, bars: Bar[], levels: Level[], trades: Trade[]): Trigger[] {
  const triggers: Trigger[] = [];
  const formerLows = new Set<LevelSource>(['PDL','PML','ORL','WkL','ONL']);
  let cvdSession = 0;
  for (let bi = 15; bi < bars.length - 1; bi++) {
    const b = bars[bi]!;
    const m = etMin(b.minStartTs);
    // Update CVD session counter for RTH bars only (causal — through this bar)
    if (m >= 9*60+30 && m < 16*60) cvdSession += b.delta;
    // Skip entry consideration outside the RR active window
    if (m < 10*60) continue;
    if (m > 15*60+25) continue;
    if (m >= 11*60+50 && m <= 13*60+15) continue;

    // Bar-shape gates (matches BSR_short_locked)
    const range = b.high - b.low;
    if (range < 4) return triggers.length ? triggers : [];   // continue equivalent
  }
  // (Re-do above as proper loop — refactor)
  return triggers;
}

// Re-implementing detectTriggers cleanly
function detectBSR(date: string, bars: Bar[], levels: Level[], trades: Trade[]): Trigger[] {
  const triggers: Trigger[] = [];
  const formerLows = new Set<LevelSource>(['PDL','PML','ORL','WkL','ONL']);
  let cvdSession = 0;
  for (let bi = 15; bi < bars.length - 1; bi++) {
    const b = bars[bi]!;
    const m = etMin(b.minStartTs);
    if (m >= 9*60+30 && m < 16*60) cvdSession += b.delta;
    if (m < 10*60) continue;
    if (m > 15*60+25) continue;
    if (m >= 11*60+50 && m <= 13*60+15) continue;

    const range = b.high - b.low;
    if (range < 4) continue;
    const body = b.open - b.close;             // bearish: open > close
    if (body <= 0) continue;
    const bodyPct = range > 0 ? body / range : 0;
    if (bodyPct < 0.40) continue;
    const closeInRangePct = range > 0 ? (b.close - b.low) / range : 0.5;
    if (closeInRangePct > 0.45) continue;
    const upperWick = b.high - Math.max(b.open, b.close);
    if (upperWick < 1.0) continue;
    if (b.delta >= 0) continue;
    const first15 = bars[bi - 15]!;
    const prev15Net = b.close - first15.open;
    if (prev15Net >= 25) continue;

    // Find matching former-low level above close
    let matched: Level | null = null;
    for (const lv of levels) {
      if (!formerLows.has(lv.source)) continue;
      const above = lv.price - b.close;
      if (above > 0 && above <= 3 && lv.price <= b.close + upperWick + 0.5) {
        matched = lv; break;
      }
    }
    if (!matched) continue;

    // Forward outcome — same 30/10 labeling as RR (target=30pt down, MAE=10pt)
    const entryTs = b.minStartTs + 60_000;
    const endTs = entryTs + HORIZON_MS;
    let lo = 0, hi = trades.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (trades[mid].ts < entryTs) lo = mid + 1; else hi = mid; }
    let maxGain = 0, maxDd = 0;
    let result: 'WIN' | 'LOSS' | 'TIMEOUT' = 'TIMEOUT';
    for (let i = lo; i < trades.length && trades[i].ts <= endTs; i++) {
      const px = trades[i].price;
      const g = b.close - px;                 // SHORT: gain when price falls
      const d = px - b.close;                 // drawdown when price rises
      if (g > maxGain) maxGain = g;
      if (d > maxDd) maxDd = d;
      if (maxDd >= MAE_PTS) { result = 'LOSS'; break; }
      if (maxGain >= MFE_PTS) { result = 'WIN'; break; }
    }

    triggers.push({
      date, barTs: b.minStartTs,
      level: matched.source, levelPrice: matched.price,
      close: b.close, range, body, bodyPct, upperWick, closeInRangePct,
      delta: b.delta, vol: b.vol,
      prev15Net,
      cvdSession,
      result, maxGain, maxDd,
    });
  }
  return triggers;
}

async function main(): Promise<void> {
  console.log('RR (BSR_short_locked) — CVD analysis');
  console.log('Target=30pt down / MAE=10pt / 10-min horizon\n');

  const db = new Database(TICKS_DB, { readonly: true });
  db.pragma('journal_mode = WAL');

  const all: Trigger[] = [];
  for (const date of DATES) {
    const trades = loadTrades(db, date);
    if (trades.length < 1000) { console.log(`${date}: insufficient ticks — skipping`); continue; }
    const bars = buildBars(trades);
    const levels = computeLevels(db, date, bars);
    const trigs = detectBSR(date, bars, levels, trades);
    all.push(...trigs);
  }
  db.close();

  console.log(`\nTotal RR triggers: ${all.length}`);
  const wins = all.filter(t => t.result === 'WIN').length;
  const losses = all.filter(t => t.result === 'LOSS').length;
  const tos = all.filter(t => t.result === 'TIMEOUT').length;
  console.log(`W=${wins}  L=${losses}  T=${tos}  WR=${(wins + losses) ? (wins / (wins + losses) * 100).toFixed(1) : 0}%\n`);

  console.log('── All triggers (with CVD at signal time) ──');
  console.log('date       et     lvl   close      cvd      prev15  delta  range  result  maxG  maxDd');
  for (const t of all.sort((a, b) => a.barTs - b.barTs)) {
    console.log(
      `${t.date}  ${etHHMM(t.barTs)}  ${t.level.padEnd(4)} ${t.close.toFixed(2).padStart(8)}  ${t.cvdSession.toString().padStart(7)}  ${t.prev15Net.toFixed(1).padStart(6)}  ${t.delta.toString().padStart(5)}  ${t.range.toFixed(1).padStart(5)}  ${t.result.padEnd(7)}  ${t.maxGain.toFixed(1).padStart(5)}  ${t.maxDd.toFixed(1).padStart(5)}`
    );
  }

  // CVD threshold sweep — for RR shorts we want LOW or NEGATIVE CVD
  console.log('\n── CVD threshold sweep — RR shorts ──');
  console.log('cvdMax    n    W   L   WR    EV@3:1');
  for (const cvdMax of [Infinity, 5000, 2000, 0, -2000, -5000, -10000]) {
    const sub = all.filter(t => t.cvdSession <= cvdMax);
    const w = sub.filter(t => t.result === 'WIN').length;
    const l = sub.filter(t => t.result === 'LOSS').length;
    const wr = (w + l) ? (w / (w + l)) * 100 : 0;
    const wrFrac = (w + l) ? w / (w + l) : 0;
    const ev = wrFrac * 3 - (1 - wrFrac) * 1;
    const label = cvdMax === Infinity ? '(all)' : `≤${cvdMax}`;
    console.log(`${label.padEnd(10)} ${String(sub.length).padStart(3)}  ${String(w).padStart(2)}  ${String(l).padStart(2)}  ${wr.toFixed(1).padStart(5)}%  ${ev.toFixed(2).padStart(6)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
