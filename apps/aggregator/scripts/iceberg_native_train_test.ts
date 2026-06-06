// NATIVE iceberg train/test backtest.
//
// Native CME iceberg signature: one persistent order_id with num_replaces ≥ N,
// where fill_size > send_size (hidden quantity drained via auto-refresh).
//
// TRAIN: 2026-06-02 + 2026-06-03 RTH (NQ via MNQM)
// TEST:  2026-06-04 RTH

import Database from 'better-sqlite3';

const mboDb   = new Database('/Users/ravikumarbasker/trading-cockpit/data/mbo.db',   { readonly: true });
const ticksDb = new Database('/Users/ravikumarbasker/trading-cockpit/data/ticks.db', { readonly: true });

const SYMBOL_MBO   = 'MNQM';
const SYMBOL_TICKS = 'NQ';
const POINT_VALUE_USD = 2;
const FWD_WINDOW_MS = 120 * 60_000;

// ── Native iceberg criteria ──
const MIN_REPLACES = 3;     // ≥3 displayed-size refreshes
const MIN_FILL_VS_SEND = 2; // fill_size ≥ 2× send_size (hidden pool real)
const MIN_FILL_SIZE = 50;   // ≥50 contracts cumulative trade volume

type Setup = 'A_BOUNCE' | 'B_BREAK_CONT' | 'C_BREAK_FADE' | 'D_PRESENCE';
const SETUPS: Setup[] = ['A_BOUNCE', 'B_BREAK_CONT', 'C_BREAK_FADE', 'D_PRESENCE'];

const GRIDS: Array<{tp: number; sl: number}> = [
  { tp: 10, sl: 5 },
  { tp: 15, sl: 10 },
  { tp: 20, sl: 10 },
  { tp: 30, sl: 15 },
  { tp: 60, sl: 30 },
];

// ── Time helpers ──
function etDateTimeToMs(d: string, hh: number, mm: number): number {
  const [y, mo, day] = d.split('-').map(Number);
  return Date.UTC(y!, mo! - 1, day!, hh + 4, mm); // EDT
}

function isInRTH(ts: number): boolean {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts));
  const h = parseInt(p.find(x => x.type === 'hour')?.value ?? '0', 10);
  const m = parseInt(p.find(x => x.type === 'minute')?.value ?? '0', 10);
  return (h * 60 + m) >= 570 && (h * 60 + m) < 960;
}

// ── Find native icebergs in window ──
interface Iceberg {
  order_id: string;
  is_bid: number;
  price: number;     // last_price
  send_size: number;
  fill_size: number;
  num_replaces: number;
  num_fills: number;
  send_ts_ms: number;
  last_ts_ms: number;
}

function findNativeIcebergs(startMs: number, endMs: number): Iceberg[] {
  return mboDb.prepare(`
    SELECT order_id, is_bid, last_price AS price,
           send_size, fill_size, num_replaces, num_fills,
           send_ts_ms, last_ts_ms
    FROM mbo_orders
    WHERE symbol = ?
      AND num_replaces >= ?
      AND fill_size >= ?
      AND CAST(fill_size AS REAL) / NULLIF(send_size, 0) >= ?
      AND send_ts_ms >= ?
      AND send_ts_ms < ?
      AND status IN ('filled','cancelled','partial')
    ORDER BY send_ts_ms ASC
  `).all(SYMBOL_MBO, MIN_REPLACES, MIN_FILL_SIZE, MIN_FILL_VS_SEND, startMs, endMs) as Iceberg[];
}

// ── Outcome simulation ──
const fwdQ = ticksDb.prepare(
  `SELECT price, ts FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`
);

interface Trade { entry: number; ts: number; direction: 'long' | 'short'; }

function simulate(t: Trade, tp: number, sl: number): { outcome: 'W'|'L'|'O'; pnlPts: number } {
  const ticks = fwdQ.all(SYMBOL_TICKS, t.ts, t.ts + FWD_WINDOW_MS) as Array<{ price: number; ts: number }>;
  let pnl = 0, outcome: 'W'|'L'|'O' = 'O';
  for (const k of ticks) {
    const m = t.direction === 'long' ? k.price - t.entry : t.entry - k.price;
    if (m >=  tp) { outcome = 'W'; pnl =  tp; break; }
    if (m <= -sl) { outcome = 'L'; pnl = -sl; break; }
  }
  if (outcome === 'O' && ticks.length) {
    const last = ticks[ticks.length-1]!.price;
    const m = t.direction === 'long' ? last - t.entry : t.entry - last;
    pnl = m;
    outcome = m > 0 ? 'W' : m < 0 ? 'L' : 'O';
  }
  return { outcome, pnlPts: pnl };
}

