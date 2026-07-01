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
import { l2Decide, setupClassOf } from '../src/rules-v2/l2-decider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const DAY = process.argv[2] ?? '2026-06-26';
// --decider: gate trades on the Stage-3 L2 confirm/veto (re-sequences single-position so a vetoed
// touch frees the slot for a later one). Without it, the decider verdict is still RECORDED per
// engine-approved touch (l2_decision/l2_score) for the engine-alone-vs-decider comparison.
const USE_DECIDER = process.argv.includes('--decider');
const SYM = 'NQ' as const, TICK = 0.25, NEAR = 8;
const POCKET_MAX = 50, TP_CAP = 40, SL_PTS = 40, SLIP = 5;  // SL = 1 strike (40pt) below the level
const LAMBDA_WIN = 30_000, APPROACH_LB = 300_000, MATCH = 2; // setup-level match tolerance (pts)
const QUOTE_SAMPLE_MS = 150;  // λ quote-sampling throttle: λ is a weak/coarse separator (wins higher = magnitude
                              // not direction), so 150ms sampling is ample and ~6m48→fast (full-res was wasted cost)
const snap = (p: number) => Math.round(p / TICK) * TICK;
const ems = (hm: string) => Date.parse(`${DAY}T${hm}:00-04:00`);
const ec = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false }).slice(-8) + '.' + String(ms % 1000).padStart(3, '0');
const WARM = ems('09:00'), LO = ems('09:32'), RTH_END = ems('16:00');

// ── levels (DailyLevels-shaped) + BrZT touch targets with LP pocket ──────────
const levels = JSON.parse(fs.readFileSync(`${ROOT}/daily_levels.json`, 'utf8')).days[DAY].levels.find((l: any) => l.symbol === SYM);
const bull = (levels.zones?.bull ?? []).map((z: any) => ({ bzb: snap(z.low) }));
const bear = (levels.zones?.bear ?? []).map((z: any) => ({ brzt: snap(z.high) }));
// Touch targets across ALL engine levels (not just BrZT) — each tagged with a FAMILY so Stage-2 can
// group by level type. BrZT carries its LP pocket; line levels (MHP / DD-lower / …) bounce on the
// fixed bracket (no pocket). The touch/TAD detection + engine gate + L2 decider are level-agnostic.
const touchLevels: any[] = [];
bear.forEach((b: any, i: number) => {
  const top = bull.map((x: any) => x.bzb).filter((p: number) => p > b.brzt && p - b.brzt < POCKET_MAX).sort((a: number, z: number) => a - z)[0] ?? null;
  touchLevels.push({ label: `BrZT${i}`, family: 'BrZT', lv: b.brzt, pocketTop: top, H: top ? top - b.brzt : null });
});
const addLine = (label: string, family: string, v: number | null | undefined) => {
  if (v == null) return; touchLevels.push({ label, family, lv: snap(v), pocketTop: null, H: null });
};
bull.forEach((b: any, i: number) => touchLevels.push({ label: `BZB${i}`, family: 'BZB', lv: b.bzb, pocketTop: null, H: null }));  // bull-zone bottom bounce (IP entry)
const onMhp = (levels.additionalLevels ?? []).find((a: any) => /^ON ?MHP$/i.test(a.label))?.price ?? null;
addLine('MHP', 'MHP', levels.mhp);                  // MHP bounce (EST: N if MRes>0 else S/M)
addLine('ONMHP', 'ONMHP', onMhp);                   // overnight MHP (manual pre-session) — same bounce as MHP
addLine('DDlo', 'DDlo', levels.ddBands?.lower);     // DD-lower bounce (DD: N if DD>0.5 else M)
addLine('DDup', 'DDup', levels.ddBands?.upper);     // DD-upper (DD: rejection/break — engine decides dir)

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

