// l2_touch_resolve.ts — Stage 1 pass 2: fill reaction/confirm/outcome on l2_touches.
// For each captured touch, walk FORWARD (causal) on CQG ticks:
//   • confirm = arm at touch, track to the flow-flip tick (price back ≥ level AND cvd-since-touch
//     > 0 within REACT_MAX) → that's the entry; contested if price breaks (level-REACT_BAND) first
//     or no flip within REACT_MAX.
//   • absorption (descriptive) = Δnear_bid vs trade-volume-at-level over the reaction window.
//   • outcome (if confirmed) = enter at confirm+slip, pocket-scaled bracket (TP=pocket top,
//     SL=level-0.3H; fallback 40/12 if no pocket), walk to TP/SL → WIN/LOSS, pnl_pts. No MFE/MAE.
// Targeted per-touch range queries (index-served) — no full-day re-stream.
// Run: tsx scripts/l2_touch_resolve.ts 2026-06-26
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const DAY = process.argv[2] ?? '2026-06-26';
const SYM = 'NQ', TICK = 0.25, NEAR = 8;
const REACT_MAX = 120_000;   // window to find the confirm tick
const REACT_BAND = 12;       // price below (level-band) before confirm = contested/broke
const OUT_HORIZON = 60 * 60_000; // max walk to TP/SL (else OPEN)
const SLOWFRAC = 0.3, TP_CAP = 40, SL_FALLBACK = 12, SLIP = 5;

const out = new Database(`${ROOT}/data/l2-touch.db`);
const tdb = new Database(`${ROOT}/data/ticks.db`, { readonly: true });
const touches = out.prepare(`SELECT * FROM l2_touches WHERE trading_day=? AND symbol=? ORDER BY ts_ms`).all(DAY, SYM) as any[];
const upd = out.prepare(`UPDATE l2_touches SET
  confirmed=@confirmed, confirm_ts=@confirm_ts, confirm_lag_ms=@confirm_lag_ms, cvd_at_confirm=@cvd_at_confirm,
  absorption=@absorption, react_d_nearbid=@react_d_nearbid, react_tradevol=@react_tradevol,
  entry=@entry, tp=@tp, sl=@sl, exit_ts=@exit_ts, exit_price=@exit_price, outcome=@outcome, pnl_pts=@pnl_pts
  WHERE id=@id`);

const tradesStmt = tdb.prepare(`SELECT ts, price, size, is_bid_aggressor FROM trades WHERE symbol=? AND size>0 AND ts BETWEEN ? AND ? ORDER BY ts, id`);
const depthStmt = tdb.prepare(`SELECT ts, side, price, size FROM depth WHERE symbol=? AND side=0 AND price BETWEEN ? AND ? AND ts BETWEEN ? AND ? ORDER BY ts`);

let win = 0, loss = 0, contested = 0, open = 0;
for (const t of touches) {
  const lv = t.level_price as number, ts0 = t.ts_ms as number;
  const pocketTop = t.pocket_top as number | null, H = t.pocket_h as number | null;
  // ── confirm: walk trades in the reaction window ──
  const rtrades = tradesStmt.all(SYM, ts0, ts0 + REACT_MAX) as any[];
  let cvd = 0, confirmTs: number | null = null, confirmPx = 0, cvdAtConfirm = 0, contestedFlag = false;
  for (const r of rtrades) {
    const p = Number(r.price); cvd += Number(r.size) * (Number(r.is_bid_aggressor) === 1 ? 1 : -1);
    if (p <= lv - REACT_BAND) { contestedFlag = true; break; }     // broke down first
    if (p >= lv && cvd > 0) { confirmTs = Number(r.ts); confirmPx = p; cvdAtConfirm = cvd; break; } // flow flipped up & holding
  }
  // ── absorption (descriptive): near-bid at touch vs end of reaction window + trade-vol at level ──
  const winEnd = confirmTs ?? ts0 + REACT_MAX;
  const dRows = depthStmt.all(SYM, lv - NEAR * TICK, lv, ts0, winEnd) as any[];
  const bidAt = new Map<number, number>(); let nbStart = t.near_bid as number, nbEnd = t.near_bid as number, started = false;
  for (const d of dRows) { const pi = Math.round(Number(d.price) / TICK); if (Number(d.size) <= 0) bidAt.delete(pi); else bidAt.set(pi, Number(d.size));
    let s = 0; for (const v of bidAt.values()) s += v; if (!started) { nbStart = s; started = true; } nbEnd = s; }
  const tvol = rtrades.reduce((s, r) => s + (Math.abs(Number(r.price) - lv) <= NEAR * TICK ? Number(r.size) : 0), 0);
  const dNb = +(nbEnd - nbStart).toFixed(0);
  const absorption = tvol > 0 && dNb >= 0 ? 'absorb' : dNb < 0 && tvol < (t.near_bid as number) ? 'pull' : dNb > 0 ? 'refill' : 'neutral';

  let rec: any = {
    id: t.id, confirmed: confirmTs ? 1 : 0, confirm_ts: confirmTs, confirm_lag_ms: confirmTs ? confirmTs - ts0 : null,
    cvd_at_confirm: confirmTs ? cvdAtConfirm : null, absorption, react_d_nearbid: dNb, react_tradevol: tvol,
    entry: null, tp: null, sl: null, exit_ts: null, exit_price: null, outcome: null, pnl_pts: null,
  };
  if (!confirmTs) { rec.outcome = 'CONTESTED'; contested++; upd.run(rec); continue; }

  // ── outcome: enter at confirm+slip (long), pocket-scaled bracket, walk to TP/SL ──
  const entry = +(confirmPx + SLIP).toFixed(2);
  const tp = pocketTop != null ? pocketTop : +(lv + TP_CAP).toFixed(2);
  const sl = H != null ? +(lv - SLOWFRAC * H).toFixed(2) : +(lv - SL_FALLBACK).toFixed(2);
  const otrades = tradesStmt.all(SYM, confirmTs, confirmTs + OUT_HORIZON) as any[];
  let exitTs: number | null = null, exitPx = 0, outcome = 'OPEN';
  for (const r of otrades) { const p = Number(r.price);
    if (p >= tp) { exitTs = Number(r.ts); exitPx = tp; outcome = 'WIN'; break; }
    if (p <= sl) { exitTs = Number(r.ts); exitPx = sl; outcome = 'LOSS'; break; } }
  rec = { ...rec, entry, tp, sl, exit_ts: exitTs, exit_price: exitTs ? exitPx : null, outcome,
    pnl_pts: exitTs ? +(exitPx - entry).toFixed(2) : null };
  if (outcome === 'WIN') win++; else if (outcome === 'LOSS') loss++; else open++;
  upd.run(rec);
}
console.log(`\nStage 1 resolve — ${DAY} ${SYM}: ${touches.length} touches`);
console.log(`  confirmed→traded: WIN ${win} / LOSS ${loss} / OPEN ${open}  | CONTESTED (no confirm) ${contested}`);
console.log(`  confirm rate: ${Math.round(100*(win+loss+open)/touches.length)}%  WR(of resolved): ${win+loss?Math.round(100*win/(win+loss)):0}%`);
process.exit(0);
