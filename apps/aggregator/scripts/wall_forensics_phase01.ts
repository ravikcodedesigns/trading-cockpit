// MBO Wall Forensics — Phase 0 + 1  (single-pass version)
//
// PHASE 0: Define "true wall" in MBO terms.
//   TRUE WALL = a (price, is_bid) level on MNQM6 where:
//     1. Peak active size (sum of all simultaneously-resting orders at that level)
//        reached ≥ MIN_PEAK contracts
//     2. Sustained ≥ MIN_HOLD_MS at ≥ MIN_PEAK/2 (defended)
//     3. Was actually attacked: ≥ MIN_AGGRESSORS aggressor orders hit it
//
//   BROKEN = active size went to 0 after being attacked, AND no new orders
//            posted at the level within ZOMBIE_MS afterward
//
// PHASE 1: Survey + classify + measure post-break price action. Read-only.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const DAY_START = 1780358400000;
const DAY_END   = 1780444800000;

const mbo = new Database(MBO_DB, { readonly: true });
const tk  = new Database(TK_DB,  { readonly: true });

function et(ts: number): string {
  return new Date(ts - 4*60*60_000).toISOString().substring(11, 23);
}
function pad(s: any, w: number, left = true): string {
  const str = String(s);
  return left ? str.padStart(w) : str.padEnd(w);
}

console.log('═══ Phase 0/1: True-Wall Survey for MNQM6 today ═══');
console.log(`MIN_PEAK=${MIN_PEAK}  MIN_HOLD_MS=${MIN_HOLD_MS}  MIN_AGGRESSORS=${MIN_AGGRESSORS}`);

// ── ONE pass over all events, maintaining per-level state in memory ─────────
interface LevelState {
  price: number; is_bid: number;
  active: number;
  peak: number;
  peakTs: number;
  firstActiveTs: number;
  lastActiveTs: number;
  halfPeakStart: number | null;
  holdMsAtHalfPeak: number;
  drainTs: number | null;
  nSend: number;
  nCancel: number;
  nReplace: number;
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
      halfPeakStart: null, holdMsAtHalfPeak: 0,
      drainTs: null, nSend: 0, nCancel: 0, nReplace: 0,
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
  }
  if (lv.active === 0 && lv.drainTs === null && lv.peak >= MIN_PEAK) {
    lv.drainTs = ts;
  }
}

const t0 = Date.now();
// better-sqlite3 iterate() lets us stream rows without buffering all in memory
const stmt = mbo.prepare(`
  SELECT ts_ms, kind, order_id, is_bid, price, size
  FROM mbo_events
  WHERE symbol = ? AND contract = ? AND ts_ms BETWEEN ? AND ?
  ORDER BY ts_ms ASC, id ASC
`);
let n = 0;
let lastReport = Date.now();
for (const row of stmt.iterate(SYMBOL, CONTRACT, DAY_START, DAY_END) as any) {
  const { ts_ms: ts, kind, order_id: oid, is_bid, price, size } = row;
  n++;
  if (n % 1_000_000 === 0 && Date.now() - lastReport > 2000) {
    console.log(`  ...streamed ${(n/1_000_000).toFixed(1)}M events  (${((Date.now()-t0)/1000).toFixed(0)}s elapsed, ${levels.size} levels)`);
    lastReport = Date.now();
  }

  if (kind === 'send') {
    const lv = getLvl(price, is_bid);
    lv.active += size;
    lv.nSend++;
    orderToKey.set(oid, { key: `${price}|${is_bid}`, size });
    updatePeakTracking(lv, ts);
  } else if (kind === 'replace') {
    const prev = orderToKey.get(oid);
    if (prev) {
      const [prevPrice, prevIsBid] = prev.key.split('|');
      const prevLv = levels.get(prev.key);
      if (prevLv) {
        prevLv.active -= prev.size;
        prevLv.nReplace++;
        updatePeakTracking(prevLv, ts);
      }
      // The replace may be at a different price → switch level
      const newKey = `${price}|${is_bid}`;
      const newLv = getLvl(price, is_bid);
      newLv.active += size;
      updatePeakTracking(newLv, ts);
      orderToKey.set(oid, { key: newKey, size });
    } else {
      // Orphan replace — treat as send
      const lv = getLvl(price, is_bid);
      lv.active += size;
      orderToKey.set(oid, { key: `${price}|${is_bid}`, size });
      updatePeakTracking(lv, ts);
    }
  } else if (kind === 'cancel') {
    const prev = orderToKey.get(oid);
    if (prev) {
      const lv = levels.get(prev.key);
      if (lv) {
        lv.active -= prev.size;
        lv.nCancel++;
        updatePeakTracking(lv, ts);
      }
      orderToKey.delete(oid);
    }
  }
}
console.log(`\n  Streamed ${n.toLocaleString()} events in ${((Date.now()-t0)/1000).toFixed(1)}s`);
console.log(`  Active distinct (price, is_bid) levels in memory: ${levels.size.toLocaleString()}`);