// LM-open zone (Image 8/9): the LM code at the 9:30 ET open. ONLY valid if the feed actually has a row
// NEAR the open ([-5min, +30min]). If the context feed started late (e.g. 06-25 began ~11:28 ET because
// the platform didn't reload to pull the open — now fixed by the feeds/levels reload+repull cron), DO NOT
// substitute a later/foreign value: leave it undefined so the DD<0.5 BZB M-tap skips (missing-open guard).
const openTs = ems('09:30');
const openRow = ctxRows.find((c: any) => c.ts_ms >= openTs - 5 * 60_000);
const lmOpenCode = openRow && openRow.ts_ms <= openTs + 30 * 60_000 ? (openRow.lm_code as string) : undefined;
const lmOpenZone: 'B' | 'MR' | 'Br' | undefined =
  !lmOpenCode ? undefined : lmOpenCode.startsWith('Br') ? 'Br' : lmOpenCode.startsWith('MR') ? 'MR' : lmOpenCode.startsWith('B') ? 'B' : undefined;
// First VALID context row — touches before this have no usable market state; skip them entirely.
// Two failure modes, both from the platform not reloading to populate the scanner/MASTER_TABLE fields:
//   (a) feed late → no rows at all (06-25: first row 11:28)
//   (b) PARTIAL dead-zero → rows exist (vx/LM live) but DD + all 3 resiliences stuck at exactly 0.0
//       (06-29: dead until 12:21). A real row never has dd AND mhp/hp/redist all exactly 0.
const isDeadCtx = (c: any) => c.dd_ratio === 0 && c.mhp_res === 0 && c.hp_res === 0 && c.redist_res === 0;
const firstCtxTs = ctxRows.find((c: any) => !isDeadCtx(c))?.ts_ms ?? Infinity;
const ctxGap = firstCtxTs > openTs + 30 * 60_000;
console.log(`  LM-open: ${lmOpenCode ?? 'MISSING (feed late → no open value)'} → zone ${lmOpenZone ?? 'n/a'}`);
console.log(`  first VALID context: ${Number.isFinite(firstCtxTs) ? ec(firstCtxTs) : 'NONE (dead all day)'}${ctxGap ? '  ⚠️ CONTEXT GAP — pre-feed/dead-zero touches skipped' : ''}`);

// ── output ───────────────────────────────────────────────────────────────────
const out = new Database(`${ROOT}/data/l2-touch.db`);
out.pragma('journal_mode = WAL');
out.exec(`CREATE TABLE IF NOT EXISTS l2_touches (
  id INTEGER PRIMARY KEY, trading_day TEXT, ts_ms INTEGER, ts_et TEXT, symbol TEXT,
  level_label TEXT, level_family TEXT, level_price REAL, pocket_top REAL, pocket_h REAL, tad TEXT,
  engine_gated INTEGER, skipped_single_pos INTEGER, engine_family TEXT, engine_dir TEXT, engine_size TEXT, engine_baseprob REAL, gate_mode TEXT,
  gm TEXT, dd_ratio REAL, lm_code TEXT, mhp_res REAL, hp_res REAL, redist_res REAL,
  vx REAL, bbb REAL, vvix REAL, qqq_spy_rs REAL, is_rational INTEGER, vx_vol_state TEXT, regime_class TEXT,
  cvd_60s REAL, leg_pts REAL, leg_secs REAL, leg_vel REAL, cvd_leg REAL,
  best_bid REAL, best_ask REAL, near_bid REAL, near_ask REAL, imbalance REAL, lambda REAL, lambda_r2 REAL,
  absorption TEXT, react_tradevol REAL, react_d_def REAL, aggr_ratio REAL, cvd_norm60 REAL,
  l2_decision TEXT, l2_score REAL,
  entry REAL, tp REAL, sl REAL, exit_ts INTEGER, exit_price REAL, outcome TEXT, pnl_pts REAL
);`);
// migrate: CREATE IF NOT EXISTS won't alter an existing table, so ADD COLUMN any schema additions.
{ const have = new Set((out.prepare(`PRAGMA table_info(l2_touches)`).all() as any[]).map((c: any) => c.name));
  for (const [c, t] of [['skipped_single_pos', 'INTEGER'], ['aggr_ratio', 'REAL'], ['cvd_norm60', 'REAL'], ['l2_decision', 'TEXT'], ['l2_score', 'REAL'], ['level_family', 'TEXT']] as const)
    if (!have.has(c)) out.exec(`ALTER TABLE l2_touches ADD COLUMN ${c} ${t}`); }
