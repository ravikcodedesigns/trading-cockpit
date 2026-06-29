// l2_touch_capture.ts — Stage 1 of L2_TOUCH_DECIDER_PLAN: build the per-touch DATASET.
// For each BrZT/LP first-touch (RS_TOUCH_SPEC: first exact cross per clock-minute, ≥09:32),
// capture the causal feature vector (A regime · B approach · C at-touch+reaction), the
// flow-flip confirm, and the forward pocket-scaled bracket outcome (WIN/LOSS, slippage,
// no MFE/MAE). LOG ONLY — nothing trades. CQG/ticks.db (time-accurate). Persist → l2-touch.db.
//
// Scope v1: bear-zone-tops (BrZT) = the bullish LP long-entry prior. Engine_dir = long prior
// (real engine gating layered in Stage 3; regime values captured so the gate is analyzable).
// Deferred to capture-v2 (noted): relative sweep, large-print concentration.
// Run: tsx scripts/l2_touch_capture.ts 2026-06-26
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CqgL2Book } from '../src/l2/cqg-l2-book.js';
import { kyleLambda, type Quote } from '../src/l3/divergence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const DAY = process.argv[2] ?? '2026-06-26';
const SYM = 'NQ', TICK = 0.25;
const NEAR = 8;              // ±2pt "near level" band (defense/supply)
const POCKET_MAX = 50;      // NQ LP/IP proximity (pts)
const SLOWFRAC = 0.3;       // pocket-scaled SL = bottom - 0.3*H
const TP_CAP = 40;          // bracket cap if no pocket
const LAMBDA_WIN = 30_000;  // trailing window for Kyle's λ
const APPROACH_LB = 300_000;// lookback to find the leg's start extreme (5 min)
const REACT_MAX = 120_000;  // max reaction window to find the confirm tick (2 min)
const REACT_BAND = 12;      // ±3pt: price leaving this band w/o confirm = contested
const SLIP = 5;             // entry slippage assumption (pts), per measured ~5pt
const snap = (p: number) => Math.round(p / TICK) * TICK;
const ems = (hm: string) => Date.parse(`${DAY}T${hm}:00-04:00`);
const ec = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false }).slice(-8) + '.' + String(ms % 1000).padStart(3, '0');
const WARM = ems('09:00'), LO = ems('09:32'), RTH_END = ems('16:00');

// ── RS levels + LP pockets (06-26 daily_levels) ──────────────────────────────
const dl = JSON.parse(fs.readFileSync(`${ROOT}/daily_levels.json`, 'utf8')).days[DAY].levels.find((l: any) => l.symbol === SYM);
const bull = (dl.zones?.bull ?? []).map((z: any) => ({ bzb: snap(z.low), top: snap(z.high) }));
const bear = (dl.zones?.bear ?? []).map((z: any) => ({ brzt: snap(z.high) }));
const allLevels = [...new Set<number>([
  ...bull.map((b: any) => b.bzb), ...bear.map((b: any) => b.brzt),
  ...['mhp', 'hedgePressure'].map(k => dl[k]).filter(Boolean).map(snap),
  ...(dl.ddBands ? [snap(dl.ddBands.lower), snap(dl.ddBands.upper)] : []),
  ...(dl.additionalLevels ?? []).filter((a: any) => ['ON HP', 'ON MHP', 'HG'].includes(a.label)).map((a: any) => snap(a.price)),
])].sort((a, b) => a - b);
// each BrZT → its LP pocket (nearest BZB within POCKET_MAX above) → TP target
const touchLevels = bear.map((b: any, i: number) => {
  const bzbAbove = bull.map((x: any) => x.bzb).filter((p: number) => p > b.brzt && p - b.brzt < POCKET_MAX).sort((a: number, z: number) => a - z)[0];
  return { label: `BrZT${i}`, lv: b.brzt, pocketTop: bzbAbove ?? null, H: bzbAbove ? bzbAbove - b.brzt : null };
});