// ── Entry trigger per setup ──
const priceAt = ticksDb.prepare(`SELECT price FROM trades WHERE symbol=? AND ts<=? ORDER BY ts DESC LIMIT 1`);

function defineEntry(ice: Iceberg, setup: Setup): Trade | null {
  const side = ice.is_bid === 1 ? 'BID' : 'ASK';

  if (setup === 'A_BOUNCE') {
    // Confirm bounce: enter at iceberg price, ON iceberg side (BID = long support)
    // Use midpoint of lifetime as the "confirmation" timestamp.
    const midTs = Math.floor((ice.send_ts_ms + ice.last_ts_ms) / 2);
    return {
      ts: midTs,
      entry: ice.price,
      direction: side === 'BID' ? 'long' : 'short',
    };
  }

  if (setup === 'B_BREAK_CONT' || setup === 'C_BREAK_FADE') {
    // Iceberg consumed when last_ts_ms passes. Add small buffer for break confirmation.
    const breakTs = ice.last_ts_ms + 5_000;
    const tk = priceAt.get(SYMBOL_TICKS, breakTs) as { price: number } | undefined;
    if (!tk) return null;
    const breakPrice = tk.price;
    if (setup === 'B_BREAK_CONT') {
      // continuation THROUGH iceberg: long if ASK broken up, short if BID broken down
      return { ts: breakTs, entry: breakPrice, direction: side === 'BID' ? 'short' : 'long' };
    } else {
      // fade: opposite direction
      return { ts: breakTs, entry: breakPrice, direction: side === 'BID' ? 'long' : 'short' };
    }
  }

  if (setup === 'D_PRESENCE') {
    // Enter at send_ts_ms (earliest detection — but we don't actually know it's an iceberg
    // until refreshes confirm; for the backtest assume detection latency = 5s after first replace).
    // Use send_ts_ms + 5s as a proxy.
    const entryTs = ice.send_ts_ms + 5_000;
    const tk = priceAt.get(SYMBOL_TICKS, entryTs) as { price: number } | undefined;
    if (!tk) return null;
    return {
      ts: entryTs,
      entry: tk.price,
      direction: side === 'BID' ? 'long' : 'short',
    };
  }
  return null;
}

interface R { setup: Setup; tp: number; sl: number; n: number; w: number; l: number; o: number; netPts: number; }
function backtest(ices: Iceberg[]): R[] {
  const out: R[] = [];
  for (const setup of SETUPS) {
    for (const g of GRIDS) {
      let w=0,l=0,o=0,pts=0,n=0;
      for (const ice of ices) {
        const t = defineEntry(ice, setup);
        if (!t) continue;
        const r = simulate(t, g.tp, g.sl);
        n++;
        if (r.outcome === 'W') w++; else if (r.outcome === 'L') l++; else o++;
        pts += r.pnlPts;
      }
      out.push({ setup, tp: g.tp, sl: g.sl, n, w, l, o, netPts: pts });
    }
  }
  return out;
}

// ── Main ──
console.log('Native iceberg detection — train/test split');
console.log(`Filters: num_replaces≥${MIN_REPLACES}, fill_size≥${MIN_FILL_SIZE}, fill_size/send_size≥${MIN_FILL_VS_SEND}`);
console.log();

const tStart = etDateTimeToMs('2026-06-02', 0, 0);
const tEnd   = etDateTimeToMs('2026-06-04', 0, 0);
const sStart = etDateTimeToMs('2026-06-04', 0, 0);
const sEnd   = etDateTimeToMs('2026-06-05', 0, 0);

console.time('detect train');
const trainAll = findNativeIcebergs(tStart, tEnd);
const trainIce = trainAll.filter(i => isInRTH(i.send_ts_ms));
console.timeEnd('detect train');
console.log(`Train (06-02..06-03):  total=${trainAll.length}  RTH=${trainIce.length}`);