out.prepare(`DELETE FROM l2_touches WHERE trading_day=?`).run(DAY);  // per-day clear → days accumulate for Stage 2
const ins = out.prepare(`INSERT INTO l2_touches (
  trading_day,ts_ms,ts_et,symbol,level_label,level_family,level_price,pocket_top,pocket_h,tad,
  engine_gated,skipped_single_pos,engine_family,engine_dir,engine_size,engine_baseprob,gate_mode,
  gm,dd_ratio,lm_code,mhp_res,hp_res,redist_res,vx,bbb,vvix,qqq_spy_rs,is_rational,vx_vol_state,regime_class,
  cvd_60s,leg_pts,leg_secs,leg_vel,cvd_leg,best_bid,best_ask,near_bid,near_ask,imbalance,lambda,lambda_r2,
  absorption,react_tradevol,react_d_def,aggr_ratio,cvd_norm60,l2_decision,l2_score,
  entry,tp,sl,exit_ts,exit_price,outcome,pnl_pts
) VALUES (@trading_day,@ts_ms,@ts_et,@symbol,@level_label,@level_family,@level_price,@pocket_top,@pocket_h,@tad,
  @engine_gated,@skipped_single_pos,@engine_family,@engine_dir,@engine_size,@engine_baseprob,@gate_mode,
  @gm,@dd_ratio,@lm_code,@mhp_res,@hp_res,@redist_res,@vx,@bbb,@vvix,@qqq_spy_rs,@is_rational,@vx_vol_state,@regime_class,
  @cvd_60s,@leg_pts,@leg_secs,@leg_vel,@cvd_leg,@best_bid,@best_ask,@near_bid,@near_ask,@imbalance,@lambda,@lambda_r2,
  @absorption,@react_tradevol,@react_d_def,@aggr_ratio,@cvd_norm60,@l2_decision,@l2_score,
  @entry,@tp,@sl,@exit_ts,@exit_price,@outcome,@pnl_pts)`);
const updOutcome = out.prepare(`UPDATE l2_touches SET exit_ts=@exit_ts, exit_price=@exit_price, outcome=@outcome, pnl_pts=@pnl_pts WHERE id=@id`);

// ── stream ─────────────────────────────────────────────────────────────────────
const tdb = new Database(`${ROOT}/data/ticks.db`, { readonly: true });
// DETERMINISTIC total order: ts, then k (depth 'D' before trades 'T' at the same ms), then the
// per-table row id. Without the id tiebreak, same-ms rows return in arbitrary order across runs,
// making touch detection + single-position non-reproducible (BrZT2 came out 14/9/5 on 3 runs).
const rows = tdb.prepare(
  `SELECT ts,'D' k, side, price, size, id FROM depth WHERE symbol=? AND ts BETWEEN ? AND ?
   UNION ALL SELECT ts,'T', is_bid_aggressor, price, size, id FROM trades WHERE symbol=? AND size>0 AND ts BETWEEN ? AND ?
   ORDER BY ts, k, id`).iterate(SYM, WARM, RTH_END, SYM, WARM, RTH_END) as IterableIterator<any>;

