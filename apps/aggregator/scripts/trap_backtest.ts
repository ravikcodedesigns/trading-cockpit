// Strategy J (TRAP) historical backtest — fast binary-search version
// Loads all ticks per symbol once, uses bisect to slice windows in O(log N)

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });

const MIN_1              = 60_000;
const SEC_5              = 5_000;
const MACRO_N            = 15;
const MIN_CVD_BACKGROUND = 3000;
const MIN_SPIKE          = 300;
const MIN_RECOVERY       = 150;
const RECOVERY_MS        = 10_000;
const SPIKE_LOOKBACK_MS  = 60_000;
const LEVEL_TOLERANCE    = 4;
const COOLDOWN_MS        = 20 * 60_000;
const POLL_STEP          = 5_000;
const LOOKFORWARD_MS     = 60 * 60_000;

interface Tick { ts: number; price: number; size: number; is_bid_aggressor: number; }

// Binary search: first index where ticks[i].ts >= ts
function bisect(ticks: Tick[], ts: number): number {
  let lo = 0, hi = ticks.length;
  while (lo < hi) { const mid = (lo+hi)>>1; if (ticks[mid].ts < ts) lo = mid+1; else hi = mid; }
  return lo;
}
function slice(ticks: Tick[], from: number, to: number): Tick[] {
  return ticks.slice(bisect(ticks, from), bisect(ticks, to+1));
}

function isRTH(ts: number): boolean {
  const p = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', weekday:'short', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(new Date(ts));
  const g = (t: string) => p.find(x => x.type===t)?.value ?? '';
  const min = parseInt(g('hour'),10)*60 + parseInt(g('minute'),10);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(g('weekday')) && min >= 570 && min < 960;
}

function buildCvd15(ticks: Tick[], nowMs: number): number {
  const curBar = Math.floor(nowMs/MIN_1)*MIN_1;
  const winStart = curBar - MACRO_N*MIN_1;
  const bars = new Map<number,{bid:number;ask:number}>();
  for (const t of ticks) {
    if (t.ts < winStart || t.ts >= curBar) continue;
    const b = Math.floor(t.ts/MIN_1)*MIN_1;
    const bar = bars.get(b) ?? {bid:0,ask:0};
    if (t.is_bid_aggressor===1) bar.bid+=t.size; else bar.ask+=t.size;
    bars.set(b, bar);
  }
  return Array.from(bars.values()).reduce((s,b)=>s+b.bid-b.ask,0);
}

function build5sWindows(ticks: Tick[], from: number, to: number) {
  const map = new Map<number,{bid:number;ask:number;lo:number;hi:number}>();
  for (const t of ticks) {
    if (t.ts < from || t.ts >= to) continue;
    const b = Math.floor(t.ts/SEC_5)*SEC_5;
    const cur = map.get(b) ?? {bid:0,ask:0,lo:t.price,hi:t.price};
    if (t.is_bid_aggressor===1) cur.bid+=t.size; else cur.ask+=t.size;
    cur.lo=Math.min(cur.lo,t.price); cur.hi=Math.max(cur.hi,t.price);
    map.set(b,cur);
  }
  return Array.from(map.entries()).sort(([a],[b])=>a-b).map(([ts,w])=>({ts,delta:w.bid-w.ask,lo:w.lo,hi:w.hi}));
}

