import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });

// Load signals for both strategies
const signals = db.prepare(`
  SELECT id, ts, symbol, direction, score, rule_id,
    COALESCE(
      json_extract(payload, '$.entry'),
      NULL
    ) AS entry_price,
    json_extract(payload, '$.rangeHigh') AS rangeHigh
  FROM signals
  WHERE rule_id IN ('clean-impulse', 'expl') AND direction = 'long'
  ORDER BY ts ASC
`).all() as any[];

const fwdQuery = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`
);
// Get ticks in a window — used to build candles
const candleQuery = ticksDb.prepare(
  `SELECT ts, price FROM trades WHERE symbol=? AND ts >= ? AND ts < ? ORDER BY ts ASC`
);

function getETMin(ts: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts));
  return parseInt(p.find(x => x.type === 'hour')?.value ?? '0', 10) * 60 + parseInt(p.find(x => x.type === 'minute')?.value ?? '0', 10);
}
function getETDate(ts: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

// Build OHLC bars of given interval (ms) from a tick array
function buildBars(ticks: {ts:number,price:number}[], intervalMs: number): {ts:number,open:number,high:number,low:number,close:number}[] {
  const map = new Map<number, {open:number,high:number,low:number,close:number}>();
  for (const t of ticks) {
    const k = Math.floor(t.ts / intervalMs) * intervalMs;
    const b = map.get(k);
    if (!b) map.set(k, { open: t.price, high: t.price, low: t.price, close: t.price });
    else {
      if (t.price > b.high) b.high = t.price;
      if (t.price < b.low)  b.low  = t.price;
      b.close = t.price;
    }
  }
  return [...map.entries()].sort(([a],[b])=>a-b).map(([ts,b])=>({ts,...b}));
}

const HR1  = 60 * 60_000;
const HR4  = 4  * 60_000 * 60;
const WIN_PTS = 80, SL = 50, WINDOW_MS = 120 * 60_000;

interface Result {
  id: number; ruleId: string; sym: string; date: string; etMin: number; score: number;
  entry: number;
  // 1h regime
  h1Bull: boolean | null;   // last complete 1h close > prev 1h close
  h1Green: boolean | null;  // last complete 1h close > open
  // 4h regime
  h4Bull: boolean | null;   // last complete 4h close > prev 4h close
  h4Green: boolean | null;  // last complete 4h close > open
  // combined
  maxGain: number; maxDD: number; outcome: 'W'|'L'|'O';
}

const results: Result[] = [];

for (const sig of signals) {
  const etMin = getETMin(sig.ts);
  if (etMin < 570 || etMin >= 960) continue;

  // entry price: clean-impulse has entry in payload, expl uses current price at signal time
  let entry: number = sig.entry_price;
  if (!entry) {
    const row = ticksDb.prepare('SELECT price FROM trades WHERE symbol=? AND ts<=? ORDER BY ts DESC LIMIT 1').get(sig.symbol, sig.ts) as any;
    if (!row) continue;
    entry = row.price;
  }

  // Build candles from ticks in a 6h lookback window
  const lookback = sig.ts - 6 * HR1;
  const rawTicks = candleQuery.all(sig.symbol, lookback, sig.ts) as {ts:number,price:number}[];

  const bars1h = buildBars(rawTicks, HR1);
  const bars4h = buildBars(rawTicks, HR4);

  // Last complete bar = last bar whose ts + interval <= sig.ts
  const complete1h = bars1h.filter(b => b.ts + HR1 <= sig.ts);
  const complete4h = bars4h.filter(b => b.ts + HR4 <= sig.ts);

  const last1h  = complete1h.at(-1) ?? null;
  const prev1h  = complete1h.at(-2) ?? null;
  const last4h  = complete4h.at(-1) ?? null;
  const prev4h  = complete4h.at(-2) ?? null;

  const h1Bull  = last1h && prev1h ? last1h.close > prev1h.close : null;
  const h1Green = last1h ? last1h.close > last1h.open : null;
  const h4Bull  = last4h && prev4h ? last4h.close > prev4h.close : null;
  const h4Green = last4h ? last4h.close > last4h.open : null;

  // Forward outcome
  const fwd = fwdQuery.all(sig.symbol, sig.ts, sig.ts + WINDOW_MS) as {price:number}[];
  let maxGain=0, maxDD=0, hitTP=false, tpIdx=fwd.length;
  for (let i=0;i<fwd.length;i++) { if(fwd[i].price-entry>=WIN_PTS){hitTP=true;tpIdx=i;break;} }
  for (let i=0;i<=(hitTP?tpIdx:fwd.length-1);i++) { const dd=entry-fwd[i].price; if(dd>maxDD)maxDD=dd; }
  for (const t of fwd) { const g=t.price-entry; if(g>maxGain)maxGain=g; }
  let outcome:'W'|'L'|'O'='O';
  for (const t of fwd) { const g=t.price-entry; if(g>=WIN_PTS){outcome='W';break;} if(g<=-SL){outcome='L';break;} }

  results.push({
    id: sig.id, ruleId: sig.rule_id, sym: sig.symbol,
    date: getETDate(sig.ts), etMin, score: sig.score, entry,
    h1Bull, h1Green, h4Bull, h4Green,
    maxGain, maxDD, outcome,
  });
}

function stats(r: Result[], label: string) {
  const w=r.filter(x=>x.outcome==='W'), l=r.filter(x=>x.outcome==='L'), o=r.filter(x=>x.outcome==='O');
  const t=w.length+l.length, pnl=w.length*WIN_PTS-l.length*SL;
  const wr=t>0?(w.length/t*100).toFixed(0)+'%':'—';
  const edge=t>0?(pnl/t).toFixed(1):'—';
  console.log(`${label.padEnd(44)} N=${String(r.length).padStart(3)} W=${String(w.length).padStart(2)} L=${String(l.length).padStart(2)} O=${String(o.length).padStart(2)} | WR=${wr.padStart(4)} | Edge=${String(edge).padStart(6)}pts/trade`);
}

for (const ruleId of ['clean-impulse', 'expl']) {
  const r = results.filter(x => x.ruleId === ruleId);
  const label = ruleId === 'clean-impulse' ? 'CLEAN FLIP' : 'EXPL';
  console.log(`\n${'='.repeat(80)}`);
  console.log(`=== ${label} LONG — Regime filter analysis ===`);
  console.log('='.repeat(80));

  console.log('\n--- OVERALL ---');
  stats(r, 'All signals');
  console.log();

  console.log('--- 1H REGIME (last complete 1h bar before signal) ---');
  stats(r.filter(x=>x.h1Bull===true),  '1h close > prev 1h close (bullish)');
  stats(r.filter(x=>x.h1Bull===false), '1h close < prev 1h close (bearish)');
  stats(r.filter(x=>x.h1Green===true),  '1h bar green (close > open)');
  stats(r.filter(x=>x.h1Green===false), '1h bar red   (close < open)');
  console.log();

  console.log('--- 4H REGIME (last complete 4h bar before signal) ---');
  stats(r.filter(x=>x.h4Bull===true),  '4h close > prev 4h close (bullish)');
  stats(r.filter(x=>x.h4Bull===false), '4h close < prev 4h close (bearish)');
  stats(r.filter(x=>x.h4Green===true),  '4h bar green (close > open)');
  stats(r.filter(x=>x.h4Green===false), '4h bar red   (close < open)');
  console.log();

  console.log('--- COMBINED: 1h AND 4h both bullish ---');
  stats(r.filter(x=>x.h1Bull===true  && x.h4Bull===true),  'Both 1h+4h bullish (direction)');
  stats(r.filter(x=>x.h1Green===true && x.h4Green===true), 'Both 1h+4h green (bar color)');
  stats(r.filter(x=>x.h1Bull===true  && x.h4Green===true), '1h bullish + 4h green');
  stats(r.filter(x=>!(x.h1Bull===true && x.h4Bull===true)), 'At least one NOT bullish');
  console.log();

  console.log('--- DETAIL: each signal ---');
  console.log(`${'Date'.padEnd(6)} ${'Time'.padEnd(6)} ${'Scr'.padEnd(4)} ${'1hBull'.padEnd(7)} ${'1hGrn'.padEnd(6)} ${'4hBull'.padEnd(7)} ${'4hGrn'.padEnd(6)} ${'MaxGain'.padStart(8)} ${'MaxDD'.padStart(7)}  Out`);
  console.log('-'.repeat(72));
  for (const x of r) {
    const hh=Math.floor(x.etMin/60).toString().padStart(2,'0');
    const mm=(x.etMin%60).toString().padStart(2,'0');
    const yn = (v:boolean|null) => v===null?'?':v?'Y':'N';
    console.log(`${x.date.padEnd(6)} ${(hh+':'+mm).padEnd(6)} ${String(x.score).padEnd(4)} ${yn(x.h1Bull).padEnd(7)} ${yn(x.h1Green).padEnd(6)} ${yn(x.h4Bull).padEnd(7)} ${yn(x.h4Green).padEnd(6)} ${('+'+x.maxGain.toFixed(1)).padStart(8)} ${('-'+x.maxDD.toFixed(1)).padStart(7)}  ${x.outcome}`);
  }
}

db.close();
ticksDb.close();
