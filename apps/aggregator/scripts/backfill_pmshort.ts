/**
 * SHORT-SIDE PM — Afternoon Short Detector backfill.
 *
 * Pattern: Price has extended significantly in one direction by midday, then
 * shows distribution at or near the session extreme. Short-sellers absorb late
 * buyers at the top (bullish day) or bears fade a relief bounce (bearish day).
 *
 * Detection conditions:
 *   1. RTH, 12:00–16:00 ET
 *   2. STRUCTURAL GATE: sessGain >= +SG_BULL (bull day top) OR sessGain <= -SG_BEAR (bear day bounce)
 *   3. RANGE POSITION: compPos >= COMP_MIN (price near top of 30-bar range)
 *   4. FROM HIGH: current price within FROM_HI pts of rolling session high
 *   5. SELLER DELTA: delta15 <= -DELTA_MIN (net sellers active at this level)
 *   6. No broadcast gold signal (H/EXPL/J) in same direction within 30 min
 *   7. Cooldown: 30 min
 *
 * Outcome: hit -80pts before +20pts adverse within 4h (short target/stop).
 *
 * Run: npx tsx scripts/backfill_pmshort.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH    = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_PATH = path.resolve(__dirname, '../../../data/ticks.db');

const db      = new Database(DB_PATH,    { readonly: true });
const ticksDb = new Database(TICKS_PATH, { readonly: true });

const MIN_1         = 60_000;
const STANDALONE_WIN = 30 * MIN_1;
const COOLDOWN_MS   = 30 * MIN_1;
const FORWARD_BARS  = 240;
const TARGET_PTS    = 80;
const STOP_PTS      = 20;
const LOOKBACK      = 15;
const PM_OPEN_MIN   = 720;   // 12:00 ET
const PM_CLOSE_MIN  = 960;   // 16:00 ET

const ET = 'America/New_York';
function etMin(ts: number) {
  const p = new Intl.DateTimeFormat('en-US',{timeZone:ET,hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(ts));
  return parseInt(p.find(x=>x.type==='hour')!.value)*60+parseInt(p.find(x=>x.type==='minute')!.value);
}
function isRTH(ts: number) {
  const p = new Intl.DateTimeFormat('en-US',{timeZone:ET,weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(ts));
  const wd=p.find(x=>x.type==='weekday')!.value, m=etMin(ts);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(wd)&&m>=570&&m<960;
}
function etLabel(ts: number) {
  return new Intl.DateTimeFormat('en-US',{timeZone:ET,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(ts));
}

const broadcastSignals = db.prepare(`
  SELECT ts, direction FROM signals WHERE symbol='NQ' AND rs_hard_filtered IS NOT 1
    AND (strategy_version='H'
      OR (strategy_version='EXPL' AND direction='long'
          AND json_array_length(json_extract(payload,'$.stackedBidZones')) > 0
          AND (json_extract(payload,'$.rangePct') IS NULL OR json_extract(payload,'$.rangePct') >= 0.5))
      OR strategy_version='J')
  ORDER BY ts
`).all() as {ts:number;direction:string}[];
db.close();
console.log(`Broadcast signals: ${broadcastSignals.length}`);

console.log('Building 1-min bars...');
const raw = ticksDb.prepare(`SELECT ts,price,size,is_bid_aggressor FROM trades WHERE symbol='NQ' ORDER BY ts ASC`)
  .all() as {ts:number;price:number;size:number;is_bid_aggressor:number}[];
ticksDb.close();

const bmap = new Map<number,{open:number;high:number;low:number;close:number;askVol:number;bidVol:number}>();
for (const t of raw) {
  const bts=Math.floor(t.ts/MIN_1)*MIN_1;
  let b=bmap.get(bts);
  if(!b){b={open:t.price,high:t.price,low:t.price,close:t.price,askVol:0,bidVol:0};bmap.set(bts,b);}
  if(t.price>b.high)b.high=t.price; if(t.price<b.low)b.low=t.price; b.close=t.price;
  if(t.is_bid_aggressor)b.bidVol+=t.size; else b.askVol+=t.size;
}
const bars = [...bmap.entries()].sort(([a],[b])=>a-b)
  .map(([ts,b])=>({ts,...b,vol:b.askVol+b.bidVol,delta:b.askVol-b.bidVol}));
const rthBars = bars.filter(b=>isRTH(b.ts));
console.log(`  ${rthBars.length} RTH bars\n`);

function hasRecentBroadcast(moveTs:number,dir:string):boolean {
  for(const g of broadcastSignals){
    if(g.direction!==dir)continue;
    const lag=moveTs-g.ts;
    if(lag>=0&&lag<=STANDALONE_WIN)return true;
  }
  return false;
}

// Build per-day session open and rolling high per bar index
const dayOpen = new Map<string,number>();
const dayFirstBarIdx = new Map<string,number>();
for(let i=0;i<rthBars.length;i++){
  const b=rthBars[i]!;
  const day=new Date(b.ts).toISOString().slice(0,10);
  if(!dayOpen.has(day)){dayOpen.set(day,b.open); dayFirstBarIdx.set(day,i);}
}

// Rolling session high up to bar i (exclusive) — precompute for speed
const rollingDayHigh: number[] = new Array(rthBars.length).fill(0);
{
  let curDay='', curHi=0;
  for(let i=0;i<rthBars.length;i++){
    const b=rthBars[i]!;
    const day=new Date(b.ts).toISOString().slice(0,10);
    if(day!==curDay){curDay=day;curHi=b.high;}
    rollingDayHigh[i]=curHi;
    curHi=Math.max(curHi,b.high);
  }
}

type Signal = {
  ts:number; entry:number;
  sessGain:number; fromHi:number; compPos:number; delta15:number; vel5:number;
  score:number;
  outcome:'win'|'fail'|'open'; maxGain:number; maxDD:number;
};

// Threshold sweep
const CONFIGS = [
  { SG_BULL:80,  COMP_MIN:0.80, FROM_HI:50,  DELTA_MIN:300  },
  { SG_BULL:100, COMP_MIN:0.80, FROM_HI:50,  DELTA_MIN:300  },
  { SG_BULL:100, COMP_MIN:0.85, FROM_HI:30,  DELTA_MIN:500  },
  { SG_BULL:100, COMP_MIN:0.85, FROM_HI:30,  DELTA_MIN:1000 },
  { SG_BULL:100, COMP_MIN:0.85, FROM_HI:20,  DELTA_MIN:500  },
  { SG_BULL:120, COMP_MIN:0.85, FROM_HI:30,  DELTA_MIN:500  },
  { SG_BULL:120, COMP_MIN:0.85, FROM_HI:20,  DELTA_MIN:1000 },
  { SG_BULL:150, COMP_MIN:0.85, FROM_HI:30,  DELTA_MIN:500  },
];
const SG_BEAR = 100;  // bearish day bounce: sessGain <= -100

for(const cfg of CONFIGS){
  const signals: Signal[] = [];
  const lastFiredMs: Record<string,number> = {short:0};

  for(let i=LOOKBACK+5; i<rthBars.length-FORWARD_BARS; i++){
    const cur=rthBars[i]!;
    const m=etMin(cur.ts);
    if(m<PM_OPEN_MIN||m>=PM_CLOSE_MIN)continue;
    if(cur.ts-lastFiredMs.short!<COOLDOWN_MS)continue;
    if(hasRecentBroadcast(cur.ts,'short'))continue;

    const day=new Date(cur.ts).toISOString().slice(0,10);
    const open=dayOpen.get(day)??cur.open;
    const sessGain=cur.close-open;

    const isBullDay = sessGain >= cfg.SG_BULL;
    const isBearDay = sessGain <= -SG_BEAR;
    if(!isBullDay && !isBearDay)continue;

    // compPos: price position in 30-bar range
    const macro=rthBars.slice(Math.max(0,i-30),i);
    const mHi=Math.max(...macro.map(b=>b.high));
    const mLo=Math.min(...macro.map(b=>b.low));
    const compPos=mHi>mLo?(cur.close-mLo)/(mHi-mLo):0.5;
    if(compPos<cfg.COMP_MIN)continue;

    // fromHi: distance from rolling session high
    const sessHigh=rollingDayHigh[i]??mHi;
    const fromHi=sessHigh-cur.close;
    if(fromHi>cfg.FROM_HI)continue;

    // delta15: cumulative sellers
    const pre=rthBars.slice(i-LOOKBACK,i);
    const delta15=pre.reduce((s,b)=>s+b.delta,0);
    if(delta15>-cfg.DELTA_MIN)continue;

    const last5=pre.slice(-5);
    const vel5=(last5[last5.length-1]!.close-last5[0]!.open)/5;

    // Score
    let score=70;
    const absDelta=Math.abs(delta15);
    if(absDelta>=5000)score+=20; else if(absDelta>=2000)score+=15; else if(absDelta>=1000)score+=8;
    if(compPos>=0.95)score+=10; else if(compPos>=0.90)score+=5;
    if(fromHi<=10)score+=10; else if(fromHi<=20)score+=5;
    score=Math.min(100,score);

    // Outcome
    const entry=cur.close;
    const fwd=rthBars.slice(i,i+FORWARD_BARS);
    let maxGain=0,maxDD=0;
    let outcome:'win'|'fail'|'open'='open';
    for(const fb of fwd){
      const gain=entry-fb.low;
      const dd=fb.high-entry;
      if(gain>maxGain)maxGain=gain;
      if(dd>maxDD)maxDD=dd;
      if(gain>=TARGET_PTS){outcome='win';break;}
      if(dd>=STOP_PTS){outcome='fail';break;}
    }

    lastFiredMs.short=cur.ts;
    signals.push({ts:cur.ts,entry,sessGain,fromHi,compPos,delta15,vel5,score,outcome,maxGain,maxDD});
  }

  const wins=signals.filter(s=>s.outcome==='win');
  const fails=signals.filter(s=>s.outcome==='fail');
  const closed=signals.filter(s=>s.outcome!=='open');
  const wr=closed.length?`${wins.length}/${closed.length}(${Math.round(100*wins.length/closed.length)}%)`:'-';
  const avgG=wins.length?(wins.reduce((s,x)=>s+x.maxGain,0)/wins.length).toFixed(0):'n/a';
  const avgDD=fails.length?(fails.reduce((s,x)=>s+x.maxDD,0)/fails.length).toFixed(0):'n/a';
  console.log(
    `SG≥${String(cfg.SG_BULL).padStart(3)} comp≥${cfg.COMP_MIN.toFixed(2)} hi≤${String(cfg.FROM_HI).padStart(2)} δ≤-${String(cfg.DELTA_MIN).padStart(4)}  ` +
    `n=${String(signals.length).padStart(3)}  WR=${wr.padEnd(12)}  avgWin=${avgG.padStart(4)}  avgFailDD=${avgDD.padStart(4)}`
  );

  // Print detail for best-looking config
  if(cfg.SG_BULL===100&&cfg.COMP_MIN===0.85&&cfg.FROM_HI===30&&cfg.DELTA_MIN===500){
    console.log(`\n  ── detail (SG≥100 comp≥0.85 hi≤30 δ≤-500) ──`);
    console.log(`  ${'Time'.padEnd(14)} ${'SessGn'.padStart(7)} ${'FromHi'.padStart(7)} ${'δ15'.padStart(7)} ${'vel5'.padStart(6)} ${'CPos'.padStart(5)} ${'Scr'.padStart(4)} ${'Out'.padEnd(5)} ${'Gain'.padStart(6)} ${'DD'.padStart(6)}`);
    console.log('  '+'-'.repeat(78));
    for(const s of signals){
      console.log(
        `  ${etLabel(s.ts).padEnd(14)} ${s.sessGain.toFixed(0).padStart(7)} ${s.fromHi.toFixed(0).padStart(7)} ` +
        `${s.delta15.toString().padStart(7)} ${s.vel5.toFixed(1).padStart(6)} ${s.compPos.toFixed(2).padStart(5)} ` +
        `${s.score.toString().padStart(4)} ${s.outcome.padEnd(5)} ${s.maxGain.toFixed(1).padStart(6)} ${s.maxDD.toFixed(1).padStart(6)}`
      );
    }
    console.log('');
  }
}