// ── regime: rs-context-history rows for the day (join by ts) ──────────────────
const ctxDb = new Database(`${ROOT}/data/rs-context-history.db`, { readonly: true });
const ctxRows = ctxDb.prepare(
  `SELECT ts_ms, gm, dd_ratio, lm_code, mhp_res, hp_res, redist_res, vx, bbb, vvix, qqq_spy_rs, is_rational, vx_vol_state
   FROM rs_context_ts WHERE trading_day=? AND symbol=? ORDER BY ts_ms`).all(DAY, SYM) as any[];
const ctxAt = (ms: number) => { let r = ctxRows[0]; for (const c of ctxRows) { if (c.ts_ms <= ms) r = c; else break; } return r ?? {}; };

// ── output db ────────────────────────────────────────────────────────────────
const out = new Database(`${ROOT}/data/l2-touch.db`);
out.pragma('journal_mode = WAL');
out.exec(`CREATE TABLE IF NOT EXISTS l2_touches (
  id INTEGER PRIMARY KEY, trading_day TEXT, ts_ms INTEGER, ts_et TEXT, symbol TEXT,
  level_label TEXT, level_price REAL, pocket_top REAL, pocket_h REAL, tad TEXT, engine_dir TEXT,
  -- regime (A)
  gm TEXT, dd_ratio REAL, lm_code TEXT, mhp_res REAL, hp_res REAL, redist_res REAL,
  vx REAL, bbb REAL, vvix REAL, qqq_spy_rs REAL, is_rational INTEGER, vx_vol_state TEXT, regime_class TEXT,
  -- approach (B): trailing-60s AND since-leg-extreme
  cvd_60s REAL, ofi_60s REAL, vel_60s REAL,
  leg_pts REAL, leg_secs REAL, leg_vel REAL, cvd_leg REAL,
  -- at-touch L2 (C)
  best_bid REAL, best_ask REAL, spread REAL, near_bid REAL, near_ask REAL, imbalance REAL, lambda REAL, lambda_r2 REAL,
  -- reaction / confirm
  confirmed INTEGER, confirm_ts INTEGER, confirm_lag_ms INTEGER, cvd_at_confirm REAL,
  absorption TEXT, react_d_nearbid REAL, react_tradevol REAL,
  -- outcome (pocket-scaled bracket from confirm tick; WIN/LOSS/CONTESTED)
  entry REAL, tp REAL, sl REAL, exit_ts INTEGER, exit_price REAL, outcome TEXT, pnl_pts REAL
);
CREATE INDEX IF NOT EXISTS idx_l2t_day ON l2_touches(trading_day, ts_ms);`);
out.prepare(`DELETE FROM l2_touches WHERE trading_day=? AND symbol=?`).run(DAY, SYM);
const ins = out.prepare(`INSERT INTO l2_touches (
  trading_day,ts_ms,ts_et,symbol,level_label,level_price,pocket_top,pocket_h,tad,engine_dir,
  gm,dd_ratio,lm_code,mhp_res,hp_res,redist_res,vx,bbb,vvix,qqq_spy_rs,is_rational,vx_vol_state,regime_class,
  cvd_60s,ofi_60s,vel_60s,leg_pts,leg_secs,leg_vel,cvd_leg,
  best_bid,best_ask,spread,near_bid,near_ask,imbalance,lambda,lambda_r2,
  confirmed,confirm_ts,confirm_lag_ms,cvd_at_confirm,absorption,react_d_nearbid,react_tradevol,
  entry,tp,sl,exit_ts,exit_price,outcome,pnl_pts
) VALUES (@trading_day,@ts_ms,@ts_et,@symbol,@level_label,@level_price,@pocket_top,@pocket_h,@tad,@engine_dir,
  @gm,@dd_ratio,@lm_code,@mhp_res,@hp_res,@redist_res,@vx,@bbb,@vvix,@qqq_spy_rs,@is_rational,@vx_vol_state,@regime_class,
  @cvd_60s,@ofi_60s,@vel_60s,@leg_pts,@leg_secs,@leg_vel,@cvd_leg,
  @best_bid,@best_ask,@spread,@near_bid,@near_ask,@imbalance,@lambda,@lambda_r2,
  @confirmed,@confirm_ts,@confirm_lag_ms,@cvd_at_confirm,@absorption,@react_d_nearbid,@react_tradevol,
  @entry,@tp,@sl,@exit_ts,@exit_price,@outcome,@pnl_pts)`);

