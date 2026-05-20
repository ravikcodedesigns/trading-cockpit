/**
 * absorption_conviction_report.ts
 *
 * Analyzes absorption signals filtered by conviction (++ / +) across score bands 65-80+.
 * Focus: T1/T2/T3 hit rates, time-to-hit, max DD before each TP.
 *
 * Run: cd apps/aggregator && npx tsx scripts/absorption_conviction_report.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const T1=20, T2=40, T3=60, WINDOW_MS=60*60_000;

function isRTH(ms: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', weekday:'short', hour:'2-digit', minute:'2-digit', hour12:false });
  const p = fmt.formatToParts(new Date(ms));
  const wd = p.find(x=>x.type==='weekday')?.value ?? '';
  const h  = parseInt(p.find(x=>x.type==='hour')?.value ?? '0');
  const m  = parseInt(p.find(x=>x.type==='minute')?.value ?? '0');
  return ['Mon','Tue','Wed','Thu','Fri'].includes(wd) && (h*60+m) >= 570 && (h*60+m) < 960;
}
function toET(ms: number) {
  return new Date(ms).toLocaleString('en-US', { timeZone:'America/New_York', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false });
}
function avg(a: number[]): string { return a.length ? (a.reduce((s,v)=>s+v,0)/a.length).toFixed(1) : '  -'; }
function med(a: number[]): string {
  if (!a.length) return '  -';
  const s = [...a].sort((x,y)=>x-y);
  const m = Math.floor(s.length/2);
  return (s.length%2===0 ? ((s[m-1]!+s[m]!)/2) : s[m]!).toFixed(1);
}
function pct(n: number, d: number): string { return d===0?'  -':`${Math.round(100*n/d)}%`; }

interface SigRow { id:number; ts:number; score:number; direction:'long'|'short'; entry_price:number|null; rationale:string|null; conviction:string|null; }
interface Result {
  ts:number; score:number; direction:string; session:'RTH'|'ON';
  t1m:number|null; t2m:number|null; t3m:number|null;
  dd1:number|null; dd2:number|null; dd3:number|null;
  maxGain:number; maxDD:number; finalPnl:number;
}

async function main() {
  const trDb    = new Database(TRADING_DB, { readonly:true });
  const ticksDb = new Database(TICKS_DB,   { readonly:true });

  const sigs = trDb.prepare(`
    SELECT s.id, s.ts, s.score, s.direction,
      json_extract(s.payload,'$.rationale') as rationale,
      json_extract(s.payload,'$.conviction') as conviction,
      NULL as entry_price
    FROM signals s
    WHERE s.rule_id = 'absorption'
      AND s.symbol = 'NQ'
      AND json_extract(s.payload,'$.conviction') IN ('++', '+')
      AND s.score >= 60
    ORDER BY s.ts ASC
  `).all() as SigRow[];

  const buckets = new Map<string, Result[]>();

  let skipped = 0;
  let noEntry = 0;
  for (const sig of sigs) {
    const m = sig.rationale?.match(/absorbed at ([0-9.]+)/);
    const entry_price = m ? parseFloat(m[1]) : null;
    if (!entry_price) { noEntry++; continue; }

    const trades = ticksDb.prepare(`
      SELECT ts, price FROM trades
      WHERE symbol='NQ' AND ts > ? AND ts <= ?
      ORDER BY ts ASC
    `).all(sig.ts, sig.ts + WINDOW_MS) as { ts:number; price:number }[];

    if (!trades.length) { skipped++; continue; }

    let maxGain=0, maxDD=0, runDD=0;
    let t1Ts:number|null=null, t2Ts:number|null=null, t3Ts:number|null=null;
    let dd1:number|null=null, dd2:number|null=null, dd3:number|null=null;

    for (const t of trades) {
      const pnl = sig.direction==='long' ? t.price-entry_price : entry_price-t.price;
      if (pnl > maxGain) maxGain = pnl;
      const dd = Math.max(0, -pnl);
      if (dd > runDD) runDD = dd;
      if (dd > maxDD) maxDD = dd;
      if (!t1Ts && pnl>=T1){ t1Ts=t.ts; dd1=runDD; }
      if (!t2Ts && pnl>=T2){ t2Ts=t.ts; dd2=runDD; }
      if (!t3Ts && pnl>=T3){ t3Ts=t.ts; dd3=runDD; }
    }

    const toMins = (ts:number|null) => ts===null ? null : (ts-sig.ts)/60_000;
    const last = trades[trades.length-1]!;
    const finalPnl = sig.direction==='long' ? last.price-entry_price : entry_price-last.price;
    const session = isRTH(sig.ts) ? 'RTH' : 'ON';

    const band = sig.score>=80?'80+':sig.score>=75?'75-79':sig.score>=70?'70-74':sig.score>=65?'65-69':'60-64';
    const key  = `${band}|${sig.conviction}`;
    const arr  = buckets.get(key) ?? [];
    arr.push({ ts:sig.ts, score:sig.score, direction:sig.direction, session,
      t1m:toMins(t1Ts), t2m:toMins(t2Ts), t3m:toMins(t3Ts),
      dd1, dd2, dd3, maxGain, maxDD, finalPnl });
    buckets.set(key, arr);
  }

  trDb.close(); ticksDb.close();

  function printSection(r: Result[], label: string, n_total: number) {
    const n = r.length;
    if (!n) return;
    const h1 = r.filter(x=>x.t1m!==null);
    const h2 = r.filter(x=>x.t2m!==null);
    const h3 = r.filter(x=>x.t3m!==null);
    const c5  = h1.filter(x=>x.dd1!< 5).length;
    const c10 = h1.filter(x=>x.dd1!<10).length;
    const c15 = h1.filter(x=>x.dd1!<15).length;
    const misses = r.filter(x=>x.t1m===null).sort((a,b)=>b.maxDD-a.maxDD).slice(0,3);
    console.log(`\n  ${label}  (n=${n})`);
    console.log(`    T1 ${pct(h1.length,n).padStart(4)}  T2 ${pct(h2.length,n).padStart(4)}  T3 ${pct(h3.length,n).padStart(4)}`);
    console.log(`    T1 avg ${avg(h1.map(x=>x.t1m!)).padStart(5)}m  med ${med(h1.map(x=>x.t1m!)).padStart(5)}m   DD@T1 avg ${avg(h1.map(x=>x.dd1!)).padStart(5)}pts  med ${med(h1.map(x=>x.dd1!)).padStart(5)}pts`);
    console.log(`    Clean DD<5=${pct(c5,n).padStart(4)}  DD<10=${pct(c10,n).padStart(4)}  DD<15=${pct(c15,n).padStart(4)}`);
    console.log(`    Peak ${avg(r.map(x=>x.maxGain)).padStart(6)}pts  maxDD ${avg(r.map(x=>x.maxDD)).padStart(6)}pts  finalPnL ${avg(r.map(x=>x.finalPnl)).padStart(6)}pts`);
    if (misses.length) console.log(`    Misses: ${misses.map(x=>`${toET(x.ts)}[${x.session}] DD=${x.maxDD.toFixed(0)}`).join('  ')}`);
  }

  console.log('\n' + '='.repeat(76));
  console.log('  ABSORPTION NQ — CONVICTION TIER REPORT  (++ and +, score 60+)');
  console.log(`  ${noEntry} no-entry  ${skipped} no-tick-data`);
  console.log('='.repeat(76));
  console.log('  T1=+20pts  T2=+40pts  T3=+60pts  DD = max adverse before TP hit\n');

  const order = ['80+|++','80+|+','75-79|++','75-79|+','70-74|++','70-74|+','65-69|++','65-69|+','60-64|++','60-64|+'];

  for (const key of order) {
    const r = buckets.get(key);
    if (!r || !r.length) continue;
    const [band, conv] = key.split('|');
    const rth = r.filter(x=>x.session==='RTH');
    const on  = r.filter(x=>x.session==='ON');
    const longs  = r.filter(x=>x.direction==='long');
    const shorts = r.filter(x=>x.direction==='short');

    console.log('─'.repeat(76));
    console.log(`  Score ${band}  |  conviction=${conv}  |  n=${r.length}  (RTH=${rth.length} ON=${on.length}  long=${longs.length} short=${shorts.length})`);
    console.log('─'.repeat(76));

    printSection(r,    'ALL',  r.length);
    if (rth.length) printSection(rth, 'RTH', r.length);
    if (on.length)  printSection(on,  'ON',  r.length);

    console.log();
  }

  // Combined summary RTH vs ON
  const allPP    = [...buckets.entries()].filter(([k])=>k.endsWith('|++')).flatMap(([,v])=>v);
  const allPlus  = [...buckets.entries()].filter(([k])=>k.endsWith('|+')).flatMap(([,v])=>v);

  for (const [label, group] of [['++ ALL BANDS', allPP], ['+  ALL BANDS', allPlus]] as const) {
    if (!group.length) continue;
    const rth = group.filter(x=>x.session==='RTH');
    const on  = group.filter(x=>x.session==='ON');
    console.log('='.repeat(76));
    console.log(`  ${label}  (total=${group.length}  RTH=${rth.length}  ON=${on.length})`);
    console.log('='.repeat(76));
    printSection(group, 'ALL', group.length);
    if (rth.length) printSection(rth, 'RTH', group.length);
    if (on.length)  printSection(on,  'ON',  group.length);
    console.log();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