const book = new CqgL2Book(TICK);
const qbuf: { ts: number; q: Quote }[] = [];
const tape: { ts: number; price: number; size: number; buy: boolean }[] = [];
let lastQ = '', lastQts = 0, lastRing = 0, last = NaN, curMin = -1, curOpen = NaN, rthOpen = NaN;
const touchedMin = new Set<string>();
const openLevels = new Set<string>();       // single-position per level: skip touches while a trade is live
const nearRing = new Map<string, { ts: number; nb: number; na: number }[]>();  // per-level near-size history (~1s) for absorption Δ
touchLevels.forEach((L: any) => nearRing.set(L.label, []));
type Open = { id: number; label: string; dir: string; tp: number; sl: number; entry: number };
const opens: Open[] = [];
const cvdWin = (a: number, b: number) => tape.reduce((s, t) => (t.ts > a && t.ts <= b ? s + (t.buy ? t.size : -t.size) : s), 0);
const grossWin = (a: number, b: number) => tape.reduce((s, t) => (t.ts > a && t.ts <= b ? s + t.size : s), 0);  // |volume| for normalization
const matchSetup = (setups: Setup[], lv: number): Setup | null => {
  const c = setups.filter(s => Math.abs(s.level - lv) <= MATCH).sort((a, b) => Math.abs(a.level - lv) - Math.abs(b.level - lv));
  return c[0] ?? null;
};
function regimeClass(ts: number): string {
  const w = tape.filter(t => t.ts >= ts - 300_000 && t.ts <= ts); if (w.length < 20) return 'unknown';
  // NB: loop, not Math.max(...px) — a dense 5-min tape (busy day) overflows the spread arg limit.
  let hi = -Infinity, lo = Infinity;
  for (const t of w) { if (t.price > hi) hi = t.price; if (t.price < lo) lo = t.price; }
  const first = w[0]!.price, lastP = w[w.length - 1]!.price, rng = hi - lo;
  const eff = rng > 0 ? Math.abs(lastP - first) / rng : 0;
  const vel = Math.abs(lastP - first) / ((w[w.length - 1]!.ts - w[0]!.ts) / 1000 + 1);
  return vel > 0.5 && eff > 0.6 ? 'flush' : eff > 0.5 ? 'trend' : 'camp';
}