// ── stream the day ────────────────────────────────────────────────────────────
const tdb = new Database(`${ROOT}/data/ticks.db`, { readonly: true });
// STREAM (.iterate) — the window is ~24M depth rows; .all() OOMs. Row-by-row, memory-bounded.
const streamStmt = tdb.prepare(
  `SELECT ts,'D' k, side, price, size FROM depth WHERE symbol=? AND ts BETWEEN ? AND ?
   UNION ALL SELECT ts,'T', is_bid_aggressor, price, size FROM trades WHERE symbol=? AND size>0 AND ts BETWEEN ? AND ?
   ORDER BY ts, k`);
const rows = streamStmt.iterate(SYM, WARM, RTH_END, SYM, WARM, RTH_END) as IterableIterator<any>;

const book = new CqgL2Book(TICK);
const qbuf: { ts: number; q: Quote }[] = [];                 // best-quote ring (λ/OFI)
const tape: { ts: number; price: number; size: number; buy: boolean }[] = []; // trade ring (CVD/leg/vol)
let lastQ = '';
let lastSample = 0;          // throttle the O(n) best-quote scan to ~150ms (enough for 30s λ window)
let last = NaN, curMin = -1, curOpen = NaN; const touched = new Set<string>();

// rolling recent extreme for the leg anchor (per-direction): track max/min over APPROACH_LB
function legStart(touchTs: number, level: number, fromUp: boolean): { ts: number; px: number } {
  // the leg into a support from above starts at the recent HIGH; from below starts at recent LOW
  let best = { ts: touchTs, px: last };
  for (const t of tape) {
    if (t.ts < touchTs - APPROACH_LB || t.ts > touchTs) continue;
    if (fromUp ? t.price > best.px : t.price < best.px) best = { ts: t.ts, px: t.price };
  }
  return best;
}
const cvdWin = (a: number, b: number) => tape.reduce((s, t) => (t.ts > a && t.ts <= b ? s + (t.buy ? t.size : -t.size) : s), 0);
const ofiWin = (a: number, b: number) => { const qs = qbuf.filter(x => x.ts > a && x.ts <= b).map(x => x.q); let o = 0; for (let i = 1; i < qs.length; i++) { /* reuse ofiStep via kyleLambda's series indirectly */ } return qs.length; };
const tradeVolAtLevel = (a: number, b: number, level: number) => tape.reduce((s, t) => (t.ts > a && t.ts <= b && Math.abs(t.price - level) <= NEAR * TICK ? s + t.size : s), 0);

// regime classifier (causal, relative): camp / trend / flush over the prior 5 min
function regimeClass(touchTs: number): string {
  const w = tape.filter(t => t.ts >= touchTs - 300_000 && t.ts <= touchTs);
  if (w.length < 20) return 'unknown';
  const px = w.map(t => t.price); const hi = Math.max(...px), lo = Math.min(...px), rng = hi - lo;
  const net = Math.abs(px[px.length - 1]! - px[0]!);
  const eff = rng > 0 ? net / rng : 0;                       // directional efficiency
  const vel = (Math.abs(px[px.length - 1]! - px[0]!)) / ((w[w.length - 1]!.ts - w[0]!.ts) / 1000 + 1);
  if (vel > 0.5 && eff > 0.6) return 'flush';                // fast + directional
  if (eff > 0.5) return 'trend';                             // directional drift
  return 'camp';                                             // contained / two-sided
}

