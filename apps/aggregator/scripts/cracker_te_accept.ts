// CRACKER acceptance — tape-events.ts (rebuilt primitive #4, the E0 taxonomy).
// Every detector: fires on a scripted scenario with hand-computed trigger
// values, stays silent below threshold / before warmup / under refractory /
// on uncovered windows, and is deterministic.
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_te_accept.ts
import { MarketBook } from '../src/l3/market-book.js';
import { TapeEventEngine, TE_CFG, type TapeEvent } from '../src/l3/tape-events.js';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); ok ? pass++ : fail++; };
const MID = 120_000;

/** Book with a standing two-sided market around MID. */
function mkBook(): MarketBook {
  const b = new MarketBook('NQ', 0.25);
  b.applyDepth({ ts: 0, priceInt: MID - 1, size: 10, isBid: true });
  b.applyDepth({ ts: 0, priceInt: MID + 1, size: 10, isBid: false });
  return b;
}
/** Calm background: small balanced trades each second (warms median rings). */
function calm(e: TapeEventEngine, b: MarketBook, out: TapeEvent[], t0: number, seconds: number): number {
  let ts = t0;
  for (let i = 0; i < seconds; i++) {
    ts = t0 + i * 1000;
    e.onTrade({ ts, priceInt: MID + (i % 3) - 1, size: 2, buy: i % 2 === 0 }, out);
    e.onTrade({ ts: ts + 200, priceInt: MID - (i % 3) + 1, size: 2, buy: i % 2 === 1 }, out);
    e.tick(b, ts + 500, out);
  }
  return ts + 1000;
}

// ── T1/T2: sweeps ──
{
  const b = mkBook(), e = new TapeEventEngine(), out: TapeEvent[] = [];
  let ts = 1_000_000;
  for (const pi of [MID, MID + 1, MID + 2, MID + 3]) e.onTrade({ ts: ts += 10, priceInt: pi, size: 5, buy: true, aggId: 'AGG1' }, out);
  e.onTrade({ ts: ts + 20, priceInt: MID, size: 1, buy: false, aggId: 'OTHER' }, out);   // closes AGG1's execution
  e.tick(b, ts + TE_CFG.SWEEP_MERGE_MS + 2000, out);                                    // flush merge buffer
  const sw = out.filter((x) => x.type === 'sweep');
  check('T1a sweep detected once (4 prices, one aggressor)', sw.length === 1 && sw[0]!.dir === 1, `${sw.length} events`);
  check('T1b intensity = prices × size', sw[0]!.intensity === 4 * 20 && sw[0]!.meta.prices === 4);
  const b2 = mkBook(), e2 = new TapeEventEngine(), out2: TapeEvent[] = [];
  ts = 1_000_000;
  for (const pi of [MID, MID + 1]) e2.onTrade({ ts: ts += 10, priceInt: pi, size: 5, buy: true, aggId: 'A' }, out2);
  e2.onTrade({ ts: ts + 20, priceInt: MID, size: 1, buy: false, aggId: 'B' }, out2);
  e2.tick(b2, ts + 10_000, out2);
  check('T2 two-price execution is NOT a sweep', out2.filter((x) => x.type === 'sweep').length === 0);
  // merge: two same-direction qualifying executions 1s apart → ONE event
  const b3 = mkBook(), e3 = new TapeEventEngine(), out3: TapeEvent[] = [];
  ts = 2_000_000;
  for (const pi of [MID, MID + 1, MID + 2]) e3.onTrade({ ts: ts += 10, priceInt: pi, size: 4, buy: true, aggId: 'S1' }, out3);
  e3.onTrade({ ts: ts += 10, priceInt: MID, size: 1, buy: false, aggId: 'X' }, out3);
  ts += 1000;
  for (const pi of [MID + 3, MID + 4, MID + 5]) e3.onTrade({ ts: ts += 10, priceInt: pi, size: 4, buy: true, aggId: 'S2' }, out3);
  e3.onTrade({ ts: ts += 10, priceInt: MID, size: 1, buy: false, aggId: 'Y' }, out3);
  e3.tick(b3, ts + TE_CFG.SWEEP_MERGE_MS + 2000, out3);
  const swm = out3.filter((x) => x.type === 'sweep');
  check('T3 same-direction sweeps within merge window → ONE event, union of prices', swm.length === 1 && swm[0]!.meta.prices === 6, `${swm.length} ev, prices ${swm[0]?.meta.prices}`);
}

// ── T4: imbalance (hand-computed Kish z) ──
{
  const b = mkBook(), e = new TapeEventEngine(), out: TapeEvent[] = [];
  let ts = 1_000_000;
  // 10 buys of 9 lots: delta 90, √Σs² = √810 ≈ 28.46 → z ≈ 3.162 ≥ 3
  for (let i = 0; i < 10; i++) e.onTrade({ ts: ts += 100, priceInt: MID, size: 9, buy: true }, out);
  e.tick(b, ts + 100, out);
  const im = out.filter((x) => x.type === 'imbalance');
  check('T4 imbalance fires at hand-computed z=3.16', im.length === 1 && im[0]!.dir === 1 && Math.abs(im[0]!.intensity - 90 / Math.sqrt(810)) < 1e-9, `z=${im[0]?.intensity.toFixed(3)}`);
}

