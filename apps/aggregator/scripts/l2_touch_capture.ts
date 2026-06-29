// l2_touch_capture.ts — Stage 1 (CORRECTED): touch → ENGINE gate → (Stage-3 L2 decider) → trade.
// The flow we agreed: a touch is only a candidate when a levels ENGINE (EST/RDZ/DD/BZ + LM) emits
// a Setup at that level given the regime (DD/mRes/LM/GM/gate). Touches the engine gates out
// (MHP-veto, VX/VVIX sit-out, wrong-direction, no-thesis) are recorded but NOT traded.
// Plus: ONE trade per VISIT (re-arm only after price leaves the pocket — no per-minute over-count),
// and a level-anchored pocket-scaled bracket (entry≈level, TP=pocket top, SL=level-0.3H).
//
// rs rebuilt from rs-context-history@ts. CAVEAT (06-26): rs.irrational[] not logged historically,
// so the irrational-panel sit-out/long-only gate is inert pre-2026-06-29 (#14). Resilience (MHP-veto)
// + VX/VVIX gates DO apply. Engine direction/setup logic is fully reconstructed.
// Run: tsx scripts/l2_touch_capture.ts 2026-06-26
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CqgL2Book } from '../src/l2/cqg-l2-book.js';
import { kyleLambda, type Quote } from '../src/l3/divergence.js';
import { deriveMarketState } from '../src/rules-v2/derive-market-state.js';
import { evaluateEst } from '../src/rules-v2/est-engine.js';
import { evaluateRdz } from '../src/rules-v2/rdz-engine.js';
import { evaluateDdBands } from '../src/rules-v2/dd-engine.js';
import { evaluateBullBearZone } from '../src/rules-v2/bz-engine.js';
import { annotateWithLm } from '../src/rules-v2/lm-engine.js';
import type { Setup } from '../src/rules-v2/engine-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const DAY = process.argv[2] ?? '2026-06-26';
const SYM = 'NQ' as const, TICK = 0.25, NEAR = 8;
const POCKET_MAX = 50, TP_CAP = 40, SL_PTS = 40, SLIP = 5;  // SL = 1 strike (40pt) below the level
const LAMBDA_WIN = 30_000, APPROACH_LB = 300_000, MATCH = 2; // setup-level match tolerance (pts)
const snap = (p: number) => Math.round(p / TICK) * TICK;
const ems = (hm: string) => Date.parse(`${DAY}T${hm}:00-04:00`);
const ec = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false }).slice(-8) + '.' + String(ms % 1000).padStart(3, '0');
const WARM = ems('09:00'), LO = ems('09:32'), RTH_END = ems('16:00');

// ── levels (DailyLevels-shaped) + BrZT touch targets with LP pocket ──────────
const levels = JSON.parse(fs.readFileSync(`${ROOT}/daily_levels.json`, 'utf8')).days[DAY].levels.find((l: any) => l.symbol === SYM);
const bull = (levels.zones?.bull ?? []).map((z: any) => ({ bzb: snap(z.low) }));
const bear = (levels.zones?.bear ?? []).map((z: any) => ({ brzt: snap(z.high) }));
const touchLevels = bear.map((b: any, i: number) => {
  const top = bull.map((x: any) => x.bzb).filter((p: number) => p > b.brzt && p - b.brzt < POCKET_MAX).sort((a: number, z: number) => a - z)[0] ?? null;
  return { label: `BrZT${i}`, lv: b.brzt, pocketTop: top, H: top ? top - b.brzt : null };
});

// ── rs reconstruction from rs-context-history ────────────────────────────────
const ctxDb = new Database(`${ROOT}/data/rs-context-history.db`, { readonly: true });
const ctxRows = ctxDb.prepare(`SELECT * FROM rs_context_ts WHERE trading_day=? AND symbol=? ORDER BY ts_ms`).all(DAY, SYM) as any[];
const ctxAt = (ms: number) => { let r = ctxRows[0]; for (const c of ctxRows) { if (c.ts_ms <= ms) r = c; else break; } return r; };
function buildRs(row: any): any {
  const sc = row?.raw_json ? JSON.parse(row.raw_json) : {};
  return {
    greaterMarket: row?.gm, ddRatio: row?.dd_ratio, lmCode: row?.lm_code,
    redistResilience: row?.redist_res, hpResilience: row?.hp_res, mhpResilience: row?.mhp_res,
    vx: row?.vx, bbb: row?.bbb, vvix: row?.vvix,
    vxAboveBBB: !!row?.vx_above_bbb, vvixElevated: !!row?.vvix_elevated, isRational: !!row?.is_rational,
    qqq: row?.qqq, spy: row?.spy,
    irrational: [],                       // GAP pre-06-29 (#14): irrational-panel gate inert
    bySymbol: { [SYM]: sc },
  };
}

