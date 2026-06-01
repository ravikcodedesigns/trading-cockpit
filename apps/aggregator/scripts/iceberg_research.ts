/**
 * iceberg_research.ts — Iceberg-defended extreme detector (depth + trades)
 *
 * Mechanic:
 *   At a structural extreme defended by an iceberg, the SAME price level
 *   keeps coming back to the top of book and absorbing aggression — the
 *   visible size repeatedly REFILLS even as it's hit by trades.
 *
 * NQ LOB realities (empirically observed):
 *   The best bid/ask flickers in <500ms. The classic "level sits for 30s"
 *   does not exist here. So we measure iceberg behaviour as CUMULATIVE
 *   activity at a price within a 1-minute window:
 *     bestTimeMs   = how long this exact price was best bid/ask in the min
 *     refillCount  = number of size-INCREASE events at this price
 *     refillVol    = sum of those size increases (visible iceberg supply)
 *     hitVol       = opposite-aggressor trade volume at this price
 *
 * Signal trigger at minute close (causal):
 *   For each (side, price), compute the per-minute totals. Pick the highest
 *   bestTime price on each side. If a price passes ALL four gates above and
 *   price has retreated at least RETREAT_PTS from the iceberg by minute
 *   close, emit a fade signal at the next minute's open.
 *
 * Entry  = next minute open
 * Stop   = iceberg price ∓ STOP_BUFFER
 * Target = entry ± RR × stopDist
 *
 * Convention (verified):
 *   trades.is_bid_aggressor = 1 → BUY aggressor; 0 → SELL aggressor
 *   depth.side = 0 → bid; 1 → ask;  depth.size = 0 → level removed
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

type Params = {
  minBestTimeMs:    number;
  minRefillCount:   number;
  minHitVol:        number;
  minRefillVol:     number;
  minRetreatPts:    number;
  stopBuffer:       number;
  maxStopDist:      number;
  rr:               number;
  horizonMs:        number;
  cooldownMs:       number;
};

const DEFAULT_PARAMS: Params = {
  minBestTimeMs:    100,        // trivial — extremes are by nature brief tests
  minRefillCount:   3,
  minHitVol:        50,
  minRefillVol:     20,
  minRetreatPts:    0.5,
  stopBuffer:       0.25,
  maxStopDist:      5.0,
  rr:               3.0,
  horizonMs:        3 * 60 * 1000,
  cooldownMs:       90_000,
};

const TRAIN_DATES = ['2026-05-05','2026-05-06','2026-05-08','2026-05-11','2026-05-12',
                     '2026-05-13','2026-05-14','2026-05-15','2026-05-18','2026-05-19'];
const TEST_DATES  = ['2026-05-20','2026-05-21','2026-05-22','2026-05-26','2026-05-27'];

const RTH_START_MIN = 9 * 60 + 35;
const RTH_END_MIN   = 15 * 60 + 55;

type DepthEv = { kind: 'd'; ts: number; side: 0|1; price: number; size: number };
type TradeEv = { kind: 't'; ts: number; price: number; size: number; isBidAgg: 0|1 };
type Ev = DepthEv | TradeEv;

type Signal = {
  date: string;
  triggerEt: string;       // minute the iceberg pattern completed
  entryTs:   number;       // next minute open
  direction: 'long' | 'short';
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  stopDist: number;
  icebergPrice: number;
  bestTimeMs: number;
  refillCount: number;
  refillVol: number;
  hitVol: number;
  retreatPts: number;
};
type Outcome = {
  result: 'W' | 'L' | 'T';
  maxGain: number;
  maxDd: number;
  pnlPts: number;
  resolvedInMs: number;
};
type Diag = {
  events:        number;
  rthMinutes:    number;
  maxBestTimeMs: number;
  maxRefills:    number;
  maxHitVol:     number;
  maxRefillVol:  number;
  passTime:      number;
  passRefills:   number;
  passHit:       number;
  passRefillVol: number;
  passAll:       number;
  passRetreat:   number;
  signalsBid:    number;
  signalsAsk:    number;
  cooldown:      number;
};

function etMinutesOfDay(tsMs: number): number {
  const d = new Date(tsMs - 4 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function etHHMM(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

function* mergeEvents(db: Database.Database, date: string): Generator<Ev> {
  const startTs = Date.parse(`${date}T08:00:00-04:00`);
  const endTs   = Date.parse(`${date}T16:30:00-04:00`);
  const dIter = db.prepare(
    `SELECT ts, side, price, size FROM depth WHERE symbol='NQ' AND ts >= ? AND ts < ? ORDER BY ts ASC, id ASC`
  ).iterate(startTs, endTs) as IterableIterator<{ts:number;side:0|1;price:number;size:number}>;
  const tIter = db.prepare(
    `SELECT ts, price, size, is_bid_aggressor AS isBidAgg FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ? ORDER BY ts ASC, id ASC`
  ).iterate(startTs, endTs) as IterableIterator<{ts:number;price:number;size:number;isBidAgg:0|1}>;
  let d = dIter.next(); let t = tIter.next();
  while (!d.done || !t.done) {
    if (d.done) {
      yield { kind:'t', ts:t.value.ts, price:t.value.price, size:t.value.size, isBidAgg:t.value.isBidAgg };
      t = tIter.next();
    } else if (t.done) {
      yield { kind:'d', ts:d.value.ts, side:d.value.side, price:d.value.price, size:d.value.size };
      d = dIter.next();
    } else if (d.value.ts <= t.value.ts) {
      yield { kind:'d', ts:d.value.ts, side:d.value.side, price:d.value.price, size:d.value.size };
      d = dIter.next();
    } else {
      yield { kind:'t', ts:t.value.ts, price:t.value.price, size:t.value.size, isBidAgg:t.value.isBidAgg };
      t = tIter.next();
    }
  }
}

// ─── Detector ────────────────────────────────────────────────────────────────

type Stats = { bestTimeMs: number; refillCount: number; refillVol: number; hitVol: number };
function emptyStats(): Stats { return { bestTimeMs: 0, refillCount: 0, refillVol: 0, hitVol: 0 }; }

function detect(date: string, db: Database.Database, p: Params): { signals: Signal[]; diag: Diag } {
  const signals: Signal[] = [];
  const diag: Diag = {
    events:0, rthMinutes:0, maxBestTimeMs:0, maxRefills:0, maxHitVol:0, maxRefillVol:0,
    passTime:0, passRefills:0, passHit:0, passRefillVol:0, passAll:0, passRetreat:0,
    signalsBid:0, signalsAsk:0, cooldown:0,
  };

  // LOB state
  const bidSize = new Map<number, number>();
  const askSize = new Map<number, number>();
  let bestBid = -Infinity;
  let bestAsk =  Infinity;

  // Track when each side's current best level started; closing it on a change
  // adds the elapsed ms to the per-minute stat for (side, price).
  let bidBestStartedAt = -1;
  let askBestStartedAt = -1;

  // Per-minute stats keyed by (side, price) → stats
  let curMinute = -1;
  const bidStats = new Map<number, Stats>();
  const askStats = new Map<number, Stats>();
  // Track price at minute close (last trade or last seen price)
  let lastPrice = NaN;
  // Track minute's high and low (for swing-extreme check on iceberg price)
  let minuteHigh = -Infinity;
  let minuteLow  =  Infinity;
  let lastShortTs = -Infinity;
  let lastLongTs  = -Infinity;

  // Flush a completed minute — possibly emit a signal.
  function flushMinute(minuteStartTs: number, closeTs: number, closePrice: number): void {
    diag.rthMinutes++;
    // Close out the running "time as best" accumulators for current best levels.
    if (bidBestStartedAt > 0 && isFinite(bestBid)) {
      const s = bidStats.get(bestBid) ?? emptyStats();
      s.bestTimeMs += closeTs - bidBestStartedAt;
      bidStats.set(bestBid, s);
      bidBestStartedAt = closeTs;
    }
    if (askBestStartedAt > 0 && isFinite(bestAsk)) {
      const s = askStats.get(bestAsk) ?? emptyStats();
      s.bestTimeMs += closeTs - askBestStartedAt;
      askStats.set(bestAsk, s);
      askBestStartedAt = closeTs;
    }

    // Pick the candidate AT the minute extreme. For bid, only consider prices
    // within 1 tick (0.25pt) of the minute low; pick the one with the highest
    // refillVol. Symmetric for ask at minute high.
    let bidCand: { price: number; s: Stats } | null = null;
    let askCand: { price: number; s: Stats } | null = null;
    for (const [px, s] of bidStats) {
      if (s.bestTimeMs > diag.maxBestTimeMs) diag.maxBestTimeMs = s.bestTimeMs;
      if (s.refillCount > diag.maxRefills)   diag.maxRefills   = s.refillCount;
      if (s.refillVol   > diag.maxRefillVol) diag.maxRefillVol = s.refillVol;
      if (s.hitVol      > diag.maxHitVol)    diag.maxHitVol    = s.hitVol;
      if (px > minuteLow + 0.25) continue;   // not at the low
      if (!bidCand || s.refillVol > bidCand.s.refillVol) bidCand = { price: px, s };
    }
    for (const [px, s] of askStats) {
      if (s.bestTimeMs > diag.maxBestTimeMs) diag.maxBestTimeMs = s.bestTimeMs;
      if (s.refillCount > diag.maxRefills)   diag.maxRefills   = s.refillCount;
      if (s.refillVol   > diag.maxRefillVol) diag.maxRefillVol = s.refillVol;
      if (s.hitVol      > diag.maxHitVol)    diag.maxHitVol    = s.hitVol;
      if (px < minuteHigh - 0.25) continue;  // not at the high
      if (!askCand || s.refillVol > askCand.s.refillVol) askCand = { price: px, s };
    }

    function evalAndMaybeEmit(cand: { price: number; s: Stats }, side: 0|1): void {
      const { price, s } = cand;
      const passT = s.bestTimeMs >= p.minBestTimeMs;
      const passR = s.refillCount >= p.minRefillCount;
      const passH = s.hitVol >= p.minHitVol;
      const passRV= s.refillVol >= p.minRefillVol;
      if (passT) diag.passTime++;
      if (passR) diag.passRefills++;
      if (passH) diag.passHit++;
      if (passRV) diag.passRefillVol++;
      if (!(passT && passR && passH && passRV)) return;
      diag.passAll++;
      // Extreme guard already enforced at selection — but keep the safety net.
      const isExtreme = side === 0
        ? (price <= minuteLow + 0.25)
        : (price >= minuteHigh - 0.25);
      if (!isExtreme) return;
      // Retreat check
      const retreat = side === 0 ? (closePrice - price) : (price - closePrice);
      if (retreat < p.minRetreatPts) return;
      diag.passRetreat++;
      // Build trade plan
      const direction: 'long' | 'short' = side === 0 ? 'long' : 'short';
      const entryPrice  = closePrice;  // proxy for next-minute open
      const stopPrice   = direction === 'long' ? price - p.stopBuffer : price + p.stopBuffer;
      const stopDist    = Math.abs(stopPrice - entryPrice);
      if (stopDist > p.maxStopDist) return;
      if (stopDist <= 0) return;
      const targetPrice = direction === 'long' ? entryPrice + p.rr * stopDist : entryPrice - p.rr * stopDist;
      // Cooldown
      const last = direction === 'long' ? lastLongTs : lastShortTs;
      const nextOpenTs = (curMinute + 1) * 60_000;
      if (nextOpenTs - last < p.cooldownMs) { diag.cooldown++; return; }
      if (direction === 'long') lastLongTs = nextOpenTs; else lastShortTs = nextOpenTs;
      if (side === 0) diag.signalsBid++; else diag.signalsAsk++;
      signals.push({
        date,
        triggerEt: etHHMM(minuteStartTs),
        entryTs: nextOpenTs,
        direction, entryPrice, stopPrice, targetPrice, stopDist,
        icebergPrice: price,
        bestTimeMs: s.bestTimeMs, refillCount: s.refillCount, refillVol: s.refillVol, hitVol: s.hitVol,
        retreatPts: retreat,
      });
    }

    // RTH gate — only evaluate signals during RTH minutes
    const mod = etMinutesOfDay(minuteStartTs);
    if (mod >= RTH_START_MIN && mod <= RTH_END_MIN) {
      if (bidCand) evalAndMaybeEmit(bidCand, 0);
      if (askCand) evalAndMaybeEmit(askCand, 1);
    }

    // Reset minute stats
    bidStats.clear();
    askStats.clear();
    minuteHigh = -Infinity;
    minuteLow  =  Infinity;
  }

  for (const ev of mergeEvents(db, date)) {
    diag.events++;
    const minuteIdx = Math.floor(ev.ts / 60_000);
    if (curMinute < 0) curMinute = minuteIdx;
    while (minuteIdx > curMinute) {
      const minuteStartTs = curMinute * 60_000;
      const minuteCloseTs = minuteStartTs + 60_000;
      flushMinute(minuteStartTs, minuteCloseTs, lastPrice);
      curMinute++;
    }

    if (ev.kind === 'd') {
      const sizeMap = ev.side === 0 ? bidSize : askSize;
      const prev = sizeMap.get(ev.price) ?? 0;
      sizeMap.set(ev.price, ev.size);

      if (ev.side === 0) {
        // Was this an update at the current best bid?
        if (ev.price === bestBid) {
          if (ev.size > prev) {
            const s = bidStats.get(ev.price) ?? emptyStats();
            s.refillCount++;
            s.refillVol += (ev.size - prev);
            bidStats.set(ev.price, s);
          }
          if (ev.size === 0) {
            // Close out the time-at-best accumulator and recompute.
            if (bidBestStartedAt > 0) {
              const s = bidStats.get(bestBid) ?? emptyStats();
              s.bestTimeMs += ev.ts - bidBestStartedAt;
              bidStats.set(bestBid, s);
              bidBestStartedAt = -1;
            }
            // Recompute best bid
            let nb = -Infinity;
            for (const [px, sz] of bidSize) if (sz > 0 && px > nb) nb = px;
            bestBid = nb;
            if (isFinite(bestBid)) bidBestStartedAt = ev.ts;
          }
        } else if (ev.size > 0 && ev.price > bestBid) {
          // New best
          if (bidBestStartedAt > 0 && isFinite(bestBid)) {
            const s = bidStats.get(bestBid) ?? emptyStats();
            s.bestTimeMs += ev.ts - bidBestStartedAt;
            bidStats.set(bestBid, s);
          }
          bestBid = ev.price;
          bidBestStartedAt = ev.ts;
        }
      } else {
        if (ev.price === bestAsk) {
          if (ev.size > prev) {
            const s = askStats.get(ev.price) ?? emptyStats();
            s.refillCount++;
            s.refillVol += (ev.size - prev);
            askStats.set(ev.price, s);
          }
          if (ev.size === 0) {
            if (askBestStartedAt > 0) {
              const s = askStats.get(bestAsk) ?? emptyStats();
              s.bestTimeMs += ev.ts - askBestStartedAt;
              askStats.set(bestAsk, s);
              askBestStartedAt = -1;
            }
            let na = Infinity;
            for (const [px, sz] of askSize) if (sz > 0 && px < na) na = px;
            bestAsk = na;
            if (isFinite(bestAsk)) askBestStartedAt = ev.ts;
          }
        } else if (ev.size > 0 && ev.price < bestAsk) {
          if (askBestStartedAt > 0 && isFinite(bestAsk)) {
            const s = askStats.get(bestAsk) ?? emptyStats();
            s.bestTimeMs += ev.ts - askBestStartedAt;
            askStats.set(bestAsk, s);
          }
          bestAsk = ev.price;
          askBestStartedAt = ev.ts;
        }
      }
    } else {
      // Trade
      lastPrice = ev.price;
      if (ev.price > minuteHigh) minuteHigh = ev.price;
      if (ev.price < minuteLow)  minuteLow  = ev.price;
      // Attribute to the side that was hit
      if (ev.isBidAgg === 0) {
        // SELL aggressor hit a bid
        const s = bidStats.get(ev.price) ?? emptyStats();
        s.hitVol += ev.size;
        bidStats.set(ev.price, s);
      } else {
        // BUY aggressor hit an ask
        const s = askStats.get(ev.price) ?? emptyStats();
        s.hitVol += ev.size;
        askStats.set(ev.price, s);
      }
    }
  }

  return { signals, diag };
}

// ─── Outcome scoring ─────────────────────────────────────────────────────────

function scoreOutcome(date: string, s: Signal, db: Database.Database, p: Params): Outcome {
  const endTs = s.entryTs + p.horizonMs;
  const trades = db.prepare(
    `SELECT ts, price FROM trades WHERE symbol='NQ' AND ts >= ? AND ts <= ? ORDER BY ts ASC, id ASC`
  ).all(s.entryTs, endTs) as { ts: number; price: number }[];
  let maxGain = 0, maxDd = 0;
  for (const t of trades) {
    const px = t.price;
    if (s.direction === 'short') {
      const gain = s.entryPrice - px;
      const dd   = px - s.entryPrice;
      if (gain > maxGain) maxGain = gain;
      if (dd   > maxDd)   maxDd   = dd;
      if (px >= s.stopPrice)   return { result:'L', maxGain, maxDd, pnlPts:-s.stopDist,        resolvedInMs: t.ts - s.entryTs };
      if (px <= s.targetPrice) return { result:'W', maxGain, maxDd, pnlPts: p.rr * s.stopDist, resolvedInMs: t.ts - s.entryTs };
    } else {
      const gain = px - s.entryPrice;
      const dd   = s.entryPrice - px;
      if (gain > maxGain) maxGain = gain;
      if (dd   > maxDd)   maxDd   = dd;
      if (px <= s.stopPrice)   return { result:'L', maxGain, maxDd, pnlPts:-s.stopDist,        resolvedInMs: t.ts - s.entryTs };
      if (px >= s.targetPrice) return { result:'W', maxGain, maxDd, pnlPts: p.rr * s.stopDist, resolvedInMs: t.ts - s.entryTs };
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
  console.log(`── ${label} ──  n=${n}  W=${wins}  L=${losses}  T=${timeouts}  WR=${wr.toFixed(1)}%  EV=${(totalPnl/Math.max(n,1)).toFixed(2)}pts  avgStop=${avgStop.toFixed(2)} avgGain=${avgGain.toFixed(2)}  avgDd=${avgDd.toFixed(2)}`);
}

async function main() {
  const arg = process.argv[2];
  let dates: string[];
  let mode: string;
  if (arg === 'test') { mode = 'test'; dates = TEST_DATES; }
  else if (arg && arg.startsWith('2026-')) { mode = 'one'; dates = [arg]; }
  else { mode = 'train'; dates = TRAIN_DATES; }
  const p = DEFAULT_PARAMS;
  console.log(`Iceberg research — mode=${mode} dates=${dates.length}`);
  console.log('Params:', JSON.stringify(p));

  const db = new Database(TICKS_DB, { readonly: true });
  db.pragma('journal_mode = WAL');

  const all: { sig: Signal; out: Outcome }[] = [];
  for (const date of dates) {
    const t0 = Date.now();
    const { signals: sigs, diag } = detect(date, db, p);
    for (const s of sigs) all.push({ sig: s, out: scoreOutcome(date, s, db, p) });
    console.log(`${date}: ev=${diag.events.toLocaleString()} rthMin=${diag.rthMinutes}  max bestT=${diag.maxBestTimeMs}ms refills=${diag.maxRefills} hit=${diag.maxHitVol} rfV=${diag.maxRefillVol}  passT=${diag.passTime} passR=${diag.passRefills} passH=${diag.passHit} passRV=${diag.passRefillVol} all=${diag.passAll} retreat=${diag.passRetreat}  sigB=${diag.signalsBid} sigA=${diag.signalsAsk} cd=${diag.cooldown}  [${((Date.now()-t0)/1000).toFixed(1)}s]`);
  }
  db.close();

  summarize('OVERALL', all);
  summarize('LONG  (bid iceberg)', all.filter(x => x.sig.direction === 'long'));
  summarize('SHORT (ask iceberg)', all.filter(x => x.sig.direction === 'short'));

  console.log('\n── All signals ──');
  console.log('date       trgEt  dir   entry      stop      tgt       stopD  ibPx       bestT(s) refills rfVol hitVol retreat   res  gain  dd');
  for (const { sig, out } of all) {
    console.log(
      `${sig.date}  ${sig.triggerEt}  ${sig.direction.padEnd(5)} ` +
      `${sig.entryPrice.toFixed(2).padStart(8)} ${sig.stopPrice.toFixed(2).padStart(8)} ${sig.targetPrice.toFixed(2).padStart(8)} ` +
      `${sig.stopDist.toFixed(2).padStart(5)}  ${sig.icebergPrice.toFixed(2).padStart(8)}  ${(sig.bestTimeMs/1000).toFixed(1).padStart(6)}  ${String(sig.refillCount).padStart(5)}  ${String(sig.refillVol).padStart(4)}  ${String(sig.hitVol).padStart(5)}  ${sig.retreatPts.toFixed(2).padStart(6)}   ` +
      `${out.result.padStart(3)}  ${out.maxGain.toFixed(1).padStart(4)}  ${out.maxDd.toFixed(1).padStart(4)}`
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