for (const r of rows) {
  const ts = Number(r.ts), k = r.k, a = Number(r.side), price = Number(r.price), size = Number(r.size);
  book.lastTs = ts;
  if (k === 'D') book.applyDepth(a === 0 ? 'bid' : 'ask', book.intFromPrice(price), size);
  else { book.applyTrade(size, a === 1); tape.push({ ts, price, size, buy: a === 1 }); if (tape.length > 200000) tape.shift(); }
  // λ quote sampling — THROTTLED to QUOTE_SAMPLE_MS (was per-event/full-res = 6m48; λ is weak so coarse is fine),
  // and still push only when the best quote actually changed.
  if (ts - lastQts >= QUOTE_SAMPLE_MS) {
    lastQts = ts;
    const q = book.quote(); if (q) { const key = `${q.bidPx}:${q.bidSz}:${q.askPx}:${q.askSz}`; if (key !== lastQ) { lastQ = key; qbuf.push({ ts, q }); if (qbuf.length > 12000) qbuf.shift(); } }
  }
  // per-level near-size history (~1s) for the absorption Δ
  if (ts - lastRing >= 1000) {
    lastRing = ts;
    for (const L of touchLevels) { if (Math.abs(price - L.lv) > 80) continue; const li = book.intFromPrice(L.lv); const r = nearRing.get(L.label)!; r.push({ ts, nb: book.depthNear(li, NEAR, 'bid'), na: book.depthNear(li, NEAR, 'ask') }); if (r.length > 900) r.shift(); }
  }
  if (k !== 'T') continue;
  if (Number.isNaN(rthOpen) && ts >= ems('09:30')) rthOpen = price;

  // resolve open trades on this tick
  for (let i = opens.length - 1; i >= 0; i--) {
    const o = opens[i]!; const tp = o.dir === 'long' ? price >= o.tp : price <= o.tp; const sl = o.dir === 'long' ? price <= o.sl : price >= o.sl;
    if (tp || sl) { const xp = tp ? o.tp : o.sl; updOutcome.run({ id: o.id, exit_ts: ts, exit_price: xp, outcome: tp ? 'WIN' : 'LOSS', pnl_pts: +((o.dir === 'long' ? xp - o.entry : o.entry - xp)).toFixed(2) }); openLevels.delete(o.label); opens.splice(i, 1); }
  }

  const mb = Math.floor(ts / 60000);
  if (mb !== curMin) { curMin = mb; curOpen = price; touchedMin.clear(); }
  if (ts < Math.max(LO, firstCtxTs) || Number.isNaN(last)) { last = price; continue; }  // skip pre-feed touches (no valid market state)

  for (const L of touchLevels) {
    const key = `${mb}|${L.label}`;
    if (touchedMin.has(key)) continue;
    if ((last - L.lv) * (price - L.lv) >= 0 && price !== L.lv) continue;
    touchedMin.add(key);
    const live = openLevels.has(L.label);         // a trade is already live at this level (single-position)
    // capture-all-touches: still evaluate + log this touch; only the TRADE is gated by single-position.
    // ── ENGINE GATE ──
    const ctxRow = ctxAt(ts); const rs = buildRs(ctxRow);
    const ms = deriveMarketState({ symbol: SYM, rs, levels, price, open: rthOpen, barOpen: curOpen, lmOpenZone });
    let setups: Setup[] = [];
    try { setups = [...annotateWithLm(ms, evaluateEst(ms)), ...evaluateRdz(ms), ...evaluateDdBands(ms), ...evaluateBullBearZone(ms)]; } catch { setups = []; }
    const th = matchSetup(setups, L.lv);
    const fromUp = curOpen > L.lv;
    const li = book.intFromPrice(L.lv);
    const nb = book.depthNear(li, NEAR, 'bid'), na = book.depthNear(li, NEAR, 'ask');
    const lam = kyleLambda(qbuf.filter(x => x.ts >= ts - LAMBDA_WIN && x.ts <= ts).map(x => x.q));
    // ABSORPTION (causal, trailing 30s): defending-bid Δ vs trade-volume AT the level.
    //   absorb = traded but size held/refilled (real defense) · pull = size left faster than it
    //   traded (spoof/cancel) · refill = size grew on low volume · neutral = no signal.
    const ring = nearRing.get(L.label)!;
    let nbAgo: number | null = null; for (const e of ring) { if (e.ts <= ts - 30000) nbAgo = e.nb; else break; }
    // reaction-window (30s) aggressor split AT the level → aggr_ratio = buy% of fought volume [0,1].
    // INHERENTLY RELATIVE (a fraction), so it generalizes across days; no baseline, no hard threshold.
    let buyNear = 0, sellNear = 0;
    for (const t of tape) { if (t.ts > ts - 30000 && t.ts <= ts && Math.abs(t.price - L.lv) <= NEAR * TICK) { if (t.buy) buyNear += t.size; else sellNear += t.size; } }
    const reactTradevol = buyNear + sellNear;
    const aggrRatio = reactTradevol > 0 ? +(buyNear / reactTradevol).toFixed(3) : null;
    const reactDdef = nbAgo == null ? null : nb - nbAgo;
    let absorption = 'neutral';  // RETAINED for reference only — Stage 2 showed it's a coin flip; decider no longer uses it
    if (reactDdef != null) {
      if (reactTradevol > 0 && reactDdef >= 0) absorption = 'absorb';
      else if (reactDdef < 0 && reactTradevol < -reactDdef) absorption = 'pull';
      else if (reactDdef > 0) absorption = 'refill';
    }
    let legPx = last, legTs = ts; for (const t of tape) { if (t.ts < ts - APPROACH_LB || t.ts > ts) continue; if (fromUp ? t.price > legPx : t.price < legPx) { legPx = t.price; legTs = t.ts; } }
    const q0 = book.quote();
    // shared feature vars (reused by the row AND the Stage-3 decider)
    const imbVal = nb + na > 0 ? +(nb / (nb + na)).toFixed(3) : null;
    const cvd60 = cvdWin(ts - 60000, ts);
    const gross60 = grossWin(ts - 60000, ts);
    const cvdNorm60 = gross60 > 0 ? +(cvd60 / gross60).toFixed(3) : null;  // net/gross flow [-1,1], scale-free
    const cvdLeg = cvdWin(legTs, ts);
    const legVel = +(Math.abs(price - legPx) / ((ts - legTs) / 1000 + 1)).toFixed(3);
    const rclass = regimeClass(ts);
    // ── STAGE-3 L2 DECIDER (confirm/veto the engine direction) ──
    // All inputs are INHERENTLY RELATIVE (bounded ratios) — no absorption (coin flip per Stage 2),
    // no hard magnitudes (those fail OOS). Recorded for every engine-approved touch (incl. SKIP_POS).
    let verdict: ReturnType<typeof l2Decide> | null = null;
    if (th) {
      verdict = l2Decide({
        engineDir: th.direction as 'long' | 'short',
        aggrRatio, cvdNorm: cvdNorm60, imbalance: imbVal, regimeClass: rclass,
      }, { setupClass: setupClassOf(L.family) });   // per-family decider calibration (pocket vs line)
    }
    const row: any = {
      trading_day: DAY, ts_ms: ts, ts_et: ec(ts), symbol: SYM, level_label: L.label, level_family: L.family, level_price: L.lv,
      pocket_top: L.pocketTop, pocket_h: L.H, tad: fromUp ? 'FROM_UP' : 'FROM_BELOW',
      engine_gated: th ? 1 : 0, skipped_single_pos: live ? 1 : 0, engine_family: th?.family ?? null, engine_dir: th?.direction ?? null,
      engine_size: th?.sizeTier ?? null, engine_baseprob: th?.baseProb ?? null, gate_mode: ms.gate.mode,
      gm: ctxRow?.gm ?? null, dd_ratio: ctxRow?.dd_ratio ?? null, lm_code: ctxRow?.lm_code ?? null,
      mhp_res: ctxRow?.mhp_res ?? null, hp_res: ctxRow?.hp_res ?? null, redist_res: ctxRow?.redist_res ?? null,
      vx: ctxRow?.vx ?? null, bbb: ctxRow?.bbb ?? null, vvix: ctxRow?.vvix ?? null, qqq_spy_rs: ctxRow?.qqq_spy_rs ?? null,
      is_rational: ctxRow?.is_rational ?? null, vx_vol_state: ctxRow?.vx_vol_state ?? null, regime_class: regimeClass(ts),
      cvd_60s: cvd60, leg_pts: +(price - legPx).toFixed(2), leg_secs: +((ts - legTs) / 1000).toFixed(1),
      leg_vel: legVel, cvd_leg: cvdLeg,
      best_bid: q0?.bidPx ?? null, best_ask: q0?.askPx ?? null, near_bid: nb, near_ask: na,
      imbalance: imbVal, lambda: lam?.lambda ?? null, lambda_r2: lam?.r2 ?? null,
      absorption, react_tradevol: reactTradevol, react_d_def: reactDdef, aggr_ratio: aggrRatio, cvd_norm60: cvdNorm60,
      l2_decision: verdict?.decision ?? null, l2_score: verdict?.score ?? null,
      entry: null, tp: null, sl: null, exit_ts: null, exit_price: null,
      outcome: !th ? 'GATED' : live ? 'SKIP_POS' : USE_DECIDER && verdict!.decision === 'VETO' ? 'L2_VETO' : null,
      pnl_pts: null,
    };
    const info = ins.run(row);
    // open a trade only when: engine approved AND flat AND (decider off OR decider confirms).
    // Under --decider a VETO frees the single-position slot, so a later touch can take the trade.
    if (th && !live && (!USE_DECIDER || verdict!.decision === 'CONFIRM')) {
      const dir = th.direction;
      const entry = dir === 'long' ? +(L.lv + SLIP).toFixed(2) : +(L.lv - SLIP).toFixed(2);
      // Fixed bracket: TP = level ± 40 (pocket-top for an LP), SL = level ∓ 40. Nearest-engine-target exits
      // tested worse (dense levels clipped wins early; −541 vs −295) — dropped 2026-06-30 per Ravi.
      const tp = L.pocketTop != null && dir === 'long' ? L.pocketTop : dir === 'long' ? +(L.lv + TP_CAP).toFixed(2) : +(L.lv - TP_CAP).toFixed(2);
      const sl = dir === 'long' ? +(L.lv - SL_PTS).toFixed(2) : +(L.lv + SL_PTS).toFixed(2);
      out.prepare(`UPDATE l2_touches SET entry=?,tp=?,sl=? WHERE id=?`).run(entry, tp, sl, info.lastInsertRowid);
      opens.push({ id: Number(info.lastInsertRowid), label: L.label, dir, tp, sl, entry });
      openLevels.add(L.label);
    }
  }
  last = price;
}
const q1 = (s: string) => (out.prepare(`SELECT COUNT(*) c FROM l2_touches WHERE trading_day=? AND ${s}`).get(DAY) as any).c;
const sumPnl = (s: string) => (out.prepare(`SELECT COALESCE(SUM(pnl_pts),0) p FROM l2_touches WHERE trading_day=? AND ${s}`).get(DAY) as any).p;
const tot = q1('1=1'), traded = q1('entry IS NOT NULL'), skip = q1('skipped_single_pos=1'), gatedOut = q1('engine_gated=0');
const w = q1("outcome='WIN'"), l = q1("outcome='LOSS'"), op = q1('outcome IS NULL');
const wr = (a: number, b: number) => (a + b ? Math.round(100 * a / (a + b)) : 0);
console.log(`\nStage 1 (capture-ALL-touches; trades single-position, 40pt SL${USE_DECIDER ? '; +L2 DECIDER gating' : ''}) — ${DAY} ${SYM}`);
console.log(`  touches captured: ${tot}  = TRADED ${traded} + SKIP_POS ${skip} + GATED ${gatedOut}${USE_DECIDER ? ` + L2_VETO ${q1("outcome='L2_VETO'")}` : ''}`);
console.log(`  traded → WIN ${w} / LOSS ${l} / OPEN ${op}   WR ${wr(w, l)}%   PnL ${(+sumPnl("outcome IN ('WIN','LOSS')")).toFixed(1)}pt`);
// Stage-3 comparison: WITHIN the actually-traded rows, how the decider verdict splits W/L.
// If VETO concentrates losers, engine+decider (taking only CONFIRM) beats engine-alone.
const tw = (d: string, o: string) => q1(`entry IS NOT NULL AND l2_decision='${d}' AND outcome='${o}'`);
const cW = tw('CONFIRM', 'WIN'), cL = tw('CONFIRM', 'LOSS'), vW = tw('VETO', 'WIN'), vL = tw('VETO', 'LOSS');
const cP = (+sumPnl("entry IS NOT NULL AND l2_decision='CONFIRM' AND outcome IN ('WIN','LOSS')")).toFixed(1);
console.log(`\n  L2-decider on traded rows (engine-alone vs engine+decider):`);
console.log(`    engine-alone (all traded):  W ${w} / L ${l}   WR ${wr(w, l)}%   PnL ${(+sumPnl("outcome IN ('WIN','LOSS')")).toFixed(1)}pt`);
console.log(`    CONFIRM (decider keeps):    W ${cW} / L ${cL}   WR ${wr(cW, cL)}%   PnL ${cP}pt`);
console.log(`    VETO    (decider drops):    W ${vW} / L ${vL}   ${vW + vL ? `(dropped ${vL} losers / ${vW} winners)` : '(none)'}`);
console.log(`\n  (06-26: ONE day, n=${w + l} trades — sanity/mechanism only, NOT validation. Decider is principle-coded,`);
console.log(`   not fit to outcomes; real test = multi-day OOS [Stage 2]. irrational-panel gate inert pre-06-29 (#14).)`);
process.exit(0);