// ── output ───────────────────────────────────────────────────────────────────
const out = new Database(`${ROOT}/data/l2-touch.db`);
out.pragma('journal_mode = WAL');
out.exec(`DROP TABLE IF EXISTS l2_touches;
CREATE TABLE l2_touches (
  id INTEGER PRIMARY KEY, trading_day TEXT, ts_ms INTEGER, ts_et TEXT, symbol TEXT,
  level_label TEXT, level_price REAL, pocket_top REAL, pocket_h REAL, tad TEXT,
  engine_gated INTEGER, engine_family TEXT, engine_dir TEXT, engine_size TEXT, engine_baseprob REAL, gate_mode TEXT,
  gm TEXT, dd_ratio REAL, lm_code TEXT, mhp_res REAL, hp_res REAL, redist_res REAL,
  vx REAL, bbb REAL, vvix REAL, qqq_spy_rs REAL, is_rational INTEGER, vx_vol_state TEXT, regime_class TEXT,
  cvd_60s REAL, leg_pts REAL, leg_secs REAL, leg_vel REAL, cvd_leg REAL,
  best_bid REAL, best_ask REAL, near_bid REAL, near_ask REAL, imbalance REAL, lambda REAL, lambda_r2 REAL,
  entry REAL, tp REAL, sl REAL, exit_ts INTEGER, exit_price REAL, outcome TEXT, pnl_pts REAL
);`);
const ins = out.prepare(`INSERT INTO l2_touches (
  trading_day,ts_ms,ts_et,symbol,level_label,level_price,pocket_top,pocket_h,tad,
  engine_gated,engine_family,engine_dir,engine_size,engine_baseprob,gate_mode,
  gm,dd_ratio,lm_code,mhp_res,hp_res,redist_res,vx,bbb,vvix,qqq_spy_rs,is_rational,vx_vol_state,regime_class,
  cvd_60s,leg_pts,leg_secs,leg_vel,cvd_leg,best_bid,best_ask,near_bid,near_ask,imbalance,lambda,lambda_r2,
  entry,tp,sl,exit_ts,exit_price,outcome,pnl_pts
) VALUES (@trading_day,@ts_ms,@ts_et,@symbol,@level_label,@level_price,@pocket_top,@pocket_h,@tad,
  @engine_gated,@engine_family,@engine_dir,@engine_size,@engine_baseprob,@gate_mode,
  @gm,@dd_ratio,@lm_code,@mhp_res,@hp_res,@redist_res,@vx,@bbb,@vvix,@qqq_spy_rs,@is_rational,@vx_vol_state,@regime_class,
  @cvd_60s,@leg_pts,@leg_secs,@leg_vel,@cvd_leg,@best_bid,@best_ask,@near_bid,@near_ask,@imbalance,@lambda,@lambda_r2,
  @entry,@tp,@sl,@exit_ts,@exit_price,@outcome,@pnl_pts)`);
const updOutcome = out.prepare(`UPDATE l2_touches SET exit_ts=@exit_ts, exit_price=@exit_price, outcome=@outcome, pnl_pts=@pnl_pts WHERE id=@id`);

// ── stream ─────────────────────────────────────────────────────────────────────
const tdb = new Database(`${ROOT}/data/ticks.db`, { readonly: true });
const rows = tdb.prepare(
  `SELECT ts,'D' k, side, price, size FROM depth WHERE symbol=? AND ts BETWEEN ? AND ?
   UNION ALL SELECT ts,'T', is_bid_aggressor, price, size FROM trades WHERE symbol=? AND size>0 AND ts BETWEEN ? AND ?
   ORDER BY ts, k`).iterate(SYM, WARM, RTH_END, SYM, WARM, RTH_END) as IterableIterator<any>;