console.time('detect test');
const testAll = findNativeIcebergs(sStart, sEnd);
const testIce = testAll.filter(i => isInRTH(i.send_ts_ms));
console.timeEnd('detect test');
console.log(`Test  (06-04):         total=${testAll.length}  RTH=${testIce.length}\n`);

if (trainIce.length === 0 || testIce.length === 0) {
  console.error('Insufficient native icebergs — relax criteria or check ingest.');
  process.exit(1);
}

console.log('Train sample (first 8, sorted by fill_size DESC):');
[...trainIce].sort((a,b) => b.fill_size - a.fill_size).slice(0, 8).forEach(ice => {
  const side = ice.is_bid === 1 ? 'BID' : 'ASK';
  const life = ice.last_ts_ms - ice.send_ts_ms;
  const tEt = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'}).format(new Date(ice.send_ts_ms));
  console.log(`  ${tEt} ET  ${side}@${ice.price}  send=${ice.send_size}  fill=${ice.fill_size}(${(ice.fill_size/ice.send_size).toFixed(1)}x)  replaces=${ice.num_replaces}  fills=${ice.num_fills}  lifeSec=${(life/1000).toFixed(0)}`);
});
console.log();

console.time('backtest train');
const trainR = backtest(trainIce);
console.timeEnd('backtest train');

console.time('backtest test');
const testR = backtest(testIce);
console.timeEnd('backtest test');

function fmtRow(r: R): string {
  const denom = r.w + r.l;
  const wr = denom ? (r.w/denom*100).toFixed(0) : '--';
  const ev = r.n ? (r.netPts/r.n).toFixed(2) : '0';
  const dollars = (r.netPts * POINT_VALUE_USD).toFixed(0);
  return `${r.setup.padEnd(14)}  TP${String(r.tp).padStart(2)}/SL${String(r.sl).padStart(2)}  n=${String(r.n).padStart(4)}  W=${String(r.w).padStart(4)}  L=${String(r.l).padStart(4)}  O=${String(r.o).padStart(3)}  WR=${String(wr).padStart(4)}%  EV=${String(ev).padStart(7)}pts  net=${String(r.netPts.toFixed(0)).padStart(7)}pts  $@MNQ=${parseFloat(dollars) >= 0 ? '+$' : '-$'}${Math.abs(parseFloat(dollars))}`;
}

const sortByEv = (a: R, b: R) => (b.netPts/Math.max(b.n,1)) - (a.netPts/Math.max(a.n,1));

console.log('\n═══ TRAIN RESULTS (06-02 + 06-03 RTH) ═══');
[...trainR].sort(sortByEv).forEach(r => console.log(fmtRow(r)));

console.log('\n═══ TEST RESULTS (06-04 RTH) ═══');
[...testR].sort(sortByEv).forEach(r => console.log(fmtRow(r)));

// Compare
const testByKey = new Map<string, R>();
for (const r of testR) testByKey.set(`${r.setup}|${r.tp}|${r.sl}`, r);

console.log('\n═══ TRAIN/TEST COMPARISON (top 8 by train EV) ═══');
console.log(`${'setup'.padEnd(14)} ${'tp/sl'.padEnd(8)} ${'TRAIN'.padEnd(30)} ${'TEST'.padEnd(30)} verdict`);
const top = [...trainR].sort(sortByEv).slice(0, 8);
for (const tr of top) {
  const te = testByKey.get(`${tr.setup}|${tr.tp}|${tr.sl}`)!;
  const trEv = tr.n ? tr.netPts/tr.n : 0;
  const teEv = te.n ? te.netPts/te.n : 0;
  const hold = trEv !== 0 ? teEv/trEv : 0;
  const verdict = teEv > 0 && hold > 0.6 ? '✅ holds'
                : teEv > 0 && hold > 0.3 ? '⚠️  weak'
                : '❌ overfit';
  const trS = `n=${tr.n} WR=${tr.w+tr.l ? (tr.w/(tr.w+tr.l)*100).toFixed(0) : '-'}% EV=${trEv.toFixed(1)}`;
  const teS = `n=${te.n} WR=${te.w+te.l ? (te.w/(te.w+te.l)*100).toFixed(0) : '-'}% EV=${teEv.toFixed(1)}`;
  console.log(`${tr.setup.padEnd(14)} TP${String(tr.tp).padStart(2)}/SL${String(tr.sl).padStart(2)}  ${trS.padEnd(30)} ${teS.padEnd(30)} ${verdict}`);
}