for (const r of rows) {
  const ts = Number(r.ts); const k = r.k; const a = Number(r.side); const price = Number(r.price); const size = Number(r.size);
  book.lastTs = ts;
  if (k === 'D') book.applyDepth(a === 0 ? 'bid' : 'ask', book.intFromPrice(price), size);
  else { book.applyTrade(size, a === 1); tape.push({ ts, price, size, buy: a === 1 }); if (tape.length > 200000) tape.shift(); }
  // sample best-quote on a ~150ms cadence (and always on a trade) — avoids the O(n) ladder
  // scan on every one of ~24M depth events; 150ms gives ~200 quotes per 30s λ window.
  if (k === 'T' || ts - lastSample >= 150) {
    lastSample = ts;
    const q = book.quote();
    if (q) { const key = `${q.bidPx}:${q.bidSz}:${q.askPx}:${q.askSz}`; if (key !== lastQ) { lastQ = key; qbuf.push({ ts, q }); if (qbuf.length > 8000) qbuf.shift(); } }
  }
  if (k !== 'T') continue;
  const mb = Math.floor(ts / 60000);
  if (mb !== curMin) { curMin = mb; curOpen = price; touched.clear(); }
  if (ts < LO || Number.isNaN(last)) { last = price; continue; }

  for (const L of touchLevels) {
    const key = `${mb}|${L.label}`;
    if (touched.has(key)) continue;
    if ((last - L.lv) * (price - L.lv) >= 0 && price !== L.lv) continue;
    touched.add(key);
    const fromUp = curOpen > L.lv;
    const tad = fromUp ? 'FROM_UP' : 'FROM_BELOW';
    const c = ctxAt(ts);
    const li = book.intFromPrice(L.lv);
    const nb = book.depthNear(li, NEAR, 'bid'), na = book.depthNear(li, NEAR, 'ask');
    const lam = kyleLambda(qbuf.filter(x => x.ts >= ts - LAMBDA_WIN && x.ts <= ts).map(x => x.q));
    const leg = legStart(ts, L.lv, fromUp);
    const q0 = book.quote();
    ins.run({
      trading_day: DAY, ts_ms: ts, ts_et: ec(ts), symbol: SYM,
      level_label: L.label, level_price: L.lv, pocket_top: L.pocketTop, pocket_h: L.H, tad, engine_dir: 'long',
      gm: c.gm ?? null, dd_ratio: c.dd_ratio ?? null, lm_code: c.lm_code ?? null, mhp_res: c.mhp_res ?? null,
      hp_res: c.hp_res ?? null, redist_res: c.redist_res ?? null, vx: c.vx ?? null, bbb: c.bbb ?? null,
      vvix: c.vvix ?? null, qqq_spy_rs: c.qqq_spy_rs ?? null, is_rational: c.is_rational ?? null,
      vx_vol_state: c.vx_vol_state ?? null, regime_class: regimeClass(ts),
      cvd_60s: cvdWin(ts - 60000, ts), ofi_60s: null, vel_60s: null,
      leg_pts: +(price - leg.px).toFixed(2), leg_secs: +((ts - leg.ts) / 1000).toFixed(1),
      leg_vel: +(Math.abs(price - leg.px) / ((ts - leg.ts) / 1000 + 1)).toFixed(3), cvd_leg: cvdWin(leg.ts, ts),
      best_bid: q0?.bidPx ?? null, best_ask: q0?.askPx ?? null, spread: q0 ? +(q0.askPx - q0.bidPx).toFixed(2) : null,
      near_bid: nb, near_ask: na, imbalance: nb + na > 0 ? +(nb / (nb + na)).toFixed(3) : null,
      lambda: lam?.lambda ?? null, lambda_r2: lam?.r2 ?? null,
      // reaction/confirm/outcome filled by a 2nd pass below (need forward ticks)
      confirmed: null, confirm_ts: null, confirm_lag_ms: null, cvd_at_confirm: null,
      absorption: null, react_d_nearbid: null, react_tradevol: null,
      entry: null, tp: null, sl: null, exit_ts: null, exit_price: null, outcome: null, pnl_pts: null,
    });
  }
  last = price;
}
const n = (out.prepare(`SELECT COUNT(*) c FROM l2_touches WHERE trading_day=?`).get(DAY) as any).c;
console.log(`Stage 1 capture: ${n} BrZT touches → data/l2-touch.db  (${DAY} ${SYM})`);
console.log(`(reaction/confirm/outcome = pass 2; run l2_touch_resolve.ts next)`);
process.exit(0);
