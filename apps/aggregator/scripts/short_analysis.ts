import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });

const signals = db.prepare(`
  SELECT id, ts, symbol, direction, score, rule_id,
    json_extract(payload, '$.entry') AS entry_price
  FROM signals
  WHERE rule_id IN ('clean-impulse', 'expl') AND direction = 'short'
  ORDER BY ts ASC
`).all() as any[];

const fwdQuery = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`
);
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
function getDOW(ts: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(ts));
}

function buildBars(ticks: {ts:number,price:number}[], intervalMs: number) {
  const map = new Map<number, {open:number,high:number,low:number,close:number}>();
  for (const t of ticks) {
    const k = Math.floor(t.ts / intervalMs) * intervalMs;
    const b = map.get(k);
    if (!b) map.set(k, { open: t.price, high: t.price, low: t.price, close: t.price });
    else { if (t.price > b.high) b.high=t.price; if (t.price < b.low) b.low=t.price; b.close=t.price; }
  }
  return [...map.entries()].sort(([a],[b])=>a-b).map(([ts,b])=>({ts,...b}));
}

const HR1 = 60 * 60_000;
const HR4 = 4  * 60_000 * 60;
// For shorts: TP = price falls 80pts, SL = price rises 50pts
const WIN_PTS = 80, SL = 50, WINDOW_MS = 120 * 60_000;

interface Result {
  id: number; ruleId: string; sym: string; date: string; dow: string; etMin: number; score: number;
  entry: number; h1Bear: boolean|null; h1Red: boolean|null; h4Bear: boolean|null; h4Red: boolean|null;
  maxGain: number; maxDD: number; outcome: 'W'|'L'|'O';
}

const results: Result[] = [];

for (const sig of signals) {
  const etMin = getETMin(sig.ts);
  if (etMin < 570 || etMin >= 960) continue;
  let entry: number = sig.entry_price;
  if (!entry) {
    const row = ticksDb.prepare('SELECT price FROM trades WHERE symbol=? AND ts<=? ORDER BY ts DESC LIMIT 1').get(sig.symbol, sig.ts) as any;
    if (!row) continue;
    entry = row.price;
  }

  // Build candles from 6h lookback
  const rawTicks = candleQuery.all(sig.symbol, sig.ts - 6*HR1, sig.ts) as {ts:number,price:number}[];
  const bars1h = buildBars(rawTicks, HR1);
  const bars4h = buildBars(rawTicks, HR4);
  const c1h = bars1h.filter(b => b.ts + HR1 <= sig.ts);
  const c4h = bars4h.filter(b => b.ts + HR4 <= sig.ts);
  const last1h = c1h.at(-1) ?? null, prev1h = c1h.at(-2) ?? null;
  const last4h = c4h.at(-1) ?? null, prev4h = c4h.at(-2) ?? null;

  // For shorts: bearish = close < prev close, red = close < open
  const h1Bear  = last1h && prev1h ? last1h.close < prev1h.close : null;
  const h1Red   = last1h ? last1h.close < last1h.open : null;
  const h4Bear  = last4h && prev4h ? last4h.close < prev4h.close : null;
  const h4Red   = last4h ? last4h.close < last4h.open : null;

  const fwd = fwdQuery.all(sig.symbol, sig.ts, sig.ts + WINDOW_MS) as {price:number}[];

  // For shorts: gain = entry - price (price falls), DD = price - entry (price rises)
  let maxGain=0, maxDD=0, hitTP=false, tpIdx=fwd.length;
  for (let i=0;i<fwd.length;i++) { if(entry-fwd[i].price>=WIN_PTS){hitTP=true;tpIdx=i;break;} }
  for (let i=0;i<=(hitTP?tpIdx:fwd.length-1);i++) { const dd=fwd[i].price-entry; if(dd>maxDD)maxDD=dd; }
  for (const t of fwd) { const g=entry-t.price; if(g>maxGain)maxGain=g; }

  let outcome:'W'|'L'|'O'='O';
  for (const t of fwd) {
    const g = entry - t.price;
    if (g >= WIN_PTS)  { outcome='W'; break; }
    if (g <= -SL)      { outcome='L'; break; }
  }

  results.push({
    id: sig.id, ruleId: sig.rule_id, sym: sig.symbol,
    date: getETDate(sig.ts), dow: getDOW(sig.ts), etMin, score: sig.score, entry,
    h1Bear, h1Red, h4Bear, h4Red, maxGain, maxDD, outcome,
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
  const label = ruleId === 'clean-impulse' ? 'CLEAN FLIP SHORT' : 'EXPL SHORT';
  console.log(`\n${'='.repeat(80)}`);
  console.log(`=== ${label} — Analysis (SL=50, TP=80, 120min) ===`);
  console.log('='.repeat(80));

  console.log('\n--- OVERALL ---');
  stats(r, 'All signals');
  console.log();

  console.log('--- BY SCORE ---');
  for (const s of [100,95,90,85,80]) { const sr=r.filter(x=>x.score===s); if(sr.length) stats(sr, `Score ${s}`); }
  console.log();

  console.log('--- BY TIME OF DAY ---');
  stats(r.filter(x=>x.etMin>=570&&x.etMin<594), '09:30-09:53 (open)');
  stats(r.filter(x=>x.etMin>=594&&x.etMin<630), '09:54-10:29');
  stats(r.filter(x=>x.etMin>=630&&x.etMin<690), '10:30-11:29');
  stats(r.filter(x=>x.etMin>=690&&x.etMin<780), '11:30-12:59');
  stats(r.filter(x=>x.etMin>=780&&x.etMin<870), '13:00-14:29');
  stats(r.filter(x=>x.etMin>=870&&x.etMin<960), '14:30-16:00');
  console.log();

  console.log('--- BY DAY OF WEEK ---');
  for (const dow of ['Mon','Tue','Wed','Thu','Fri']) stats(r.filter(x=>x.dow===dow), dow);
  console.log();

  console.log('--- 1H REGIME ---');
  stats(r.filter(x=>x.h1Bear===true),  '1h bearish (close < prev close) — aligned');
  stats(r.filter(x=>x.h1Bear===false), '1h bullish (close > prev close) — counter');
  stats(r.filter(x=>x.h1Red===true),   '1h bar red  (close < open)');
  stats(r.filter(x=>x.h1Red===false),  '1h bar green (close > open)');
  console.log();

  console.log('--- 4H REGIME ---');
  stats(r.filter(x=>x.h4Bear===true),  '4h bearish — aligned');
  stats(r.filter(x=>x.h4Bear===false), '4h bullish — counter');
  stats(r.filter(x=>x.h4Red===true),   '4h bar red');
  stats(r.filter(x=>x.h4Red===false),  '4h bar green');
  console.log();

  console.log('--- COMBINED ---');
  stats(r.filter(x=>x.h1Bear===true && x.h4Bear===true),  'Both 1h+4h bearish');
  stats(r.filter(x=>x.h1Red===true  && x.h4Red===true),   'Both 1h+4h red');
  stats(r.filter(x=>x.h1Bear===true && x.h4Red===true),   '1h bearish + 4h red');
  console.log();

  console.log('--- PER DAY ---');
  const byDate = new Map<string,Result[]>();
  for (const x of r) { const d=byDate.get(x.date)??[]; d.push(x); byDate.set(x.date,d); }
  for (const [date, dr] of [...byDate.entries()].sort()) stats(dr, date);
  console.log();

  console.log('--- DETAIL ---');
  console.log(`${'Date'.padEnd(6)} ${'DOW'.padEnd(4)} ${'Time'.padEnd(6)} ${'Scr'.padEnd(4)} ${'1hBear'.padEnd(7)} ${'1hRed'.padEnd(6)} ${'4hBear'.padEnd(7)} ${'4hRed'.padEnd(6)} ${'MaxGain'.padStart(8)} ${'MaxDD'.padStart(7)}  Out`);
  console.log('-'.repeat(72));
  for (const x of r) {
    const hh=Math.floor(x.etMin/60).toString().padStart(2,'0');
    const mm=(x.etMin%60).toString().padStart(2,'0');
    const yn=(v:boolean|null)=>v===null?'?':v?'Y':'N';
    console.log(`${x.date.padEnd(6)} ${x.dow.padEnd(4)} ${(hh+':'+mm).padEnd(6)} ${String(x.score).padEnd(4)} ${yn(x.h1Bear).padEnd(7)} ${yn(x.h1Red).padEnd(6)} ${yn(x.h4Bear).padEnd(7)} ${yn(x.h4Red).padEnd(6)} ${('+'+x.maxGain.toFixed(1)).padStart(8)} ${('-'+x.maxDD.toFixed(1)).padStart(7)}  ${x.outcome}`);
  }
}

db.close();
ticksDb.close();
