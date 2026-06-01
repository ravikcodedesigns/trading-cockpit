/**
 * ibmf_research.ts — Inside-Bar Microstructure Fade (IBMF)
 *
 * Built from scratch on raw inputs only:
 *   - 1-minute NQ candles built from trades in ticks.db
 *   - Signed delta per minute (BUY aggressor − SELL aggressor)
 *
 * Mechanic (Wyckoff "test of supply/demand" + standard inside-bar):
 *   Bar(t)   = "impulse": large range, closed near extreme, one-sided delta
 *   Bar(t+1) = "inside":   geometrically inside (high<H_t, low>L_t),
 *                           delta opposite-sign to impulse,
 *                           non-trivial volume (not a dead minute)
 *   → buyers/sellers tried to push, failed to extend, opposite side has the
 *     pressure. Fade the impulse direction.
 *
 * Entry  = close of the inside bar (open of bar t+2)
 * Stop   = impulse extreme ± STOP_BUFFER
 * Target = entry ± RR × stopDist
 *
 * All features causal (only data up through bar(t+1) close).
 * Outcome scoring scans forward ticks for stop/target/timeout.
 *
 * Aggressor convention (independently verified on 5/12 RTH):
 *   is_bid_aggressor=1 → BUY aggressor (up-minute dominant)
 *   is_bid_aggressor=0 → SELL aggressor (down-minute dominant)
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

// ─── Config ──────────────────────────────────────────────────────────────────

type Params = {
  // Impulse bar criteria
  impulseMinRange:  number;  // pts — min total range of impulse bar
  impulseBodyPct:   number;  // |body|/range — close near extreme
  impulseDeltaPct:  number;  // |delta|/volume — one-sided aggression
  impulseMinVol:    number;  // contracts; rules out thin-tape impulses

  // Inside-bar criteria
  insideMinVol:     number;  // not a dead bar
  insideDeltaPct:   number;  // opposite-side delta share within inside bar

  // Trade plan
  stopBuffer:       number;  // pts beyond impulse extreme for stop
  maxStopDist:      number;  // pts; reject signals with bigger stop
  rr:               number;  // target = rr × stopDist
  horizonMs:        number;  // forward scan window for outcomes
};

// NQ 1m bars (empirically calibrated 2026-05-13):
//   avg range = 16pts (much wider than I assumed). Top quartile ≈ ≥10pts.
//   |delta|/vol per minute typically 0.05–0.15. Max observed ≈ 0.36.
//   Average vol per minute ≈ 5,000 contracts.
const DEFAULT_PARAMS: Params = {
  impulseMinRange:  10.0,
  impulseBodyPct:   0.50,
  impulseDeltaPct:  0.15,
  impulseMinVol:    1500,
  insideMinVol:     500,
  insideDeltaPct:   0.10,
  stopBuffer:       0.25,
  maxStopDist:      12.0,
  rr:               2.0,
  horizonMs:        5 * 60 * 1000,
};

const TRAIN_DATES = ['2026-05-05','2026-05-06','2026-05-08','2026-05-11','2026-05-12',
                     '2026-05-13','2026-05-14','2026-05-15','2026-05-18','2026-05-19'];
const TEST_DATES  = ['2026-05-20','2026-05-21','2026-05-22','2026-05-26','2026-05-27'];

// RTH window: 09:35 → 15:55 ET (UTC-4 in DST). Excludes opening / closing chop.
const RTH_START_MIN = 9 * 60 + 35;
const RTH_END_MIN   = 15 * 60 + 55;

// ─── Types ───────────────────────────────────────────────────────────────────

type Trade = { ts: number; price: number; size: number; isBidAgg: 0 | 1 };
type Bar = {
  minStartTs: number;  // ms timestamp of minute open
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
  delta: number;       // buy_vol − sell_vol
};
type Signal = {
  date: string;
  impulseEt: string;
  insideEt:  string;
  entryTs:   number;   // ms of bar(t+2) open
  direction: 'long' | 'short';
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  stopDist: number;
  impulseRange: number;
  impulseBodyPct: number;
  impulseDeltaPct: number;
  impulseVol: number;
  insideVol: number;
  insideDeltaPct: number;
  insideRangePct: number;   // insideRange / impulseRange
};
type Outcome = {
  result: 'W' | 'L' | 'T';
  maxGain: number;
  maxDd: number;
  pnlPts: number;
  resolvedInMs: number;
};
type Diag = {
  rthBars:    number;
  passRange:  number;
  passVol:    number;
  passBody:   number;
  passDelta:  number;
  passSign:   number;
  impulses:   number;     // alias for passSign — all impulse gates passed
  insidesGeo: number;
  insidesVol: number;
  insidesDelta: number;
  insidesSign: number;
  signalsOk:  number;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function etMinutesOfDay(tsMs: number): number {
  const d = new Date(tsMs - 4 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function etHHMM(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

function loadTrades(db: Database.Database, date: string): Trade[] {
  const startTs = Date.parse(`${date}T08:00:00-04:00`);
  const endTs   = Date.parse(`${date}T16:30:00-04:00`);
  return db.prepare(
    `SELECT ts, price, size, is_bid_aggressor AS isBidAgg
     FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?
     ORDER BY ts ASC, id ASC`
  ).all(startTs, endTs) as Trade[];
}

// Build 1-minute bars from trades. Each bar covers [minStartTs, minStartTs + 60000).
function buildMinuteBars(trades: Trade[]): Bar[] {
  if (!trades.length) return [];
  const bars: Bar[] = [];
  let cur: Bar | null = null;
  for (const t of trades) {
    const minStart = Math.floor(t.ts / 60000) * 60000;
    if (!cur || cur.minStartTs !== minStart) {
      if (cur) bars.push(cur);
      cur = {
        minStartTs: minStart,
        open: t.price, high: t.price, low: t.price, close: t.price,
        vol: 0, delta: 0,
      };
    }
    if (t.price > cur.high) cur.high = t.price;
    if (t.price < cur.low)  cur.low  = t.price;
    cur.close = t.price;
    cur.vol += t.size;
    // is_bid_aggressor=1 → BUY (verified empirically)
    cur.delta += (t.isBidAgg === 1 ? t.size : -t.size);
  }
  if (cur) bars.push(cur);
  return bars;
}

// ─── Detector ────────────────────────────────────────────────────────────────

function detect(date: string, bars: Bar[], p: Params): { signals: Signal[]; diag: Diag } {
  const signals: Signal[] = [];
  const diag: Diag = { rthBars:0, passRange:0, passVol:0, passBody:0, passDelta:0, passSign:0, impulses:0, insidesGeo:0, insidesVol:0, insidesDelta:0, insidesSign:0, signalsOk:0 };

  for (let i = 0; i < bars.length - 1; i++) {
    const b = bars[i];
    const mod = etMinutesOfDay(b.minStartTs);
    if (mod < RTH_START_MIN || mod > RTH_END_MIN) continue;
    diag.rthBars++;

    // ── Impulse criteria ──
    const range = b.high - b.low;
    if (range < p.impulseMinRange) continue;
    diag.passRange++;
    if (b.vol < p.impulseMinVol)   continue;
    diag.passVol++;
    const body = b.close - b.open;
    const bodyPct = range > 0 ? Math.abs(body) / range : 0;
    if (bodyPct < p.impulseBodyPct) continue;
    diag.passBody++;
    const deltaPct = b.vol > 0 ? Math.abs(b.delta) / b.vol : 0;
    if (deltaPct < p.impulseDeltaPct) continue;
    diag.passDelta++;
    // Delta must agree with body direction (real conviction).
    if (Math.sign(b.delta) !== Math.sign(body)) continue;
    diag.passSign++;
    diag.impulses++;

    // ── Inside-bar criteria (next bar) ──
    const ib = bars[i + 1];
    // Bars are sequential, but if the previous minute had no ticks, the next
    // index may not actually be t+1; guard that.
    if (ib.minStartTs !== b.minStartTs + 60000) continue;

    if (!(ib.high < b.high && ib.low > b.low)) continue;
    diag.insidesGeo++;

    if (ib.vol < p.insideMinVol) continue;
    diag.insidesVol++;
    // Inside delta must be opposite-sign and reach a meaningful share.
    const ibDeltaPct = ib.vol > 0 ? Math.abs(ib.delta) / ib.vol : 0;
    if (ibDeltaPct < p.insideDeltaPct) continue;
    diag.insidesDelta++;
    const wantedSign = -Math.sign(body);
    if (Math.sign(ib.delta) !== wantedSign) continue;
    diag.insidesSign++;

    // ── Build trade plan ──
    const impulseUp = body > 0;
    const direction: 'long' | 'short' = impulseUp ? 'short' : 'long';
    const entryPrice = ib.close;
    const stopPrice  = impulseUp ? b.high + p.stopBuffer : b.low - p.stopBuffer;
    const stopDist   = Math.abs(stopPrice - entryPrice);
    if (stopDist > p.maxStopDist) continue;
    const targetPrice = impulseUp ? entryPrice - p.rr * stopDist : entryPrice + p.rr * stopDist;

    diag.signalsOk++;

    signals.push({
      date,
      impulseEt: etHHMM(b.minStartTs),
      insideEt:  etHHMM(ib.minStartTs),
      entryTs:   ib.minStartTs + 60_000,  // open of t+2 = close of inside bar
      direction,
      entryPrice, stopPrice, targetPrice, stopDist,
      impulseRange: range,
      impulseBodyPct: bodyPct,
      impulseDeltaPct: deltaPct,
      impulseVol: b.vol,
      insideVol: ib.vol,
      insideDeltaPct: ibDeltaPct,
      insideRangePct: (ib.high - ib.low) / range,
    });
  }
  return { signals, diag };
}

// ─── Outcome scoring ─────────────────────────────────────────────────────────

function scoreOutcome(s: Signal, trades: Trade[], p: Params): Outcome {
  // Binary-search first tick at ts ≥ entryTs (we enter at inside bar's close,
  // which is the next bar's open — first tick of bar t+2).
  let lo = 0, hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (trades[mid].ts < s.entryTs) lo = mid + 1;
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

// ─── Reporting ───────────────────────────────────────────────────────────────

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
  console.log(`IBMF research — mode=${mode} dates=${dates.length}`);
  console.log('Params:', JSON.stringify(p));

  const db = new Database(TICKS_DB, { readonly: true });
  db.pragma('journal_mode = WAL');

  const all: { sig: Signal; out: Outcome }[] = [];
  const aggDiag: Diag = { rthBars:0, passRange:0, passVol:0, passBody:0, passDelta:0, passSign:0, impulses:0, insidesGeo:0, insidesVol:0, insidesDelta:0, insidesSign:0, signalsOk:0 };
  for (const date of dates) {
    const trades = loadTrades(db, date);
    const bars = buildMinuteBars(trades);
    const { signals: sigs, diag } = detect(date, bars, p);
    for (const s of sigs) all.push({ sig: s, out: scoreOutcome(s, trades, p) });
    for (const k of Object.keys(aggDiag) as (keyof Diag)[]) aggDiag[k] += diag[k];
    console.log(`${date}: rth=${diag.rthBars} rng=${diag.passRange} vol=${diag.passVol} body=${diag.passBody} dlt=${diag.passDelta} sgn=${diag.passSign} geo=${diag.insidesGeo} ivol=${diag.insidesVol} idlt=${diag.insidesDelta} isgn=${diag.insidesSign} sig=${diag.signalsOk}`);
  }
  db.close();
  console.log(`\nImpulse funnel: rth=${aggDiag.rthBars}  rng=${aggDiag.passRange}  vol=${aggDiag.passVol}  body=${aggDiag.passBody}  delta=${aggDiag.passDelta}  sign=${aggDiag.passSign}`);
  console.log(`Inside  funnel: geo=${aggDiag.insidesGeo}  vol=${aggDiag.insidesVol}  delta=${aggDiag.insidesDelta}  sign=${aggDiag.insidesSign}  signals=${aggDiag.signalsOk}`);

  summarize('OVERALL', all);
  summarize('LONG',  all.filter(x => x.sig.direction === 'long'));
  summarize('SHORT', all.filter(x => x.sig.direction === 'short'));

  console.log('\n── All signals ──');
  console.log('date       impEt  inEt   dir   entry      stop      tgt       stopD  iRng iBody iDelt iVol  insVol insDelt insRng  res  gain  dd');
  for (const { sig, out } of all) {
    console.log(
      `${sig.date}  ${sig.impulseEt}  ${sig.insideEt}  ${sig.direction.padEnd(5)} ` +
      `${sig.entryPrice.toFixed(2).padStart(8)} ${sig.stopPrice.toFixed(2).padStart(8)} ${sig.targetPrice.toFixed(2).padStart(8)} ` +
      `${sig.stopDist.toFixed(2).padStart(5)}  ${sig.impulseRange.toFixed(1).padStart(4)} ${(sig.impulseBodyPct*100).toFixed(0).padStart(3)} ${(sig.impulseDeltaPct*100).toFixed(0).padStart(3)} ${String(sig.impulseVol).padStart(5)}  ` +
      `${String(sig.insideVol).padStart(5)}   ${(sig.insideDeltaPct*100).toFixed(0).padStart(3)}    ${(sig.insideRangePct*100).toFixed(0).padStart(3)}  ${out.result.padStart(3)}  ${out.maxGain.toFixed(1).padStart(4)}  ${out.maxDd.toFixed(1).padStart(4)}`
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