const book = new CqgL2Book(TICK);
const qbuf: { ts: number; q: Quote }[] = [];
const tape: { ts: number; price: number; size: number; buy: boolean }[] = [];
let lastQ = '', lastSample = 0, last = NaN, curMin = -1, curOpen = NaN, rthOpen = NaN;
const touchedMin = new Set<string>();
const openLevels = new Set<string>();       // single-position per level: skip touches while a trade is live
type Open = { id: number; label: string; dir: string; tp: number; sl: number; entry: number };
const opens: Open[] = [];
const cvdWin = (a: number, b: number) => tape.reduce((s, t) => (t.ts > a && t.ts <= b ? s + (t.buy ? t.size : -t.size) : s), 0);
const matchSetup = (setups: Setup[], lv: number): Setup | null => {
  const c = setups.filter(s => Math.abs(s.level - lv) <= MATCH).sort((a, b) => Math.abs(a.level - lv) - Math.abs(b.level - lv));
  return c[0] ?? null;
};
function regimeClass(ts: number): string {
  const w = tape.filter(t => t.ts >= ts - 300_000 && t.ts <= ts); if (w.length < 20) return 'unknown';
  const px = w.map(t => t.price), hi = Math.max(...px), lo = Math.min(...px), rng = hi - lo;
  const eff = rng > 0 ? Math.abs(px[px.length - 1]! - px[0]!) / rng : 0;
  const vel = Math.abs(px[px.length - 1]! - px[0]!) / ((w[w.length - 1]!.ts - w[0]!.ts) / 1000 + 1);
  return vel > 0.5 && eff > 0.6 ? 'flush' : eff > 0.5 ? 'trend' : 'camp';
}

