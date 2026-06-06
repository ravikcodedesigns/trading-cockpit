// Inspect the 13 test-set native icebergs (06-04 RTH) one by one.
// For each: print attributes + outcome under all 4 setups at TP20/SL10 (the best A_BOUNCE grid).

import Database from 'better-sqlite3';

const mboDb   = new Database('/Users/ravikumarbasker/trading-cockpit/data/mbo.db',   { readonly: true });
const ticksDb = new Database('/Users/ravikumarbasker/trading-cockpit/data/ticks.db', { readonly: true });

const SYMBOL_MBO   = 'MNQM';
const SYMBOL_TICKS = 'NQ';
const FWD = 120 * 60_000;

const MIN_REPLACES = 3, MIN_FILL = 50, MIN_RATIO = 2;
const TP = 20, SL = 10;

function etDate(d: string, hh: number, mm: number): number {
  const [y, mo, day] = d.split('-').map(Number);
  return Date.UTC(y!, mo! - 1, day!, hh + 4, mm); // EDT
}
function isRTH(ts: number): boolean {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts));
  const min = parseInt(p.find(x => x.type === 'hour')?.value ?? '0', 10) * 60 + parseInt(p.find(x => x.type === 'minute')?.value ?? '0', 10);
  return min >= 570 && min < 960;
}
function etTime(ts: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ts));
}

const fwdQ = ticksDb.prepare(`SELECT price FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`);
const priceAt = ticksDb.prepare(`SELECT price FROM trades WHERE symbol=? AND ts<=? ORDER BY ts DESC LIMIT 1`);

function simulate(entry: number, ts: number, direction: 'long'|'short'): { outcome: 'W'|'L'|'O'; pts: number } {
  const ticks = fwdQ.all(SYMBOL_TICKS, ts, ts + FWD) as Array<{ price: number }>;
  for (const k of ticks) {
    const m = direction === 'long' ? k.price - entry : entry - k.price;
    if (m >=  TP) return { outcome: 'W', pts:  TP };
    if (m <= -SL) return { outcome: 'L', pts: -SL };
  }
  if (!ticks.length) return { outcome: 'O', pts: 0 };
  const last = ticks[ticks.length-1]!.price;
  const m = direction === 'long' ? last - entry : entry - last;
  return { outcome: m > 0 ? 'W' : m < 0 ? 'L' : 'O', pts: m };
}

// Run setup A,B,C,D for one iceberg
function runAll(ice: any): { a: any; b: any; c: any; d: any } {
  const side = ice.is_bid === 1 ? 'BID' : 'ASK';
  // A: bounce, with iceberg side, mid-lifetime
  const aTs = Math.floor((ice.send_ts_ms + ice.last_ts_ms) / 2);
  const a = simulate(ice.price, aTs, side === 'BID' ? 'long' : 'short');
  // B: break-cont, through iceberg, at last_ts + 5s
  const bTs = ice.last_ts_ms + 5000;
  const bPx = (priceAt.get(SYMBOL_TICKS, bTs) as any)?.price ?? ice.price;
  const b = simulate(bPx, bTs, side === 'BID' ? 'short' : 'long');
  // C: break-fade, opposite
  const c = simulate(bPx, bTs, side === 'BID' ? 'long' : 'short');
  // D: presence, send_ts + 5s, with side
  const dTs = ice.send_ts_ms + 5000;
  const dPx = (priceAt.get(SYMBOL_TICKS, dTs) as any)?.price ?? ice.price;
  const d = simulate(dPx, dTs, side === 'BID' ? 'long' : 'short');
  return { a, b, c, d };
}

const sStart = etDate('2026-06-04', 0, 0);
const sEnd   = etDate('2026-06-05', 0, 0);

const icebergs = mboDb.prepare(`
  SELECT order_id, is_bid, last_price AS price, send_size, fill_size, num_replaces, num_fills,
         send_ts_ms, last_ts_ms
  FROM mbo_orders
  WHERE symbol=? AND num_replaces>=? AND fill_size>=?
    AND CAST(fill_size AS REAL)/NULLIF(send_size,0) >= ?
    AND send_ts_ms>=? AND send_ts_ms<?
    AND status IN ('filled','cancelled','partial')
  ORDER BY send_ts_ms ASC
`).all(SYMBOL_MBO, MIN_REPLACES, MIN_FILL, MIN_RATIO, sStart, sEnd) as any[];

const rth = icebergs.filter(i => isRTH(i.send_ts_ms));

console.log(`Test-set native icebergs (06-04 RTH): ${rth.length}`);
console.log(`Filter: num_replaces≥${MIN_REPLACES}, fill_size≥${MIN_FILL}, fill_size/send_size≥${MIN_RATIO}`);
console.log(`Outcome scoring: TP=${TP} SL=${SL}\n`);

console.log('# | ET time   | side | price     | send | fill | ratio | refresh | fills | lifeSec | A(bounce) | B(break-cont) | C(break-fade) | D(presence)');
console.log('--+-----------+------+-----------+------+------+-------+---------+-------+---------+-----------+---------------+---------------+--------------');

let i = 1;
for (const ice of rth) {
  const r = runAll(ice);
  const side = ice.is_bid === 1 ? 'BID' : 'ASK';
  const life = ((ice.last_ts_ms - ice.send_ts_ms) / 1000).toFixed(0);
  const ratio = (ice.fill_size / ice.send_size).toFixed(1);
  const fmt = (o: any) => `${o.outcome} ${(o.pts >= 0 ? '+' : '')}${o.pts.toFixed(0).padStart(3)}pts`;
  console.log(
    `${String(i).padStart(2)}| ${etTime(ice.send_ts_ms)} | ${side}  | ${String(ice.price).padStart(9)} | ${String(ice.send_size).padStart(4)} | ${String(ice.fill_size).padStart(4)} | ${ratio.padStart(5)}x | ${String(ice.num_replaces).padStart(7)} | ${String(ice.num_fills).padStart(5)} | ${String(life).padStart(7)} | ${fmt(r.a).padEnd(9)} | ${fmt(r.b).padEnd(13)} | ${fmt(r.c).padEnd(13)} | ${fmt(r.d)}`
  );
  i++;
}

console.log('\nLegend: W=hit TP, L=hit SL, O=mark-to-close at 120min');

// Aggregates
const sides = { BID: 0, ASK: 0 };
const tods: Record<string, number> = {};
for (const ice of rth) {
  sides[ice.is_bid === 1 ? 'BID' : 'ASK']++;
  const hr = etTime(ice.send_ts_ms).slice(0, 2);
  tods[hr] = (tods[hr] ?? 0) + 1;
}
console.log(`\nSide distribution: BID=${sides.BID}  ASK=${sides.ASK}`);
console.log(`Hour distribution:`);
for (const [hr, n] of Object.entries(tods).sort()) console.log(`  ${hr}:00 → ${n}`);
