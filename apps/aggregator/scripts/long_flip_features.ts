/**
 * long_flip_features.ts — does adding the SHORT-style structure (prior-impulse-down
 * + lower-wick rejection) to the LONG FLIP help?
 *
 * SANDBOX, read-only on ticks.db. Detects FLIP LONGs (baseline criteria) over the
 * full ticks.db history, records the two CANDIDATE mirror features, runs each to
 * tradable (tod + cooldown + quality; NO cvd gate — cvd is dropped), walk-forwards
 * TP80/SL55, writes JSON for offline analysis. Outcome = WIN/LOSS/DRAW only.
 *
 * Mirror features (symmetric to the SHORT detector):
 *   priorImpulseDown = min(prev1.delta, prev2.delta)   (SHORT uses max(...)>=1400)
 *   lowerWick        = close - low                       (SHORT uses high-close>=15)
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'fs';

const TICKS = process.env.INPUT_DB || `${process.env.HOME}/trading-cockpit/data/ticks.db`;
const OUT = process.env.OUTPUT_JSON || `${process.env.HOME}/trading-cockpit/data/sandbox-cvd/long_flip_features.json`;

const MIN_1 = 60_000, MACRO_N = 30, COOLDOWN_MS = 15 * MIN_1;
const BODY_MIN = 5.0, FLIP_COMP_MIN_LONG = -0.05, FLIP_COMP_MAX_LONG = 0.30, FLIP_DELTA_T_LONG = 300, FLIP_PRIOR3_LONG = -100;
const Q_DELTA15_LONG_MAX = 500, Q_DELTA5_ABS = 1000;
const TP = 80, SL = 55;

interface Trade { ts: number; price: number; size: number; is_bid_aggressor: number; }
interface Bar { ts: number; open: number; high: number; low: number; close: number; vol: number; delta: number; }

function etMin(tsMs: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(tsMs));
  return parseInt(p.find(x => x.type === 'hour')!.value, 10) * 60 + parseInt(p.find(x => x.type === 'minute')!.value, 10);
}
const longTimeOk = (ts: number) => { const e = etMin(ts); return !(e < 594 || (e >= 870 && e < 960)); };

function buildBars(trades: Trade[]): Bar[] {
  const m = new Map<number, { open: number; close: number; high: number; low: number; bidVol: number; askVol: number }>();
  for (const t of trades) {
    const b = Math.floor(t.ts / MIN_1) * MIN_1; const bar = m.get(b);
    if (!bar) m.set(b, { open: t.price, close: t.price, high: t.price, low: t.price, bidVol: t.is_bid_aggressor === 1 ? t.size : 0, askVol: t.is_bid_aggressor === 0 ? t.size : 0 });
    else { bar.high = Math.max(bar.high, t.price); bar.low = Math.min(bar.low, t.price); bar.close = t.price; if (t.is_bid_aggressor === 1) bar.bidVol += t.size; else bar.askVol += t.size; }
  }
  return [...m.entries()].sort(([a], [b]) => a - b).map(([ts, b]) => ({ ts, open: b.open, high: b.high, low: b.low, close: b.close, vol: b.bidVol + b.askVol, delta: b.bidVol - b.askVol }));
}

function walkForward(trades: Trade[], entryTs: number, entry: number, closeMs: number): { o: string; pnl: number } {
  let last = entry;
  for (const t of trades) {
    if (t.ts < entryTs) continue; if (t.ts >= closeMs) break; last = t.price;
    if (t.price >= entry + TP) return { o: 'WIN', pnl: TP };
    if (t.price <= entry - SL) return { o: 'LOSS', pnl: -SL };
  }
  return { o: 'DRAW', pnl: last - entry };
}

const db = new Database(TICKS, { readonly: true });
const days = (db.prepare(`SELECT DISTINCT date(datetime((ts-14400000)/1000,'unixepoch')) d FROM trades WHERE symbol='NQ' ORDER BY d`).all() as any[]).map(r => r.d);
const out: any[] = [];

for (const day of days) {
  const [y, m, d] = day.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d, 13, 30), end = Date.UTC(y, m - 1, d, 20, 0), close = Date.UTC(y, m - 1, d, 19, 54);
  const pre = start - MACRO_N * MIN_1;
  const trades = db.prepare(`SELECT ts,price,size,is_bid_aggressor FROM trades WHERE symbol='NQ' AND ts>=? AND ts<? ORDER BY ts ASC`).all(pre, end) as Trade[];
  if (trades.length < 1000) continue;
  const rthTrades = trades.filter(t => t.ts >= start);
  const bars = buildBars(trades);
  let lastLong = 0;
  for (let i = MACRO_N; i < bars.length; i++) {
    const cur = bars[i]!; if (cur.ts < start || cur.ts >= end) continue;
    const macro = bars.slice(i - MACRO_N, i); if (macro.length < MACRO_N) continue;
    const hi = Math.max(...macro.map(b => b.high)), lo = Math.min(...macro.map(b => b.low)), range = hi - lo;
    const compPos = range > 0 ? (cur.low - lo) / range : 0.5;
    const delta15 = bars.slice(Math.max(0, i - 15), i).reduce((s, b) => s + b.delta, 0);
    const delta5 = bars.slice(Math.max(0, i - 5), i).reduce((s, b) => s + b.delta, 0);
    const deltaLast3 = bars.slice(Math.max(0, i - 3), i).reduce((s, b) => s + b.delta, 0);
    const deltaT = cur.delta;
    const bodyLong = cur.close - cur.open;
    // baseline LONG FLIP
    if (!(bodyLong >= BODY_MIN && deltaT >= FLIP_DELTA_T_LONG && compPos >= FLIP_COMP_MIN_LONG && compPos <= FLIP_COMP_MAX_LONG && deltaLast3 <= FLIP_PRIOR3_LONG)) continue;
    const trigTs = cur.ts + MIN_1;
    if (!longTimeOk(trigTs)) continue;
    if (cur.ts - lastLong < COOLDOWN_MS) continue;
    lastLong = cur.ts;
    // quality
    if (delta15 >= Q_DELTA15_LONG_MAX) continue;
    if (!(delta5 <= -Q_DELTA5_ABS)) continue;
    // ── CANDIDATE MIRROR FEATURES ──
    const priorImpulseDown = Math.min(bars[i - 1]?.delta ?? 0, bars[i - 2]?.delta ?? 0);
    const lowerWick = cur.close - cur.low;          // mirror of SHORT high-close
    const strictLowerWick = Math.min(cur.open, cur.close) - cur.low;
    const wf = walkForward(rthTrades, trigTs, cur.close, close);
    out.push({ day, trigTs, entry: cur.close, deltaT, delta5, delta15, deltaLast3, compPos: +compPos.toFixed(3), body: +bodyLong.toFixed(1), priorImpulseDown, lowerWick: +lowerWick.toFixed(1), strictLowerWick: +strictLowerWick.toFixed(1), outcome: wf.o, pnl: wf.pnl });
  }
}
db.close();
writeFileSync(OUT, JSON.stringify(out, null, 0));
const res = out.filter(r => r.outcome !== 'DRAW');
const w = res.filter(r => r.outcome === 'WIN').length;
console.log(`\n=== baseline tradable LONGs: ${out.length} (resolved ${res.length}: ${w}W/${res.length - w}L, ${out.filter(r => r.outcome === 'DRAW').length}D)`);
console.log(`WR=${res.length ? Math.round(100 * w / res.length) : 0}%  pnl=${out.reduce((s, r) => s + (r.pnl || 0), 0).toFixed(0)}pt  → ${OUT}`);
