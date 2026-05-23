// Sweep MIN_CVD_BACKGROUND, MIN_SPIKE, MIN_RECOVERY thresholds
// to find the combo that maximises win rate while keeping signal count reasonable

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });

const MIN_1          = 60_000;
const SEC_5          = 5_000;
const MACRO_N        = 15;
const RECOVERY_MS    = 10_000;
const SPIKE_LOOKBACK = 60_000;
const LEVEL_TOL      = 4;
const COOLDOWN_MS    = 20 * 60_000;
const POLL_STEP      = 5_000;
const LOOKFWD        = 60 * 60_000;
const SYMBOLS        = ['NQ','ES'];

interface Tick { ts:number; price:number; size:number; is_bid_aggressor:number; }

function bisect(arr:{ts:number}[], ts:number):number {
  let lo=0,hi=arr.length; while(lo<hi){const m=(lo+hi)>>1;arr[m].ts<ts?lo=m+1:hi=m;} return lo;
}
function sliceTs(arr:Tick[],from:number,to:number):Tick[]{return arr.slice(bisect(arr,from),bisect(arr,to+1));}

function isRTH(ts:number):boolean {
  const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(ts));
  const g=(t:string)=>p.find(x=>x.type===t)?.value??'';
  const min=parseInt(g('hour'),10)*60+parseInt(g('minute'),10);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(g('weekday'))&&min>=570&&min<960;
}

function buildCvd15(ticks:Tick[],nowMs:number,macro_n:number):number {
  const cur=Math.floor(nowMs/MIN_1)*MIN_1,ws=cur-macro_n*MIN_1;
  const bars=new Map<number,{b:number;a:number}>();
  for(const t of ticks){
    if(t.ts<ws||t.ts>=cur)continue;
    const k=Math.floor(t.ts/MIN_1)*MIN_1,b=bars.get(k)??{b:0,a:0};
    t.is_bid_aggressor===1?b.b+=t.size:b.a+=t.size; bars.set(k,b);
  }
  return Array.from(bars.values()).reduce((s,b)=>s+b.b-b.a,0);
}

function build5s(ticks:Tick[],from:number,to:number){
  const map=new Map<number,{b:number;a:number;lo:number;hi:number}>();
  for(const t of ticks){
    if(t.ts<from||t.ts>=to)continue;
    const k=Math.floor(t.ts/SEC_5)*SEC_5,c=map.get(k)??{b:0,a:0,lo:t.price,hi:t.price};
    t.is_bid_aggressor===1?c.b+=t.size:c.a+=t.size;
    c.lo=Math.min(c.lo,t.price);c.hi=Math.max(c.hi,t.price);map.set(k,c);
  }
  return Array.from(map.entries()).sort(([a],[b])=>a-b).map(([ts,w])=>({ts,delta:w.b-w.a,lo:w.lo,hi:w.hi}));
}

function detect(ticks:Tick[],nowMs:number,CVD:number,SPK:number,REC:number){
  if(ticks.length<10)return null;
  const cvd15=buildCvd15(ticks,nowMs,MACRO_N);
  if(Math.abs(cvd15)<CVD)return null;
  const se=nowMs-RECOVERY_MS,wins=build5s(ticks,nowMs-SPIKE_LOOKBACK,se);
  if(!wins.length)return null;
  let rb=0,ra=0;
  for(const t of ticks){if(t.ts<se||t.ts>=nowMs)continue;t.is_bid_aggressor===1?rb+=t.size:ra+=t.size;}
  const rec=rb-ra,price=ticks.at(-1)!.price;
  if(cvd15>=CVD){
    const spk=wins.reduce((w,x)=>x.delta<w.delta?x:w);
    if(spk.delta>-SPK||rec<REC||price<spk.lo-LEVEL_TOL)return null;
    return{dir:'long' as const,spikeLo:spk.lo,spikeHi:spk.hi,entry:price};
  }
  if(cvd15<=-CVD){
    const spk=wins.reduce((w,x)=>x.delta>w.delta?x:w);
    if(spk.delta<SPK||rec>-REC||price>spk.hi+LEVEL_TOL)return null;
    return{dir:'short' as const,spikeLo:spk.lo,spikeHi:spk.hi,entry:price};
  }
  return null;
}

// Load all ticks once
const allTicks=new Map<string,Tick[]>();
for(const sym of SYMBOLS){
  process.stdout.write(`Loading ${sym}...`);
  allTicks.set(sym,db.prepare(`SELECT ts,price,size,is_bid_aggressor FROM trades WHERE symbol=? ORDER BY ts ASC`).all(sym) as Tick[]);
  process.stdout.write(` ${allTicks.get(sym)!.length.toLocaleString()}\n`);
}