// ── Filter to TRUE WALLS ──────────────────────────────────────────────────
const trueWalls = Array.from(levels.values()).filter(
  lv => lv.peak >= MIN_PEAK && lv.holdMsAtHalfPeak >= MIN_HOLD_MS
);
console.log(`\n  Levels passing peak (≥${MIN_PEAK}) + hold (≥${MIN_HOLD_MS}ms): ${trueWalls.length}`);

// ── Aggressor evidence per wall (one query per wall) ─────────────────────
const aggrStmt = mbo.prepare(`
  SELECT COUNT(DISTINCT aggressor_order_id) as n_agg,
         COALESCE(SUM(size), 0) as vol
  FROM mbo_trades
  WHERE symbol=? AND contract=? AND price=?
    AND ts_ms BETWEEN ? AND ?
`);

const enriched = trueWalls.map(lv => {
  const aggr = aggrStmt.get(SYMBOL, CONTRACT, lv.price, lv.firstActiveTs, lv.lastActiveTs) as
    { n_agg: number; vol: number };
  return { ...lv, nAggressors: aggr.n_agg, fillVol: aggr.vol };
}).filter(w => w.nAggressors >= MIN_AGGRESSORS);

console.log(`  After aggressor filter (≥${MIN_AGGRESSORS}):  ${enriched.length} TRUE WALLS\n`);

// ── Classify BROKEN vs HELD ───────────────────────────────────────────────
const zombieStmt = mbo.prepare(`
  SELECT COUNT(*) as n FROM mbo_events
  WHERE symbol=? AND contract=? AND is_bid=? AND price=?
    AND kind='send' AND ts_ms > ? AND ts_ms <= ?
`);
const classified = enriched.map(w => {
  let state: 'BROKEN' | 'HELD' = 'HELD';
  if (w.drainTs !== null) {
    const z = zombieStmt.get(SYMBOL, CONTRACT, w.is_bid, w.price, w.drainTs, w.drainTs + ZOMBIE_MS) as { n: number };
    state = z.n === 0 ? 'BROKEN' : 'HELD';
  }
  return { ...w, state };
});

const broken = classified.filter(w => w.state === 'BROKEN');
const held   = classified.filter(w => w.state === 'HELD');
const bid = classified.filter(w => w.is_bid === 1);
const ask = classified.filter(w => w.is_bid === 0);