// ── T5: absorption (median-relative, direction = absorbing side) ──
{
  const b = mkBook(), e = new TapeEventEngine(), out: TapeEvent[] = [];
  const t1 = calm(e, b, out, 1_000_000, TE_CFG.MED_WARMUP + 10);
  out.length = 0;
  // burst: heavy BUY volume in a 1-tick range → buyers absorbed → dir −1
  let ts = t1;
  for (let i = 0; i < 40; i++) e.onTrade({ ts: ts += 50, priceInt: MID, size: 30, buy: true }, out);
  e.tick(b, ts + 100, out);
  const ab = out.filter((x) => x.type === 'absorption');
  check('T5 absorption fires after warmup, dir = absorbing side (buyers absorbed → −1)', ab.length === 1 && ab[0]!.dir === -1 && ab[0]!.intensity >= TE_CFG.ABS_MULT, `int ${ab[0]?.intensity.toFixed(1)}`);
}

// ── T6: warmup guard — the same burst WITHOUT calm history stays silent ──
{
  const b = mkBook(), e = new TapeEventEngine(), out: TapeEvent[] = [];
  let ts = 1_000_000;
  for (let i = 0; i < 40; i++) e.onTrade({ ts: ts += 50, priceInt: MID, size: 30, buy: true }, out);
  e.tick(b, ts + 100, out);
  check('T6 median detectors silent before MED_WARMUP', out.filter((x) => x.type === 'absorption' || x.type === 'wallpull').length === 0);
}

// ── T7: wall-pull (cancel storm vs trailing median) ──
{
  const b = mkBook(), e = new TapeEventEngine(), out: TapeEvent[] = [];
  // background: steady small cancels (median > 0) + calm trades
  let oid = 0;
  for (let i = 0; i < TE_CFG.MED_WARMUP + 10; i++) {
    const ts = 1_000_000 + i * 1000;
    b.applySend({ ts, orderId: `w${++oid}`, priceInt: MID - 2, size: 2, isBid: true });
    b.applyCancel({ ts: ts + 100, orderId: `w${oid}` });
    e.onTrade({ ts: ts + 200, priceInt: MID, size: 2, buy: i % 2 === 0 }, out);
    e.tick(b, ts + 500, out);
  }
  out.length = 0;
  // storm: pull 40 bid orders of 20 lots inside one window
  const t1 = 1_000_000 + (TE_CFG.MED_WARMUP + 10) * 1000;
  for (let i = 0; i < 40; i++) {
    b.applySend({ ts: t1 + i * 100, orderId: `s${i}`, priceInt: MID - 3, size: 20, isBid: true });
    b.applyCancel({ ts: t1 + i * 100 + 50, orderId: `s${i}` });
  }
  e.onTrade({ ts: t1 + 4100, priceInt: MID, size: 2, buy: true }, out);
  e.tick(b, t1 + 4200, out);
  const wp = out.filter((x) => x.type === 'wallpull');
  check('T7 wall-pull fires on cancel storm, bid pull ⇒ bearish', wp.length === 1 && wp[0]!.dir === -1, `int ${wp[0]?.intensity.toFixed(1)}`);
}

// ── T8: replenishment (fill→repost chains near mid) ──
{
  const b = mkBook(), e = new TapeEventEngine(), out: TapeEvent[] = [];
  let ts = 1_000_000;
  for (let i = 0; i < 6; i++) {
    const oid = `rp${i}`;
    b.applySend({ ts: ts += 100, orderId: oid, priceInt: MID - 1, size: 3, isBid: true });
    b.applyTrade({ ts: ts += 100, priceInt: MID - 1, size: 3, isBuy: false, passId: oid });   // full fill
    b.applySend({ ts: ts += 200, orderId: `${oid}b`, priceInt: MID - 1, size: 3, isBid: true });  // repost ≤1.5s ⇒ refill
  }
  e.onTrade({ ts: ts += 100, priceInt: MID, size: 1, buy: true }, out);
  e.tick(b, ts + 100, out);
  const rp = out.filter((x) => x.type === 'replenishment');
  check('T8 replenishment fires at ≥5 chains, bid side ⇒ bullish defense', rp.length === 1 && rp[0]!.dir === 1 && rp[0]!.intensity >= TE_CFG.REFILL_MIN, `n=${rp[0]?.intensity}`);
}

// ── T9: refractory — same (type,dir) within 30s emits once ──
{
  const b = mkBook(), e = new TapeEventEngine(), out: TapeEvent[] = [];
  let ts = 1_000_000;
  for (let i = 0; i < 10; i++) e.onTrade({ ts: ts += 100, priceInt: MID, size: 9, buy: true }, out);
  e.tick(b, ts + 100, out);
  for (let i = 0; i < 10; i++) e.onTrade({ ts: ts += 100, priceInt: MID, size: 9, buy: true }, out);
  e.tick(b, ts + 1200, out);
  check('T9 refractory: burst = one event', out.filter((x) => x.type === 'imbalance' && x.dir === 1).length === 1);
}

// ── T10: determinism ──
{
  const run = (): string => {
    const b = mkBook(), e = new TapeEventEngine(), out: TapeEvent[] = [];
    const t1 = calm(e, b, out, 1_000_000, TE_CFG.MED_WARMUP + 5);
    let ts = t1;
    for (let i = 0; i < 30; i++) e.onTrade({ ts: ts += 60, priceInt: MID + (i % 4), size: 25, buy: true, aggId: `g${i % 5}` }, out);
    e.tick(b, ts + 200, out);
    return JSON.stringify(out);
  };
  check('T10 determinism: identical feed → identical events', run() === run());
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ' — FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);