// Get full time range
const{minTs,maxTs}=db.prepare('SELECT MIN(ts) AS minTs,MAX(ts) AS maxTs FROM trades').get() as any;

// Build RTH poll timestamps once
const rthTs:number[]=[];
for(let t=minTs;t<=maxTs;t+=POLL_STEP){if(isRTH(t))rthTs.push(t);}
process.stdout.write(`RTH poll points: ${rthTs.length.toLocaleString()}\n\n`);

// Threshold combos to test
const CVD_VALS      = [2000, 3000];
const SPK_VALS      = [200, 300];
const REC_VALS      = [100, 150];
const STOP_BUF_VALS = [2, 5, 8, 12];   // pts beyond spike extreme

console.log(`${'CVD'.padStart(5)} ${'SPK'.padStart(5)} ${'REC'.padStart(5)} ${'BUF'.padStart(4)}  ${'N'.padStart(4)}  ${'W'.padStart(3)} ${'L'.padStart(3)} ${'WR%'.padStart(5)}  ${'PnL'.padStart(7)}  ${'Avg'.padStart(6)}  Sig/day`);
console.log('-'.repeat(80));

for(const CVD of CVD_VALS){
  for(const SPK of SPK_VALS){
    for(const REC of REC_VALS){
      for(const BUF of STOP_BUF_VALS){
        interface Sig{ts:number;sym:string;dir:'long'|'short';entry:number;stop:number;t1:number;t2:number;risk:number;}
        const signals:Sig[]=[];

        for(const sym of SYMBOLS){
          const ticks=allTicks.get(sym)!;
          const last=new Map<string,number>();
          for(const t of rthTs){
            const lc=(last.get('long')??0)+COOLDOWN_MS>t,sc=(last.get('short')??0)+COOLDOWN_MS>t;
            if(lc&&sc)continue;
            const w=(MACRO_N+2)*MIN_1;
            const sl=sliceTs(ticks,t-w,t);
            const hit=detect(sl,t,CVD,SPK,REC);
            if(!hit)continue;
            if((last.get(hit.dir)??0)+COOLDOWN_MS>t)continue;
            last.set(hit.dir,t);
            const isL=hit.dir==='long',stop=isL?hit.spikeLo-BUF:hit.spikeHi+BUF;
            const risk=Math.abs(hit.entry-stop);
            if(risk>30)continue;  // skip degenerate wide stops
            signals.push({ts:t,sym,dir:hit.dir,entry:hit.entry,stop,
              t1:isL?hit.entry+20:hit.entry-20,t2:isL?hit.entry+40:hit.entry-40,
              risk});
          }
        }

        let wins=0,losses=0,pnl=0;
        for(const sig of signals){
          const ticks=allTicks.get(sig.sym)!;
          const fwd=sliceTs(ticks,sig.ts+1,sig.ts+LOOKFWD);
          let out='OPEN';
          for(const t of fwd){
            if(sig.dir==='long'){
              if(t.price<=sig.stop){out='STOP';break;}
              if(t.price>=sig.t2){out='T2';break;}
              if(t.price>=sig.t1){out='T1';break;}
            }else{
              if(t.price>=sig.stop){out='STOP';break;}
              if(t.price<=sig.t2){out='T2';break;}
              if(t.price<=sig.t1){out='T1';break;}
            }
          }
          if(out==='T1'||out==='T2'){wins++;pnl+=out==='T2'?40:20;}
          else if(out==='STOP'){losses++;pnl-=sig.risk;}
        }

        const tot=wins+losses,wr=tot>0?(wins/tot*100):0;
        const days=9,spd=(signals.length/days).toFixed(1);
        const avg=tot>0?(pnl/tot).toFixed(1):'?';
        console.log(
          `${String(CVD).padStart(5)} ${String(SPK).padStart(5)} ${String(REC).padStart(5)} ${String(BUF).padStart(4)}  `+
          `${String(signals.length).padStart(4)}  ${String(wins).padStart(3)} ${String(losses).padStart(3)} ${wr.toFixed(0).padStart(5)}%  `+
          `${(pnl>=0?'+':'')+pnl.toFixed(1).padStart(6)}  ${(Number(avg)>=0?'+':'')+String(avg).padStart(5)}  ${spd}/day`
        );
      }
    }
  }
}

db.close();