for (const r of rows) {
  const ts = Number(r.ts), k = r.k, a = Number(r.side), price = Number(r.price), size = Number(r.size);
  book.lastTs = ts;
  if (k === 'D') book.applyDepth(a === 0 ? 'bid' : 'ask', book.intFromPrice(price), size);
  else { book.applyTrade(size, a === 1); tape.push({ ts, price, size, buy: a === 1 }); if (tape.length > 200000) tape.shift(); }
  if (k === 'T' || ts - lastSample >= 150) { lastSample = ts; const q = book.quote(); if (q) { const key = `${q.bidPx}:${q.bidSz}:${q.askPx}:${q.askSz}`; if (key !== lastQ) { lastQ = key; qbuf.push({ ts, q }); if (qbuf.length > 8000) qbuf.shift(); } } }
  if (k !== 'T') continue;
  if (Number.isNaN(rthOpen) && ts >= ems('09:30')) rthOpen = price;

  // resolve open trades on this tick
  for (let i = opens.length - 1; i >= 0; i--) {
    const o = opens[i]!; const tp = o.dir === 'long' ? price >= o.tp : price <= o.tp; const sl = o.dir === 'long' ? price <= o.sl : price >= o.sl;
    if (tp || sl) { const xp = tp ? o.tp : o.sl; updOutcome.run({ id: o.id, exit_ts: ts, exit_price: xp, outcome: tp ? 'WIN' : 'LOSS', pnl_pts: +((o.dir === 'long' ? xp - o.entry : o.entry - xp)).toFixed(2) }); openLevels.delete(o.label); opens.splice(i, 1); }
  }

  const mb = Math.floor(ts / 60000);
  if (mb !== curMin) { curMin = mb; curOpen = price; touchedMin.clear(); }
  if (ts < LO || Number.isNaN(last)) { last = price; continue; }

  for (const L of touchLevels) {
    const key = `${mb}|${L.label}`;
    if (touchedMin.has(key)) continue;
    if ((last - L.lv) * (price - L.lv) >= 0 && price !== L.lv) continue;
    touchedMin.add(key);
    if (openLevels.has(L.label)) continue;        // single-position: skip while a trade is live at this level
    // ── ENGINE GATE ──
    const ctxRow = ctxAt(ts); const rs = buildRs(ctxRow);
    const ms = deriveMarketState({ symbol: SYM, rs, levels, price, open: rthOpen });
    let setups: Setup[] = [];
    try { setups = [...annotateWithLm(ms, evaluateEst(ms)), ...evaluateRdz(ms), ...evaluateDdBands(ms), ...evaluateBullBearZone(ms)]; } catch { setups = []; }
    const th = matchSetup(setups, L.lv);
    const fromUp = curOpen > L.lv;
    const li = book.intFromPrice(L.lv);
    const nb = book.depthNear(li, NEAR, 'bid'), na = book.depthNear(li, NEAR, 'ask');
    const lam = kyleLambda(qbuf.filter(x => x.ts >= ts - LAMBDA_WIN && x.ts <= ts).map(x => x.q));
    let legPx = last, legTs = ts; for (const t of tape) { if (t.ts < ts - APPROACH_LB || t.ts > ts) continue; if (fromUp ? t.price > legPx : t.price < legPx) { legPx = t.price; legTs = t.ts; } }
    const q0 = book.quote();
    const row: any = {
      trading_day: DAY, ts_ms: ts, ts_et: ec(ts), symbol: SYM, level_label: L.label, level_price: L.lv,
      pocket_top: L.pocketTop, pocket_h: L.H, tad: fromUp ? 'FROM_UP' : 'FROM_BELOW',
      engine_gated: th ? 1 : 0, engine_family: th?.family ?? null, engine_dir: th?.direction ?? null,
      engine_size: th?.sizeTier ?? null, engine_baseprob: th?.baseProb ?? null, gate_mode: ms.gate.mode,
      gm: ctxRow?.gm ?? null, dd_ratio: ctxRow?.dd_ratio ?? null, lm_code: ctxRow?.lm_code ?? null,
      mhp_res: ctxRow?.mhp_res ?? null, hp_res: ctxRow?.hp_res ?? null, redist_res: ctxRow?.redist_res ?? null,
      vx: ctxRow?.vx ?? null, bbb: ctxRow?.bbb ?? null, vvix: ctxRow?.vvix ?? null, qqq_spy_rs: ctxRow?.qqq_spy_rs ?? null,
      is_rational: ctxRow?.is_rational ?? null, vx_vol_state: ctxRow?.vx_vol_state ?? null, regime_class: regimeClass(ts),
      cvd_60s: cvdWin(ts - 60000, ts), leg_pts: +(price - legPx).toFixed(2), leg_secs: +((ts - legTs) / 1000).toFixed(1),
      leg_vel: +(Math.abs(price - legPx) / ((ts - legTs) / 1000 + 1)).toFixed(3), cvd_leg: cvdWin(legTs, ts),
      best_bid: q0?.bidPx ?? null, best_ask: q0?.askPx ?? null, near_bid: nb, near_ask: na,
      imbalance: nb + na > 0 ? +(nb / (nb + na)).toFixed(3) : null, lambda: lam?.lambda ?? null, lambda_r2: lam?.r2 ?? null,
      entry: null, tp: null, sl: null, exit_ts: null, exit_price: null, outcome: th ? null : 'GATED', pnl_pts: null,
    };
    const info = ins.run(row);
    if (th) {  // engine-approved → open a level-anchored pocket-scaled trade
      const dir = th.direction;
      const entry = dir === 'long' ? +(L.lv + SLIP).toFixed(2) : +(L.lv - SLIP).toFixed(2);
      const tp = L.pocketTop != null && dir === 'long' ? L.pocketTop : dir === 'long' ? +(L.lv + TP_CAP).toFixed(2) : +(L.lv - TP_CAP).toFixed(2);
      const sl = dir === 'long' ? +(L.lv - SL_PTS).toFixed(2) : +(L.lv + SL_PTS).toFixed(2);
      out.prepare(`UPDATE l2_touches SET entry=?,tp=?,sl=? WHERE id=?`).run(entry, tp, sl, info.lastInsertRowid);
      opens.push({ id: Number(info.lastInsertRowid), label: L.label, dir, tp, sl, entry });
      openLevels.add(L.label);
    }
  }
  last = price;
}
const tot = (out.prepare(`SELECT COUNT(*) c FROM l2_touches WHERE trading_day=?`).get(DAY) as any).c;
const gated = (out.prepare(`SELECT COUNT(*) c FROM l2_touches WHERE trading_day=? AND engine_gated=1`).get(DAY) as any).c;
const w = (out.prepare(`SELECT COUNT(*) c FROM l2_touches WHERE trading_day=? AND outcome='WIN'`).get(DAY) as any).c;
const l = (out.prepare(`SELECT COUNT(*) c FROM l2_touches WHERE trading_day=? AND outcome='LOSS'`).get(DAY) as any).c;
const op = (out.prepare(`SELECT COUNT(*) c FROM l2_touches WHERE trading_day=? AND outcome IS NULL`).get(DAY) as any).c;
console.log(`\nStage 1 (engine-gated, single-position, 40pt SL) — ${DAY} ${SYM}`);
console.log(`  trade-decisions: ${tot}  | engine-APPROVED: ${gated}  | engine-GATED-OUT: ${tot - gated}`);
console.log(`  approved trades → WIN ${w} / LOSS ${l} / OPEN ${op}   WR ${w + l ? Math.round(100 * w / (w + l)) : 0}%`);
console.log(`  (06-26 caveat: irrational-panel gate inert — rs.irrational not logged; MHP-veto + VX/VVIX gates active)`);
process.exit(0);