console.log(`══ Phase 1 summary ══`);
console.log(`  Total true walls:      ${classified.length}`);
console.log(`  BID walls (support):   ${bid.length}  | broken: ${bid.filter(w=>w.state==='BROKEN').length}, held: ${bid.filter(w=>w.state==='HELD').length}`);
console.log(`  ASK walls (resistance):${ask.length}  | broken: ${ask.filter(w=>w.state==='BROKEN').length}, held: ${ask.filter(w=>w.state==='HELD').length}`);
console.log(`  Total BROKEN:          ${broken.length}`);
console.log(`  Total HELD:            ${held.length}`);
console.log(`\n  v1 detector emitted 21 fade signals today on NQ.`);
console.log(`  MBO (MNQM6) found ${broken.length} truly-broken walls passing exhaustion criteria.\n`);

// ── Post-break price action ───────────────────────────────────────────────
console.log(`── Post-break price action (NQ ticks as MNQ price proxy, 5min horizon) ──\n`);
const nqTrade = tk.prepare(`SELECT ts, price FROM trades WHERE symbol='NQ' AND ts BETWEEN ? AND ? ORDER BY ts ASC`);
const nqAt = tk.prepare(`SELECT price FROM trades WHERE symbol='NQ' AND ABS(ts - ?) < 500 ORDER BY ABS(ts - ?) ASC LIMIT 1`);

console.log([
  pad('time(ET)', 12), pad('side', 4), pad('wall', 10), pad('peak', 6),
  pad('agg', 5), pad('mkt@drain', 10), pad('gap', 7),
  pad('+5m max', 9), pad('-5m max', 9), pad('thesis', 11, false),
].join(' '));
console.log('─'.repeat(100));

let fadeWin = 0, stopped = 0, openCase = 0;
for (const w of broken.sort((a,b) => (a.drainTs ?? 0) - (b.drainTs ?? 0))) {
  if (w.drainTs === null) continue;
  const m = nqAt.get(w.drainTs, w.drainTs) as { price: number } | undefined;
  if (!m) continue;
  const mkt = m.price;
  const dir: 1 | -1 = w.is_bid === 1 ? 1 : -1;
  const trades = nqTrade.all(w.drainTs, w.drainTs + 5*60_000) as Array<{ts:number;price:number}>;
  if (!trades.length) continue;
  const ps = trades.map(t => t.price);
  const maxFav = Math.max(...ps.map(p => dir*(p - mkt)));
  const maxAdv = Math.min(...ps.map(p => dir*(p - mkt)));
  const gap = dir*(w.price - mkt);
  let thesis = 'OPEN';
  if (maxFav >= 20 && maxAdv > -10) { thesis = 'FADE_WIN'; fadeWin++; }
  else if (maxAdv <= -10)            { thesis = 'STOPPED'; stopped++; }
  else                                { thesis = 'OPEN'; openCase++; }
  console.log([
    pad(et(w.drainTs).substring(0,12), 12),
    pad(w.is_bid===1?'BID':'ASK', 4),
    pad(w.price.toFixed(2), 10),
    pad(w.peak, 6),
    pad(w.nAggressors, 5),
    pad(mkt.toFixed(2), 10),
    pad((gap>=0?'+':'')+gap.toFixed(1), 7),
    pad((maxFav>=0?'+':'')+maxFav.toFixed(1), 9),
    pad((maxAdv>=0?'+':'')+maxAdv.toFixed(1), 9),
    pad(thesis, 11, false),
  ].join(' '));
}

console.log(``);
const decided = fadeWin + stopped;
console.log(`══ Verdict ══`);
console.log(`  BROKEN walls evaluated:  ${broken.length}`);
console.log(`  Hit +20pts in fade dir:  ${fadeWin}`);
console.log(`  Hit -10pts adverse:      ${stopped}`);
console.log(`  Open (±10/+20 in 5min):  ${openCase}`);
console.log(`  WR (excl open):          ${decided > 0 ? (fadeWin/decided*100).toFixed(1) : '—'}%`);
console.log(`\n  NOTE: Entry is mkt@drainTs (real market at exhaustion moment, no wall-price look-ahead).`);
console.log(`        gap = wall_price vs mkt@drain (favorable direction); large gap = same issue v1 had.`);
console.log(`Done.`);
