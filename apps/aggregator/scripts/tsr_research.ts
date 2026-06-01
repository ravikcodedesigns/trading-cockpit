/**
 * tsr_research.ts — v3 "Sweep-and-Fail" Stop Run detector
 *
 * Mechanic:
 *   1. Track a structural N-minute rolling H/L.
 *   2. When a tick makes a NEW structural extreme that ALSO crossed beyond the
 *      prior extreme by ≥ SWEEP_PTS, mark a "sweep" event. (Real stop hunt — not
 *      just a touch.)
 *   3. From the sweep moment, monitor up to MONITOR_MS:
 *        - Track post-sweep aggression (volume, buy% / sell%).
 *        - Track price retreat from the sweep extreme.
 *        - Track whether the extreme is exceeded again (→ abort, real
 *          breakout).
 *   4. Emit signal when ALL of these hold within the monitor window:
 *        - Price has retreated ≥ RETREAT_PTS from sweep extreme
 *        - Post-sweep aggression is ≥ FLIP_PCT opposite side
 *        - Post-sweep volume ≥ MIN_POST_VOL (real participation, not dead tape)
 *        - Sweep extreme has not been exceeded again
 *
 * Entry  = current price at signal time
 * Stop   = sweep extreme ± STOP_BUFFER
 * Target = entry ± RR × stopDist
 *
 * No lookahead in features; outcome scan is forward (validation only).
 *
 * Convention (verified empirically against price direction):
 *   is_bid_aggressor=1 → BUY aggressor (price rises)
 *   is_bid_aggressor=0 → SELL aggressor (price falls)
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

type Params = {
  structHlMs:      number;  // structural rolling H/L window
  sweepPts:        number;  // min pts the new extreme must exceed prior extreme
  monitorMs:       number;  // window after sweep to look for confirmation
  retreatPts:      number;  // pts of retreat from sweep extreme required
  minPostVol:      number;  // post-sweep total volume required
  flipPct:         number;  // opposite-side aggression share required
  stopBuffer:      number;  // pts beyond sweep extreme for stop
  reExceedTol:     number;  // pts of allowed wick past sweep before abort
  maxStopDist:     number;  // pts; signals with bigger stop rejected
  rr:              number;
  horizonMs:       number;
  cooldownMs:      number;
};

// LOCKED RULE — chosen on training set (62.5% WR, n=8, EV +4.78pts, avgDd 2.59).
// Justifications, each tied to a market-mechanics rationale:
//   sweepPts=0.5  → require ≥1 NQ tick wick beyond the prior 30-min extreme
//                    (a "real" sweep, not an incremental new high).
//   monitorMs=60s → 1-minute window for failure to materialise (typical
//                    stop-hunt-and-fade cycle).
//   retreatPts=1  → confirm price has reversed at least 1pt from the swept
//                    extreme; smaller is noise.
//   minPostVol=30 → require ≥30 contracts traded post-sweep to confirm there
//                    was real participation behind the failure.
//   flipPct=0.55  → modest opposite-side aggression dominance in the
//                    post-sweep window.
//   reExceedTol=0.75 → tolerate a 0.75pt wick re-tag of the swept extreme
//                    without aborting (very common micro-retest).
//   maxStopDist=5 → cap stop at 5pts; with rr=3 → target ≤ 15pts.
const DEFAULT_PARAMS: Params = {
  structHlMs:      30 * 60 * 1000,
  sweepPts:        0.5,
  monitorMs:       60_000,
  retreatPts:      1.0,
  minPostVol:      30,
  flipPct:         0.55,
  stopBuffer:      0.25,
  reExceedTol:     0.75,
  maxStopDist:     5.0,
  rr:              3.0,
  horizonMs:       3 * 60 * 1000,
  cooldownMs:      60_000,
};

const TRAIN_DATES = ['2026-05-05','2026-05-06','2026-05-08','2026-05-11','2026-05-12',
                     '2026-05-13','2026-05-14','2026-05-15','2026-05-18','2026-05-19'];
const TEST_DATES  = ['2026-05-20','2026-05-21','2026-05-22','2026-05-26','2026-05-27'];

const RTH_START_HHMM = 9 * 60 + 35;
const RTH_END_HHMM   = 15 * 60 + 55;

const ENABLED_DIRS = new Set<'long' | 'short'>(['short']);

type Trade = { ts: number; price: number; size: number; isBidAgg: 0 | 1 };
type Signal = {
  date: string;
  entryTs: number;
  entryEt: string;
  direction: 'long' | 'short';
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  stopDist: number;
  sweepExtreme: number;       // the swept price
  priorExtreme: number;       // structural H/L before the sweep
  sweepDist: number;          // pts swept past prior extreme
  retreat: number;            // pts retreated from sweep extreme
  postVol: number;
  postFlipPct: number;
  monitorMsElapsed: number;
};
type Outcome = {
  result: 'W' | 'L' | 'T';
  maxGain: number;
  maxDd: number;
  pnlPts: number;
  resolvedInMs: number;
};
type Diag = {
  newExtremes:    number;  // new structural highs/lows (BUY=hi, SELL=lo)
  sweeps:         number;  // + crossed prior extreme by sweepPts
  monitorAborted: number;  // monitor ended without confirmation
  reExceeded:     number;  // sweep extreme exceeded again → aborted
  signalsFired:   number;
  cooldownBlocked:number;
};

function etMinutesOfDay(tsMs: number): number {
  const d = new Date(tsMs - 4 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function etHHMMSS(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
}

function loadTradesForDate(db: Database.Database, date: string): Trade[] {
  const startTs = Date.parse(`${date}T08:00:00-04:00`);
  const endTs   = Date.parse(`${date}T16:30:00-04:00`);
  return db.prepare(
    `SELECT ts, price, size, is_bid_aggressor AS isBidAgg
     FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?
     ORDER BY ts ASC, id ASC`
  ).all(startTs, endTs) as Trade[];
}

// ─── Detector ────────────────────────────────────────────────────────────────

type SweepWatch = {
  dir: 'short' | 'long';   // fade direction
  sweepExtreme: number;
  sweepTs: number;
  priorExtreme: number;
  sweepDist: number;
  postBuy: number;
  postSell: number;
  curMaxBeyond: number;    // worst extension past sweepExtreme (0 if none)
};

function detect(date: string, trades: Trade[], p: Params): { signals: Signal[]; diag: Diag } {
  const signals: Signal[] = [];
  const diag: Diag = { newExtremes:0, sweeps:0, monitorAborted:0, reExceeded:0, signalsFired:0, cooldownBlocked:0 };

  // Structural deques for rolling N-min H/L.
  let sHead = 0;
  const sMax: number[] = [];
  const sMin: number[] = [];

  // Active sweep watches (zero or two active, one per direction).
  let watchShort: SweepWatch | null = null;
  let watchLong:  SweepWatch | null = null;

  // Cooldowns per direction.
  let lastShortTs = -Infinity;
  let lastLongTs  = -Infinity;

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const inRth = (() => {
      const m = etMinutesOfDay(t.ts);
      return m >= RTH_START_HHMM && m <= RTH_END_HHMM;
    })();

    // Capture the PRIOR structural H/L (before pushing the current tick), so
    // sweep detection is causal — the current tick is the one allegedly sweeping.
    const priorHi = sMax.length ? trades[sMax[0]].price : -Infinity;
    const priorLo = sMin.length ? trades[sMin[0]].price :  Infinity;

    // Update post-sweep stats for any active watches, BEFORE potentially
    // emitting a signal at this tick. The current tick is post-sweep.
    const updateWatch = (w: SweepWatch | null) => {
      if (!w || t.ts <= w.sweepTs) return;
      if (t.isBidAgg === 1) w.postBuy  += t.size;
      else                  w.postSell += t.size;
      if (w.dir === 'short') {
        const beyond = t.price - w.sweepExtreme;
        if (beyond > w.curMaxBeyond) w.curMaxBeyond = beyond;
      } else {
        const beyond = w.sweepExtreme - t.price;
        if (beyond > w.curMaxBeyond) w.curMaxBeyond = beyond;
      }
    };
    updateWatch(watchShort);
    updateWatch(watchLong);

    // Try to emit signal for active watches (RTH only).
    if (inRth) {
      const tryEmit = (w: SweepWatch | null): SweepWatch | null => {
        if (!w) return null;
        // Abort if monitor expired.
        if (t.ts - w.sweepTs > p.monitorMs) {
          diag.monitorAborted++;
          return null;
        }
        // Abort if the sweep extreme was re-exceeded by a tick (real breakout).
        if (w.curMaxBeyond > p.reExceedTol) {
          diag.reExceeded++;
          return null;
        }
        const postVol = w.postBuy + w.postSell;
        if (postVol < p.minPostVol) return w;
        const flipPct = w.dir === 'short' ? w.postSell / postVol : w.postBuy / postVol;
        if (flipPct < p.flipPct) return w;
        const retreat = w.dir === 'short' ? (w.sweepExtreme - t.price) : (t.price - w.sweepExtreme);
        if (retreat < p.retreatPts) return w;
        // Stop & target
        const entryPrice = t.price;
        const stopPrice  = w.dir === 'short' ? w.sweepExtreme + p.stopBuffer : w.sweepExtreme - p.stopBuffer;
        const stopDist   = Math.abs(stopPrice - entryPrice);
        if (stopDist > p.maxStopDist) return w;
        // Cooldown.
        const last = w.dir === 'short' ? lastShortTs : lastLongTs;
        if (t.ts - last < p.cooldownMs) { diag.cooldownBlocked++; return null; }
        const targetPrice = w.dir === 'short' ? entryPrice - p.rr * stopDist : entryPrice + p.rr * stopDist;
        signals.push({
          date,
          entryTs: t.ts,
          entryEt: etHHMMSS(t.ts),
          direction: w.dir,
          entryPrice, stopPrice, targetPrice, stopDist,
          sweepExtreme: w.sweepExtreme,
          priorExtreme: w.priorExtreme,
          sweepDist: w.sweepDist,
          retreat, postVol, postFlipPct: flipPct,
          monitorMsElapsed: t.ts - w.sweepTs,
        });
        if (w.dir === 'short') lastShortTs = t.ts; else lastLongTs = t.ts;
        diag.signalsFired++;
        return null;  // consume the watch
      };
      watchShort = tryEmit(watchShort);
      watchLong  = tryEmit(watchLong);
    }

    // Push current tick into structural deques.
    while (sMax.length && trades[sMax[sMax.length-1]].price <= t.price) sMax.pop();
    sMax.push(i);
    while (sMin.length && trades[sMin[sMin.length-1]].price >= t.price) sMin.pop();
    sMin.push(i);
    const sCutoff = t.ts - p.structHlMs;
    while (sHead < i && trades[sHead].ts < sCutoff) sHead++;
    while (sMax.length && sMax[0] < sHead) sMax.shift();
    while (sMin.length && sMin[0] < sHead) sMin.shift();

    // After insertion, the new rolling extreme. Check for sweep events vs the
    // prior extreme we captured at the top of the loop. Only consider during
    // RTH so we don't fire on overnight ticks.
    if (!inRth) continue;

    // Sweep UP — current tick is now the new structural high and beat prior by ≥ sweepPts.
    if (sMax.length && trades[sMax[0]].price === t.price && priorHi !== -Infinity) {
      const sweepDist = t.price - priorHi;
      if (sweepDist >= p.sweepPts) {
        diag.newExtremes++;
        diag.sweeps++;
        if (ENABLED_DIRS.has('short')) {
          watchShort = {
            dir: 'short',
            sweepExtreme: t.price,
            sweepTs: t.ts,
            priorExtreme: priorHi,
            sweepDist,
            postBuy: 0, postSell: 0,
            curMaxBeyond: 0,
          };
        }
      }
    }
    // Sweep DOWN.
    if (sMin.length && trades[sMin[0]].price === t.price && priorLo !== Infinity) {
      const sweepDist = priorLo - t.price;
      if (sweepDist >= p.sweepPts) {
        diag.newExtremes++;
        diag.sweeps++;
        if (ENABLED_DIRS.has('long')) {
          watchLong = {
            dir: 'long',
            sweepExtreme: t.price,
            sweepTs: t.ts,
            priorExtreme: priorLo,
            sweepDist,
            postBuy: 0, postSell: 0,
            curMaxBeyond: 0,
          };
        }
      }
    }
  }

  return { signals, diag };
}

// ─── Outcome scoring ─────────────────────────────────────────────────────────

function scoreOutcome(s: Signal, trades: Trade[], p: Params): Outcome {
  let lo = 0, hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (trades[mid].ts <= s.entryTs) lo = mid + 1;
    else hi = mid;
  }
  const startIdx = lo;
  const endTs    = s.entryTs + p.horizonMs;
  let maxGain = 0, maxDd = 0;
  for (let i = startIdx; i < trades.length && trades[i].ts <= endTs; i++) {
    const px = trades[i].price;
    if (s.direction === 'short') {
      const gain = s.entryPrice - px;
      const dd   = px - s.entryPrice;
      if (gain > maxGain) maxGain = gain;
      if (dd   > maxDd)   maxDd   = dd;
      if (px >= s.stopPrice)   return { result:'L', maxGain, maxDd, pnlPts:-s.stopDist,        resolvedInMs: trades[i].ts - s.entryTs };
      if (px <= s.targetPrice) return { result:'W', maxGain, maxDd, pnlPts: p.rr * s.stopDist, resolvedInMs: trades[i].ts - s.entryTs };
    } else {
      const gain = px - s.entryPrice;
      const dd   = s.entryPrice - px;
      if (gain > maxGain) maxGain = gain;
      if (dd   > maxDd)   maxDd   = dd;
      if (px <= s.stopPrice)   return { result:'L', maxGain, maxDd, pnlPts:-s.stopDist,        resolvedInMs: trades[i].ts - s.entryTs };
      if (px >= s.targetPrice) return { result:'W', maxGain, maxDd, pnlPts: p.rr * s.stopDist, resolvedInMs: trades[i].ts - s.entryTs };
    }
  }
  return { result:'T', maxGain, maxDd, pnlPts: 0, resolvedInMs: p.horizonMs };
}

function summarize(label: string, results: { sig: Signal; out: Outcome }[]) {
  const n = results.length;
  const wins = results.filter(r => r.out.result === 'W').length;
  const losses = results.filter(r => r.out.result === 'L').length;
  const timeouts = results.filter(r => r.out.result === 'T').length;
  const decided = wins + losses;
  const wr = decided ? (wins / decided) * 100 : 0;
  const totalPnl = results.reduce((acc, r) => acc + r.out.pnlPts, 0);
  const avgGain  = n ? results.reduce((a, r) => a + r.out.maxGain, 0) / n : 0;
  const avgDd    = n ? results.reduce((a, r) => a + r.out.maxDd,   0) / n : 0;
  const avgStop  = n ? results.reduce((a, r) => a + r.sig.stopDist, 0) / n : 0;
  console.log(`\n── ${label} ──  n=${n}  W=${wins}  L=${losses}  T=${timeouts}  WR=${wr.toFixed(1)}%  EV=${(totalPnl/Math.max(n,1)).toFixed(2)}pts  avgStop=${avgStop.toFixed(2)} avgGain=${avgGain.toFixed(2)}  avgDd=${avgDd.toFixed(2)}`);
}

async function main() {
  const mode = process.argv[2] === 'test' ? 'test' : 'train';
  const dates = mode === 'test' ? TEST_DATES : TRAIN_DATES;
  const p = DEFAULT_PARAMS;
  console.log(`TSR research v3 — mode=${mode} dates=${dates.length}`);
  console.log('Params:', JSON.stringify(p));

  const db = new Database(TICKS_DB, { readonly: true });
  db.pragma('journal_mode = WAL');

  const all: { sig: Signal; out: Outcome }[] = [];
  const aggDiag: Diag = { newExtremes:0, sweeps:0, monitorAborted:0, reExceeded:0, signalsFired:0, cooldownBlocked:0 };
  for (const date of dates) {
    const trades = loadTradesForDate(db, date);
    const { signals: sigs, diag } = detect(date, trades, p);
    for (const s of sigs) all.push({ sig: s, out: scoreOutcome(s, trades, p) });
    for (const k of Object.keys(aggDiag) as (keyof Diag)[]) aggDiag[k] += diag[k];
    console.log(`${date}: sweeps=${diag.sweeps}  abortMon=${diag.monitorAborted}  reExc=${diag.reExceeded}  cd=${diag.cooldownBlocked}  sig=${diag.signalsFired}`);
  }
  db.close();
  console.log(`\nFunnel: sweeps=${aggDiag.sweeps}  monitorAborted=${aggDiag.monitorAborted}  reExceeded=${aggDiag.reExceeded}  cooldownBlocked=${aggDiag.cooldownBlocked}  signals=${aggDiag.signalsFired}`);

  summarize('OVERALL', all);
  summarize('LONG',  all.filter(x => x.sig.direction === 'long'));
  summarize('SHORT', all.filter(x => x.sig.direction === 'short'));

  console.log('\n── All signals ──');
  console.log('date       et       dir   entry     stop     tgt      stopD  sweepD postVol flip%  retreat  monMs result  gain  dd');
  for (const { sig, out } of all) {
    console.log(
      `${sig.date}  ${sig.entryEt}  ${sig.direction.padEnd(5)} ` +
      `${sig.entryPrice.toFixed(2).padStart(8)} ${sig.stopPrice.toFixed(2).padStart(8)} ${sig.targetPrice.toFixed(2).padStart(8)}  ` +
      `${sig.stopDist.toFixed(2).padStart(5)}  ${sig.sweepDist.toFixed(2).padStart(5)} ${String(sig.postVol).padStart(6)}  ` +
      `${(sig.postFlipPct*100).toFixed(0).padStart(4)}  ${sig.retreat.toFixed(2).padStart(6)}  ${String(sig.monitorMsElapsed).padStart(5)}  ${out.result.padStart(4)}  ${out.maxGain.toFixed(1).padStart(4)}  ${out.maxDd.toFixed(1).padStart(4)}`
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
