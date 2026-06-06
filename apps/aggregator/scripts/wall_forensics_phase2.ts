// Phase 2 — explore HELD + CONTINUATION theses on today's MBO walls.
//
// Three views per wall:
//   1. FADE outcome (BROKEN only)        — against the break direction
//   2. CONTINUATION outcome (BROKEN only) — with the break direction
//   3. BOUNCE outcome (HELD only)         — wall held → trade away from wall
//
// All outcomes: TP=20 / SL=10 / 5min horizon, NQ tick proxy.
// Same wall definition as Phase 0+1.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

// Monkey-patch console.log to use synchronous writes — bypasses Node stdout pipe
// buffering so progress lines appear in real-time when redirected to a file.
const _origLog = console.log;
console.log = (...args: any[]) => {
  fs.writeSync(1, args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');
};
process.stdout.write = ((chunk: any, ...rest: any[]) => {
  fs.writeSync(1, typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
  return true;
}) as any;

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const MBO_DB = path.resolve(__dirname, '../../../data/mbo.db');
const TK_DB  = path.resolve(__dirname, '../../../data/ticks.db');

const SYMBOL          = 'MNQM';
const CONTRACT        = 'MNQM6_CME_BMD';
const MIN_PEAK        = 100;
const MIN_HOLD_MS     = 5_000;
const MIN_AGGRESSORS  = 10;
const ZOMBIE_MS       = 3_000;
const TP_PTS          = 20;
const SL_PTS          = 10;
const HORIZON_MS      = 5 * 60_000;
const DAY_START = 1780358400000;
const DAY_END   = 1780444800000;

const mbo = new Database(MBO_DB, { readonly: true });
const tk  = new Database(TK_DB,  { readonly: true });

function et(ts: number) { return new Date(ts - 4*60*60_000).toISOString().substring(11, 23); }
function pad(s: any, w: number, left = true) { const str = String(s); return left ? str.padStart(w) : str.padEnd(w); }

console.log('═══ Phase 2: HELD bounce + BROKEN continuation analysis ═══');
console.log(`MIN_PEAK=${MIN_PEAK}  MIN_HOLD_MS=${MIN_HOLD_MS}  MIN_AGGRESSORS=${MIN_AGGRESSORS}`);
console.log(`TP=${TP_PTS}  SL=${SL_PTS}  HORIZON=${HORIZON_MS/60_000}min\n`);

// ── ONE pass over events to build per-level state ───────────────────────
interface LevelState {
  price: number; is_bid: number;
  active: number; peak: number; peakTs: number;
  firstActiveTs: number; lastActiveTs: number;
  halfPeakStart: number | null; holdMsAtHalfPeak: number;
  drainTs: number | null;
  minActiveAfterPeak: number;        // for HELD analysis — how low did defense get?
  minActiveAfterPeakTs: number;
  hadFullDrain: boolean;
}
const levels = new Map<string, LevelState>();
const orderToKey = new Map<string, { key: string; size: number }>();

function getLvl(price: number, is_bid: number): LevelState {
  const key = `${price}|${is_bid}`;
  let lv = levels.get(key);
  if (!lv) {
    lv = {
      price, is_bid, active: 0, peak: 0, peakTs: 0,
      firstActiveTs: 0, lastActiveTs: 0,
      halfPeakStart: null, holdMsAtHalfPeak: 0, drainTs: null,
      minActiveAfterPeak: Infinity, minActiveAfterPeakTs: 0,
      hadFullDrain: false,
    };
    levels.set(key, lv);
  }
  return lv;
}
function updatePeakTracking(lv: LevelState, ts: number) {
  if (lv.active > lv.peak) { lv.peak = lv.active; lv.peakTs = ts; }
  if (lv.active > 0) {
    if (lv.firstActiveTs === 0) lv.firstActiveTs = ts;
    lv.lastActiveTs = ts;
  }
  if (lv.peak >= MIN_PEAK) {
    const halfPeak = lv.peak / 2;
    if (lv.active >= halfPeak) {
      if (lv.halfPeakStart === null) lv.halfPeakStart = ts;
      lv.holdMsAtHalfPeak = Math.max(lv.holdMsAtHalfPeak, ts - lv.halfPeakStart);
    } else {
      lv.halfPeakStart = null;
    }
    // Track minimum after peak for HELD bounce analysis
    if (ts > lv.peakTs && lv.active < lv.minActiveAfterPeak) {
      lv.minActiveAfterPeak = lv.active;
      lv.minActiveAfterPeakTs = ts;
    }
  }
  if (lv.active === 0 && lv.peak >= MIN_PEAK) {
    lv.hadFullDrain = true;
    if (lv.drainTs === null) lv.drainTs = ts;
  }
}

const t0 = Date.now();
const stmt = mbo.prepare(`
  SELECT ts_ms, kind, order_id, is_bid, price, size
  FROM mbo_events WHERE symbol=? AND contract=? AND ts_ms BETWEEN ? AND ?
  ORDER BY ts_ms ASC, id ASC
`);
let n = 0, lastReport = Date.now();
for (const row of stmt.iterate(SYMBOL, CONTRACT, DAY_START, DAY_END) as any) {
  const { ts_ms: ts, kind, order_id: oid, is_bid, price, size } = row;
  n++;
  if (n % 5_000_000 === 0 && Date.now() - lastReport > 2000) {
    console.log(`  ...${(n/1_000_000).toFixed(0)}M events  (${((Date.now()-t0)/1000).toFixed(0)}s)`);
    lastReport = Date.now();
  }
  if (kind === 'send') {
    const lv = getLvl(price, is_bid);
    lv.active += size;
    orderToKey.set(oid, { key: `${price}|${is_bid}`, size });
    updatePeakTracking(lv, ts);
  } else if (kind === 'replace') {
    const prev = orderToKey.get(oid);
    if (prev) {
      const prevLv = levels.get(prev.key);
      if (prevLv) { prevLv.active -= prev.size; updatePeakTracking(prevLv, ts); }
      const newLv = getLvl(price, is_bid);
      newLv.active += size;
      orderToKey.set(oid, { key: `${price}|${is_bid}`, size });
      updatePeakTracking(newLv, ts);
    } else {
      const lv = getLvl(price, is_bid);
      lv.active += size;
      orderToKey.set(oid, { key: `${price}|${is_bid}`, size });
      updatePeakTracking(lv, ts);
    }
  } else if (kind === 'cancel') {
    const prev = orderToKey.get(oid);
    if (prev) {
      const lv = levels.get(prev.key);
      if (lv) { lv.active -= prev.size; updatePeakTracking(lv, ts); }
      orderToKey.delete(oid);
    }
  }
}
console.log(`  Streamed ${n.toLocaleString()} events in ${((Date.now()-t0)/1000).toFixed(1)}s, ${levels.size.toLocaleString()} levels\n`);

// ── Filter to true walls + aggressors + state ──────────────────────────────
const aggrStmt = mbo.prepare(`
  SELECT COUNT(DISTINCT aggressor_order_id) as n_agg, COALESCE(SUM(size),0) as vol
  FROM mbo_trades WHERE symbol=? AND contract=? AND price=? AND ts_ms BETWEEN ? AND ?
`);
const zombieStmt = mbo.prepare(`
  SELECT COUNT(*) as n FROM mbo_events
  WHERE symbol=? AND contract=? AND is_bid=? AND price=?
    AND kind='send' AND ts_ms > ? AND ts_ms <= ?
`);

const trueWalls = Array.from(levels.values()).filter(
  lv => lv.peak >= MIN_PEAK && lv.holdMsAtHalfPeak >= MIN_HOLD_MS
);
const enriched: Array<any> = [];
for (const w of trueWalls) {
  const a = aggrStmt.get(SYMBOL, CONTRACT, w.price, w.firstActiveTs, w.lastActiveTs) as any;
  if ((a.n_agg ?? 0) < MIN_AGGRESSORS) continue;
  let state: 'BROKEN' | 'HELD' = 'HELD';
  if (w.drainTs !== null) {
    const z = zombieStmt.get(SYMBOL, CONTRACT, w.is_bid, w.price, w.drainTs, w.drainTs + ZOMBIE_MS) as any;
    state = z.n === 0 ? 'BROKEN' : 'HELD';
  }
  enriched.push({ ...w, nAggressors: a.n_agg, fillVol: a.vol, state });
}
const broken = enriched.filter(w => w.state === 'BROKEN');
const held   = enriched.filter(w => w.state === 'HELD');
console.log(`True walls: ${enriched.length} total (${held.length} HELD, ${broken.length} BROKEN)\n`);

// ── HELD wall characteristics ─────────────────────────────────────────────
console.log(`══ HELD wall characteristics (n=${held.length}) ══`);
function pct(arr: number[], p: number) {
  const sorted = [...arr].sort((a,b)=>a-b);
  return sorted[Math.floor(sorted.length * p)] ?? 0;
}
const peakArr = held.map(w => w.peak);
const aggArr  = held.map(w => w.nAggressors);
const fillArr = held.map(w => w.fillVol);
const holdArr = held.map(w => w.holdMsAtHalfPeak);
const defenseRatioArr = held.map(w => w.fillVol > 0 ? w.peak / w.fillVol : 0);
console.log(`  Peak size           — p10=${pct(peakArr,0.1)}  p50=${pct(peakArr,0.5)}  p90=${pct(peakArr,0.9)}  max=${Math.max(...peakArr)}`);
console.log(`  Aggressors attacking — p10=${pct(aggArr,0.1)}   p50=${pct(aggArr,0.5)}  p90=${pct(aggArr,0.9)}  max=${Math.max(...aggArr)}`);
console.log(`  Fill volume taken    — p10=${pct(fillArr,0.1)}  p50=${pct(fillArr,0.5)}  p90=${pct(fillArr,0.9)}  max=${Math.max(...fillArr)}`);
console.log(`  Hold ms @ half-peak  — p10=${(pct(holdArr,0.1)/1000).toFixed(0)}s  p50=${(pct(holdArr,0.5)/1000).toFixed(0)}s  p90=${(pct(holdArr,0.9)/1000).toFixed(0)}s  max=${(Math.max(...holdArr)/1000).toFixed(0)}s`);
console.log(`  Peak/Fill ratio      — p50=${pct(defenseRatioArr,0.5).toFixed(2)}  (lower = wall took more fills than its peak size = iceberg/refresh)`);
console.log(`  BID held: ${held.filter(w=>w.is_bid===1).length}   ASK held: ${held.filter(w=>w.is_bid===0).length}`);
console.log(`  Had full-drain-then-recovered (re-defended): ${held.filter(w=>w.hadFullDrain).length}`);

// ── Simulator for fade / continuation / bounce ─────────────────────────────
// iterate() lets us stream tick-by-tick and early-exit at first TP/SL hit.
// .all() loads up to 30K rows per wall × 426 walls = 13M rows = MINUTES of work.
const nqTrade = tk.prepare(`SELECT ts, price FROM trades WHERE symbol='NQ' AND ts BETWEEN ? AND ? ORDER BY ts ASC`);
const nqAt    = tk.prepare(`SELECT price FROM trades WHERE symbol='NQ' AND ABS(ts - ?) < 500 ORDER BY ABS(ts - ?) ASC LIMIT 1`);

function walkOutcome(entryTs: number, entryPx: number, dir: 1|-1): 'WIN'|'LOSS'|'OPEN' {
  const tp = entryPx + dir * TP_PTS;
  const sl = entryPx - dir * SL_PTS;
  for (const row of nqTrade.iterate(entryTs, entryTs + HORIZON_MS) as any) {
    const hitTP = dir === 1 ? row.price >= tp : row.price <= tp;
    const hitSL = dir === 1 ? row.price <= sl : row.price >= sl;
    if (hitTP) return 'WIN';
    if (hitSL) return 'LOSS';
  }
  return 'OPEN';
}

// ── Analyze BROKEN walls — fade vs continuation ───────────────────────────
console.log(`\n══ BROKEN walls (n=${broken.length}) — FADE vs CONTINUATION ══`);
let fadeWin=0, fadeLoss=0, fadeOpen=0;
let contWin=0, contLoss=0, contOpen=0;
let evaluated = 0;
const bkRows: any[] = [];
for (const w of broken.sort((a,b) => (a.drainTs ?? 0) - (b.drainTs ?? 0))) {
  if (w.drainTs === null) continue;
  const m = nqAt.get(w.drainTs, w.drainTs) as { price: number } | undefined;
  if (!m) continue;
  evaluated++;
  // FADE direction: BID broken → LONG (dir=+1); ASK broken → SHORT (dir=-1)
  const fadeDir: 1|-1 = w.is_bid === 1 ? 1 : -1;
  // CONTINUATION direction: opposite
  const contDir: 1|-1 = -fadeDir as 1|-1;

  const fadeOut = walkOutcome(w.drainTs, m.price, fadeDir);
  const contOut = walkOutcome(w.drainTs, m.price, contDir);

  if (fadeOut === 'WIN') fadeWin++; else if (fadeOut === 'LOSS') fadeLoss++; else fadeOpen++;
  if (contOut === 'WIN') contWin++; else if (contOut === 'LOSS') contLoss++; else contOpen++;
  bkRows.push({ w, mkt: m.price, fadeOut, contOut });
}
const fadeClosed = fadeWin + fadeLoss;
const contClosed = contWin + contLoss;
console.log(`  Evaluated:           ${evaluated} (had NQ ticks)`);
console.log(`  FADE outcomes:       WIN=${fadeWin}  LOSS=${fadeLoss}  OPEN=${fadeOpen}   WR=${fadeClosed>0?(fadeWin/fadeClosed*100).toFixed(1):'—'}%`);
console.log(`  CONTINUATION outc.:  WIN=${contWin}  LOSS=${contLoss}  OPEN=${contOpen}   WR=${contClosed>0?(contWin/contClosed*100).toFixed(1):'—'}%`);
console.log(`  Expectancy (TP=20/SL=10 → break-even WR=33.3%):`);
console.log(`    FADE expectancy:        ${fadeClosed>0?((fadeWin*TP_PTS - fadeLoss*SL_PTS)/fadeClosed).toFixed(1):'—'} pts/trade`);
console.log(`    CONTINUATION expectancy:${contClosed>0?((contWin*TP_PTS - contLoss*SL_PTS)/contClosed).toFixed(1):'—'} pts/trade`);

// ── Analyze HELD walls — bounce thesis ────────────────────────────────────
console.log(`\n══ HELD walls (n=${held.length}) — BOUNCE thesis ══`);
console.log(`  Entry timing = minActiveAfterPeakTs (moment of deepest assault that didn't break).`);
console.log(`  Direction: BID held → LONG (bounce up from support).  ASK held → SHORT (bounce down from resistance).\n`);
let bWin=0, bLoss=0, bOpen=0, bEval=0, bSkip=0;
const heldRows: any[] = [];

// Sort by aggressor count desc and evaluate ALL — but progress-log every 25 walls
const heldByAttack = [...held].sort((a, b) => b.nAggressors - a.nAggressors);
process.stdout.write(`  Evaluating ${heldByAttack.length} HELD walls (sorted by attack strength)...\n`);
const tBounce = Date.now();
let idx = 0;
for (const w of heldByAttack) {
  idx++;
  if (idx % 25 === 0) {
    process.stdout.write(`    ...${idx}/${heldByAttack.length}  (${((Date.now()-tBounce)/1000).toFixed(0)}s elapsed)\n`);
  }
  if (w.minActiveAfterPeakTs === 0) { bSkip++; continue; }
  const m = nqAt.get(w.minActiveAfterPeakTs, w.minActiveAfterPeakTs) as { price: number } | undefined;
  if (!m) { bSkip++; continue; }
  bEval++;
  const dir: 1|-1 = w.is_bid === 1 ? 1 : -1;
  const out = walkOutcome(w.minActiveAfterPeakTs, m.price, dir);
  if (out === 'WIN') bWin++; else if (out === 'LOSS') bLoss++; else bOpen++;
  heldRows.push({ w, mkt: m.price, out });
}
process.stdout.write(`  Done in ${((Date.now()-tBounce)/1000).toFixed(0)}s\n`);
const bClosed = bWin + bLoss;
console.log(`  Evaluated:    ${bEval}  (skipped ${bSkip} for missing tick/no-attack-min)`);
console.log(`  BOUNCE:       WIN=${bWin}  LOSS=${bLoss}  OPEN=${bOpen}   WR=${bClosed>0?(bWin/bClosed*100).toFixed(1):'—'}%`);
console.log(`  BOUNCE expectancy (TP=20/SL=10): ${bClosed>0?((bWin*TP_PTS - bLoss*SL_PTS)/bClosed).toFixed(1):'—'} pts/trade`);

// Break down by side
const bidHeld = heldRows.filter(r => r.w.is_bid === 1);
const askHeld = heldRows.filter(r => r.w.is_bid === 0);
function tally(rs: any[]) {
  const w = rs.filter(r=>r.out==='WIN').length;
  const l = rs.filter(r=>r.out==='LOSS').length;
  const c = w + l;
  return { w, l, c, wr: c > 0 ? (w/c*100).toFixed(1) : '—', exp: c > 0 ? ((w*TP_PTS - l*SL_PTS)/c).toFixed(1) : '—' };
}
const bid = tally(bidHeld);
const ask = tally(askHeld);
console.log(`  By side:`);
console.log(`    BID held → LONG bounce: n=${bidHeld.length}  W=${bid.w} L=${bid.l}  WR=${bid.wr}%  exp=${bid.exp} pts`);
console.log(`    ASK held → SHORT bounce: n=${askHeld.length}  W=${ask.w} L=${ask.l}  WR=${ask.wr}%  exp=${ask.exp} pts`);

// ── Summary table ─────────────────────────────────────────────────────────
console.log(`\n══ Three strategies compared ══`);
console.log(`  Strategy            | Pop.   | WIN   LOSS  | WR      | Exp /trade`);
console.log(`  ────────────────────|────────|─────────────|─────────|───────────`);
console.log(`  FADE (broken)       | ${pad(fadeClosed,5)}  | ${pad(fadeWin,4)}  ${pad(fadeLoss,4)}   | ${pad(fadeClosed>0?(fadeWin/fadeClosed*100).toFixed(1)+'%':'—',6)}  | ${pad(fadeClosed>0?((fadeWin*TP_PTS-fadeLoss*SL_PTS)/fadeClosed).toFixed(1):'—',5)} pts`);
console.log(`  CONTINUATION(broken)| ${pad(contClosed,5)}  | ${pad(contWin,4)}  ${pad(contLoss,4)}   | ${pad(contClosed>0?(contWin/contClosed*100).toFixed(1)+'%':'—',6)}  | ${pad(contClosed>0?((contWin*TP_PTS-contLoss*SL_PTS)/contClosed).toFixed(1):'—',5)} pts`);
console.log(`  BOUNCE (held)       | ${pad(bClosed,5)}  | ${pad(bWin,4)}  ${pad(bLoss,4)}   | ${pad(bClosed>0?(bWin/bClosed*100).toFixed(1)+'%':'—',6)}  | ${pad(bClosed>0?((bWin*TP_PTS-bLoss*SL_PTS)/bClosed).toFixed(1):'—',5)} pts`);

console.log(`\nDone.`);