function detect(ticks: Tick[], nowMs: number) {
  if (ticks.length < 10) return null;
  const cvd15 = buildCvd15(ticks, nowMs);
  if (Math.abs(cvd15) < MIN_CVD_BACKGROUND) return null;

  const spikeEnd = nowMs - RECOVERY_MS;
  const wins = build5sWindows(ticks, nowMs - SPIKE_LOOKBACK_MS, spikeEnd);
  if (wins.length === 0) return null;

  let recBid=0, recAsk=0;
  for (const t of ticks) {
    if (t.ts < spikeEnd || t.ts >= nowMs) continue;
    if (t.is_bid_aggressor===1) recBid+=t.size; else recAsk+=t.size;
  }
  const rec = recBid - recAsk;
  const price = ticks.at(-1)!.price;
  // Level-hold confirmation: every 5s bar in recovery window must stay on correct side
  const recovBars = build5sWindows(ticks, spikeEnd, nowMs);

  const MIN_RECOVERY_RATIO = 0.40; // recovery must be ≥40% of spike size

  if (cvd15 >= MIN_CVD_BACKGROUND) {
    const spk = wins.reduce((w,x)=>x.delta<w.delta?x:w);
    if (spk.delta > -MIN_SPIKE || rec < MIN_RECOVERY || price < spk.lo - LEVEL_TOLERANCE) return null;
    if (recovBars.some(b => b.lo < spk.lo - LEVEL_TOLERANCE)) return null;
    // Recovery ratio: buyers must absorb ≥40% of what sellers put in
    if (rec / Math.abs(spk.delta) < MIN_RECOVERY_RATIO) return null;
    let sc=80;
    if (Math.abs(spk.delta)>=200) sc+=5; if (rec>=120) sc+=5;
    if (cvd15>=3000) sc+=5; if (price>spk.lo) sc+=5;
    return {direction:'long' as const, cvd15, spikeDelta:spk.delta, recoveryDelta:rec, spikeLo:spk.lo, spikeHi:spk.hi, entry:price, score:Math.min(100,sc)};
  }
  if (cvd15 <= -MIN_CVD_BACKGROUND) {
    const spk = wins.reduce((w,x)=>x.delta>w.delta?x:w);
    if (spk.delta < MIN_SPIKE || rec > -MIN_RECOVERY || price > spk.hi + LEVEL_TOLERANCE) return null;
    if (recovBars.some(b => b.hi > spk.hi + LEVEL_TOLERANCE)) return null;
    if (Math.abs(rec) / spk.delta < MIN_RECOVERY_RATIO) return null;
    let sc=80;
    if (spk.delta>=200) sc+=5; if (Math.abs(rec)>=120) sc+=5;
    if (Math.abs(cvd15)>=3000) sc+=5; if (price<spk.hi) sc+=5;
    return {direction:'short' as const, cvd15, spikeDelta:spk.delta, recoveryDelta:rec, spikeLo:spk.lo, spikeHi:spk.hi, entry:price, score:Math.min(100,sc)};
  }
  return null;
}

const SYMBOLS = ['NQ','ES'];
interface Signal { ts:number; sym:string; dir:'long'|'short'; entry:number; stop:number; t1:number; t2:number; cvd15:number; spikeDelta:number; rec:number; score:number; risk:number; }
const allSignals: Signal[] = [];

for (const sym of SYMBOLS) {
  process.stdout.write(`Loading ${sym} ticks...`);
  const ticks = db.prepare(`SELECT ts,price,size,is_bid_aggressor FROM trades WHERE symbol=? ORDER BY ts ASC`).all(sym) as Tick[];
  process.stdout.write(` ${ticks.length.toLocaleString()} ticks. Scanning...\n`);

  const lastSig = new Map<string,number>();
  const {minTs,maxTs} = db.prepare('SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs FROM trades WHERE symbol=?').get(sym) as any;

  for (let t=minTs; t<=maxTs; t+=POLL_STEP) {
    if (!isRTH(t)) continue;
    const lc = (lastSig.get(`long`)??0)+COOLDOWN_MS>t;
    const sc = (lastSig.get(`short`)??0)+COOLDOWN_MS>t;
    if (lc && sc) continue;

    const winStart = t - (MACRO_N+2)*MIN_1;
    const w = slice(ticks, winStart, t);
    const hit = detect(w, t);
    if (!hit) continue;

    const dirCool = (lastSig.get(hit.direction)??0)+COOLDOWN_MS>t;
    if (dirCool) continue;

    lastSig.set(hit.direction, t);
    const isLong = hit.direction==='long';
    const stop = isLong ? hit.spikeLo-2 : hit.spikeHi+2;
    const risk = Math.abs(hit.entry - stop);

    // Gate 1: skip opening 30 min (9:30–10:00 ET)
    const etMin = (() => {
      const p = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(t));
      const g = (x:string) => p.find(v=>v.type===x)?.value??'0';
      return parseInt(g('hour'),10)*60+parseInt(g('minute'),10);
    })();
    if (etMin < 600) continue; // skip before 10:00 ET

    // Gate 2: skip large-stop trades (bad R:R with fixed 20pt T1)
    if (risk > 15) continue;

    allSignals.push({ts:t, sym, dir:hit.direction, entry:hit.entry, stop,
      t1: isLong ? hit.entry+20 : hit.entry-20,
      t2: isLong ? hit.entry+40 : hit.entry-40,
      cvd15:hit.cvd15, spikeDelta:hit.spikeDelta, rec:hit.recoveryDelta,
      score:hit.score, risk});
  }
  process.stdout.write(`  ${sym}: ${allSignals.filter(s=>s.sym===sym).length} signals found\n`);
}

allSignals.sort((a,b)=>a.ts-b.ts);
console.log(`\nTotal signals: ${allSignals.length}. Running outcomes...\n`);

