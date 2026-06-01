/**
 * rr_5min_research.ts — RR (Reject Resistance) on 5-min bars.
 *
 * Same mechanic as 1-min RR (BSR_short_locked):
 *   former-low level (PDL/PML/ORL/WkL/ONL) sits ABOVE close, the bar's upper
 *   wick reaches it, bar closes bearish below the level with seller delta.
 *
 * Thresholds scaled for 5-min:
 *   range ≥ 12 (was 4 on 1-min)
 *   upperWick ≥ 3 (was 1)
 *   bodyPct, closeInRangePct, deltaSign criteria unchanged
 *   prev3barsNet (= 15 min) < 25  (mirrors 1-min's prev15Net)
 *
 * Labels still use 30pt MFE / 10pt MAE forward, 15-min window.
 *
 * Conventions:
 *   is_bid_aggressor=1 → BUY aggressor (verified empirically)
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const BAR_MS      = 5 * 60_000;
const HORIZON_MS  = 15 * 60_000;
const MFE_PTS     = 30;
const MAE_PTS     = 10;
const MIN_ET_MIN  = Number(process.env.MIN_ET_MIN ?? 600);   // skip 09:30–10:00

const TRAIN_DATES = ['2026-05-05','2026-05-06','2026-05-08','2026-05-11','2026-05-12',
                     '2026-05-13','2026-05-14','2026-05-15','2026-05-18','2026-05-19'];
const TEST_DATES  = ['2026-05-20','2026-05-21','2026-05-22','2026-05-26','2026-05-27'];

const RTH_OPEN_MIN = 9 * 60 + 30;
const RTH_END_MIN  = 15 * 60 + 55;

type Trade = { ts: number; price: number; size: number; isBidAgg: 0|1 };
type Bar = {
  minStartTs: number;
  open: number; high: number; low: number; close: number;
  vol: number; delta: number;
};

type LevelSource =
  | 'PDH'|'PDL'|'PMH'|'PML'|'WkH'|'WkL'|'ORH'|'ORL'
  | 'PDC'|'PDO'|'ONH'|'ONL'|'ONMid';
type Level = { price: number; source: LevelSource };

function etMinutesOfDay(tsMs: number): number {
  const d = new Date(tsMs - 4 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function etDateFor(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
function etHHMM(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

function loadTrades(db: Database.Database, date: string, fromHHMM: string, toHHMM: string): Trade[] {
  const startTs = Date.parse(`${date}T${fromHHMM}-04:00`);
  const endTs   = Date.parse(`${date}T${toHHMM}-04:00`);
  return db.prepare(
    `SELECT ts, price, size, is_bid_aggressor AS isBidAgg
     FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?
     ORDER BY ts ASC, id ASC`
  ).all(startTs, endTs) as Trade[];
}

function buildBars(trades: Trade[]): Bar[] {
  const bars: Bar[] = [];
  let cur: Bar | null = null;
  for (const t of trades) {
    const bk = Math.floor(t.ts / BAR_MS) * BAR_MS;
    if (!cur || cur.minStartTs !== bk) {
      if (cur) bars.push(cur);
      cur = { minStartTs: bk, open: t.price, high: t.price, low: t.price, close: t.price, vol: 0, delta: 0 };
    }
    if (t.price > cur.high) cur.high = t.price;
    if (t.price < cur.low)  cur.low  = t.price;
    cur.close = t.price;
    cur.vol += t.size;
    cur.delta += (t.isBidAgg === 1 ? t.size : -t.size);
  }
  if (cur) bars.push(cur);
  return bars;
}

// ─── Levels (same as level_filter_test.ts but minimal — only what RR needs) ──

function queryHighLow(db: Database.Database, date: string, from: string, to: string): { hi: number; lo: number } | null {
  const startTs = Date.parse(`${date}T${from}-04:00`);
  const endTs   = Date.parse(`${date}T${to}-04:00`);
  const row = db.prepare(
    `SELECT MAX(price) hi, MIN(price) lo FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?`
  ).get(startTs, endTs) as { hi: number; lo: number } | undefined;
  if (!row || row.hi == null || row.lo == null) return null;
  return row;
}

function queryOpenClose(db: Database.Database, date: string, from: string, to: string): { open: number; close: number } | null {
  const startTs = Date.parse(`${date}T${from}-04:00`);
  const endTs   = Date.parse(`${date}T${to}-04:00`);
  const o = db.prepare(`SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ? ORDER BY ts ASC, id ASC LIMIT 1`).get(startTs, endTs) as { price: number } | undefined;
  const c = db.prepare(`SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1`).get(startTs, endTs) as { price: number } | undefined;
  if (!o || !c) return null;
  return { open: o.price, close: c.price };
}

function overnightHL(db: Database.Database, prevDate: string, today: string): { hi: number; lo: number } | null {
  const startTs = Date.parse(`${prevDate}T16:00:00-04:00`);
  const endTs   = Date.parse(`${today}T09:30:00-04:00`);
  const row = db.prepare(`SELECT MAX(price) hi, MIN(price) lo FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?`).get(startTs, endTs) as { hi: number; lo: number } | undefined;
  if (!row || row.hi == null || row.lo == null) return null;
  return row;
}

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

function computeStaticLevels(db: Database.Database, date: string): Level[] {
  const out: Level[] = [];
  const [prev1, prev2, prev3, prev4, prev5] = prevTradingDays(date, 5);
  const pd = queryHighLow(db, prev1!, '09:30', '16:00');
  if (pd) { out.push({ price: pd.hi, source: 'PDH' }); out.push({ price: pd.lo, source: 'PDL' }); }
  const pdOC = queryOpenClose(db, prev1!, '09:30', '16:00');
  if (pdOC) { out.push({ price: pdOC.open, source: 'PDO' }); out.push({ price: pdOC.close, source: 'PDC' }); }
  const pm = queryHighLow(db, date, '04:00', '09:30');
  if (pm) { out.push({ price: pm.hi, source: 'PMH' }); out.push({ price: pm.lo, source: 'PML' }); }
  const on = overnightHL(db, prev1!, date);
  if (on) {
    out.push({ price: on.hi, source: 'ONH' });
    out.push({ price: on.lo, source: 'ONL' });
    out.push({ price: (on.hi + on.lo)/2, source: 'ONMid' });
  }
  let wkHi = -Infinity, wkLo = Infinity, anyWk = false;
  for (const d of [prev1, prev2, prev3, prev4, prev5]) {
    const r = queryHighLow(db, d!, '09:30', '16:00');
    if (!r) continue;
    if (r.hi > wkHi) wkHi = r.hi;
    if (r.lo < wkLo) wkLo = r.lo;
    anyWk = true;
  }
  if (anyWk) { out.push({ price: wkHi, source: 'WkH' }); out.push({ price: wkLo, source: 'WkL' }); }
  return out;
}

function computeOpeningRange(bars: Bar[]): Level[] {
  let hi = -Infinity, lo = Infinity, any = false;
  for (const b of bars) {
    const mod = etMinutesOfDay(b.minStartTs);
    if (mod >= 9*60+30 && mod < 10*60) {
      if (b.high > hi) hi = b.high;
      if (b.low  < lo) lo = b.low;
      any = true;
    }
  }
  if (!any) return [];
  return [{ price: hi, source: 'ORH' }, { price: lo, source: 'ORL' }];
}

// ─── Outcome label ──────────────────────────────────────────────────────────

function labelEntry(trades: Trade[], entryTs: number, entryPrice: number, dir: 'long'|'short'): boolean {
  const endTs = entryTs + HORIZON_MS;
  let lo = 0, hi = trades.length;
  while (lo < hi) { const mid = (lo+hi)>>>1; if (trades[mid].ts < entryTs) lo = mid+1; else hi = mid; }
  let mfe = 0, mae = 0;
  for (let i = lo; i < trades.length && trades[i].ts <= endTs; i++) {
    const px = trades[i].price;
    if (dir === 'long') {
      const g = px - entryPrice, d = entryPrice - px;
      if (g > mfe) mfe = g; if (d > mae) mae = d;
      if (mae > MAE_PTS) return false;
      if (mfe >= MFE_PTS) return true;
    } else {
      const g = entryPrice - px, d = px - entryPrice;
      if (g > mfe) mfe = g; if (d > mae) mae = d;
      if (mae > MAE_PTS) return false;
      if (mfe >= MFE_PTS) return true;
    }
  }
  return false;
}

// ─── RR-on-5min filter ──────────────────────────────────────────────────────

type Trigger = {
  date: string; et: string; entry: number;
  range: number; body: number; bodyPct: number; upperWick: number; closeInRangePct: number;
  delta: number; prev15Net: number;
  level: Level; sweepDist: number;
  won: boolean;
};

function runVariant(
  name: string,
  bars: Bar[],
  trades: Trade[],
  levels: Level[],
  date: string,
  cfg: { range:number; body:number; closeInRng:number; wick:number; trendMax:number; lvlTol:number; },
): Trigger[] {
  const triggers: Trigger[] = [];
  for (let bi = 3; bi < bars.length - 1; bi++) {
    const b = bars[bi];
    const mod = etMinutesOfDay(b.minStartTs);
    if (mod < MIN_ET_MIN || mod > RTH_END_MIN) continue;
    // Skip lunch 11:50-13:15 and last 30 min 15:25+
    if (mod >= 11*60+50 && mod <= 13*60+15) continue;
    if (mod >= 15*60+25) continue;
    // Bar shape (bearish)
    const range = b.high - b.low;
    if (range < cfg.range) continue;
    const body  = b.open - b.close;
    if (body <= 0) continue;
    const bodyPct = range > 0 ? body / range : 0;
    if (bodyPct < cfg.body) continue;
    const closeInRng = range > 0 ? (b.close - b.low) / range : 0.5;
    if (closeInRng > cfg.closeInRng) continue;
    const upperWick = b.high - Math.max(b.open, b.close);
    if (upperWick < cfg.wick) continue;
    if (b.delta >= 0) continue;
    // Trend gate — use prev3 bars on 5-min = 15 min net (mirrors 1-min's prev15)
    const first3 = bars[bi - 3];
    if (!first3) continue;
    const prev15Net = b.close - first3.open;
    if (prev15Net >= cfg.trendMax) continue;
    // Level confluence — former-low above close, upper wick reaches it
    const formerLows = new Set<LevelSource>(['PDL','PML','ORL','WkL','ONL']);
    let matched: Level | undefined;
    for (const lv of levels) {
      if (!formerLows.has(lv.source)) continue;
      const above = lv.price - b.close;
      if (above <= 0 || above > cfg.lvlTol) continue;
      if (lv.price > b.close + upperWick + 0.5) continue;
      if (!matched || lv.price < matched.price) matched = lv;
    }
    if (!matched) continue;
    // Label
    const entryTs = b.minStartTs + BAR_MS;
    const won = labelEntry(trades, entryTs, b.close, 'short');
    triggers.push({
      date, et: etHHMM(b.minStartTs), entry: b.close,
      range, body, bodyPct, upperWick, closeInRangePct: closeInRng,
      delta: b.delta, prev15Net,
      level: matched, sweepDist: matched.price - b.close,
      won,
    });
  }
  return triggers;
}

// ─── Main ──────────────────────────────────────────────────────────────────

const VARIANTS = {
  // V1 — scaled-up 1-min thresholds (5x range, 3x wick)
  V1_scaled:    { range: 12, body: 0.40, closeInRng: 0.45, wick: 3.0, trendMax: 25, lvlTol: 5 },
  // V2 — same as 1-min thresholds (test if 5-min responds to tighter criteria)
  V2_sameAs1m:  { range: 4,  body: 0.40, closeInRng: 0.45, wick: 1.0, trendMax: 25, lvlTol: 3 },
  // V3 — middle ground
  V3_mid:       { range: 8,  body: 0.40, closeInRng: 0.45, wick: 2.0, trendMax: 25, lvlTol: 4 },
  // V4 — strict scaled
  V4_strict:    { range: 15, body: 0.50, closeInRng: 0.35, wick: 4.0, trendMax: 20, lvlTol: 5 },
} as const;

async function main() {
  const arg = process.argv[2];
  let dates = TRAIN_DATES, mode = 'train';
  if (arg === 'test') { dates = TEST_DATES; mode = 'test'; }

  console.log(`5-min RR research — mode=${mode}  bar=${BAR_MS/60_000}min  MFE≥${MFE_PTS} MAE≤${MAE_PTS}  horizon=${HORIZON_MS/60_000}min`);
  const db = new Database(TICKS_DB, { readonly: true });
  db.pragma('journal_mode = WAL');

  const allByVariant: Record<string, Trigger[]> = {};
  for (const name of Object.keys(VARIANTS)) allByVariant[name] = [];

  for (const date of dates) {
    const trades = loadTrades(db, date, '04:00', '16:30');
    const bars = buildBars(trades);
    const staticLevels = computeStaticLevels(db, date);
    const orLevels = computeOpeningRange(bars);
    const levels = [...staticLevels, ...orLevels];
    for (const [name, cfg] of Object.entries(VARIANTS)) {
      const trigs = runVariant(name, bars, trades, levels, date, cfg);
      allByVariant[name]!.push(...trigs);
    }
  }
  db.close();

  console.log('\nVariant performance:');
  console.log('name           triggers  wins   WR    levels matched');
  for (const [name, trigs] of Object.entries(allByVariant)) {
    const wins = trigs.filter(t => t.won).length;
    const wr = trigs.length ? (wins / trigs.length) * 100 : 0;
    const lvlCounts: Record<string, number> = {};
    for (const t of trigs) lvlCounts[t.level.source] = (lvlCounts[t.level.source] ?? 0) + 1;
    const lvlSummary = Object.entries(lvlCounts).map(([s, n]) => `${s}=${n}`).join(',');
    console.log(`${name.padEnd(14)}  ${String(trigs.length).padStart(8)}  ${String(wins).padStart(4)}  ${wr.toFixed(1).padStart(5)}%  ${lvlSummary}`);
  }

  console.log('\nAll triggers (V1_scaled):');
  console.log('date       et    entry      lvl                rng body wick closeRng prev15  result');
  for (const t of allByVariant['V1_scaled']!) {
    console.log(
      `${t.date}  ${t.et}  ${t.entry.toFixed(2).padStart(8)}  ${t.level.source}@${t.level.price.toFixed(2)}`.padEnd(50) +
      `${t.range.toFixed(1).padStart(4)}  ${(t.bodyPct*100).toFixed(0).padStart(3)}  ${t.upperWick.toFixed(1).padStart(4)}  ${(t.closeInRangePct*100).toFixed(0).padStart(3)}  ` +
      `${t.prev15Net.toFixed(1).padStart(5)}  ${t.won ? 'WIN' : 'lose'}`
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