const fmt = (ts:number) => new Date(ts).toLocaleString('en-US',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});

// Load outcome ticks per symbol (price only, no size needed)
const outTicks = new Map<string,{ts:number;price:number}[]>();
for (const sym of SYMBOLS) {
  outTicks.set(sym, db.prepare(`SELECT ts,price FROM trades WHERE symbol=? ORDER BY ts ASC`).all(sym) as any[]);
}

let wins=0,losses=0,openCount=0,totalPnl=0;
const dayMap = new Map<string,{w:number;l:number;o:number}>();

for (const sig of allSignals) {
  const ticks = outTicks.get(sig.sym)!;
  const from = sig.ts+1, to = sig.ts+LOOKFORWARD_MS;
  const fwd = ticks.slice(bisect(ticks as any, from), bisect(ticks as any, to+1));

  let outcome='OPEN', dur=0, mae=0, mfe=0;
  for (const t of fwd) {
    const exc = sig.dir==='long' ? t.price-sig.entry : sig.entry-t.price;
    const adv = sig.dir==='long' ? sig.entry-t.price : t.price-sig.entry;
    if (adv>mae) mae=adv; if (exc>mfe) mfe=exc;
    if (sig.dir==='long') {
      if (t.price<=sig.stop){outcome='STOP';dur=Math.round((t.ts-sig.ts)/60_000);break;}
      if (t.price>=sig.t2) {outcome='T2';  dur=Math.round((t.ts-sig.ts)/60_000);break;}
      if (t.price>=sig.t1) {outcome='T1';  dur=Math.round((t.ts-sig.ts)/60_000);break;}
    } else {
      if (t.price>=sig.stop){outcome='STOP';dur=Math.round((t.ts-sig.ts)/60_000);break;}
      if (t.price<=sig.t2) {outcome='T2';  dur=Math.round((t.ts-sig.ts)/60_000);break;}
      if (t.price<=sig.t1) {outcome='T1';  dur=Math.round((t.ts-sig.ts)/60_000);break;}
    }
  }

  const pnl = outcome==='STOP' ? -sig.risk : outcome==='T2' ? 40 : outcome==='T1' ? 20 : 0;
  if (outcome==='OPEN') openCount++; else if (outcome==='STOP'){losses++;totalPnl+=pnl;} else {wins++;totalPnl+=pnl;}

  const dk = new Date(sig.ts).toLocaleDateString('en-US',{timeZone:'America/New_York',month:'2-digit',day:'2-digit'});
  const d = dayMap.get(dk)??{w:0,l:0,o:0};
  if (outcome==='T1'||outcome==='T2') d.w++; else if (outcome==='STOP') d.l++; else d.o++;
  dayMap.set(dk,d);

  const pass = outcome==='T1'||outcome==='T2'?'PASS':outcome==='STOP'?'FAIL':'OPEN';
  console.log(
    `${fmt(sig.ts)}  ${sig.sym}  ${sig.dir.padEnd(5)}  entry=${sig.entry.toFixed(2).padStart(9)}  risk=${sig.risk.toFixed(1).padStart(4)}  `+
    `cvd15=${String(sig.cvd15).padStart(6)}  spk=${String(sig.spikeDelta).padStart(5)}  rec=${String(sig.rec).padStart(5)}  sc=${sig.score}  `+
    `${pass}  ${outcome.padEnd(4)}  pnl=${(pnl>=0?'+':'')+pnl.toFixed(1).padStart(5)}  mae=${mae.toFixed(1).padStart(4)}  mfe=${mfe.toFixed(1).padStart(4)}  t=${dur}m`
  );
}

console.log('\n--- Per-Day ---');
for (const [day,{w,l,o}] of Array.from(dayMap.entries()).sort()) {
  const tot=w+l; console.log(`  ${day}:  ${w}W ${l}L ${o}O  ${tot>0?(w/tot*100).toFixed(0)+'%':'?'}`);
}
const total=wins+losses;
console.log('\n--- Overall ---');
console.log(`Signals: ${allSignals.length}  Resolved: ${total}  Open: ${openCount}`);
console.log(`Win rate: ${wins}/${total} = ${total>0?(wins/total*100).toFixed(0):'?'}%`);
console.log(`Total PnL: ${totalPnl>=0?'+':''}${totalPnl.toFixed(1)} pts  Avg/trade: ${total>0?(totalPnl/total>=0?'+':'')+(totalPnl/total).toFixed(1):'?'} pts`);

db.close();
