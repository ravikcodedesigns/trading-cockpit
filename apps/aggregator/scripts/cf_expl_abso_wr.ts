/**
 * Time & Win-Rate report for:
 *   CF long / CF short  (clean-impulse, strategy H, RTH)
 *   EXPL long           (strategy EXPL, gold-quality gate, RTH)
 *   ABSO long           (absorption strategy B, score >= 80, RTH)
 *
 * Shows all-time cumulative stats + yesterday (May 22) breakdown.
 * Targets: T1=25pts, T2=50pts, T3=75pts measured from signal entry.
 * Window: 90 minutes forward.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const trDb       = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb    = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const YESTERDAY  = '2026-05-22';
const T1 = 25, T2 = 50, T3 = 75;
const WINDOW_MS  = 90 * 60_000;   // 90-minute forward window

// ─── helpers ──────────────────────────────────────────────────────────────────

function isRTH(ms: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const wd  = get('weekday');
  const tot = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(wd) && tot >= 570 && tot < 960;
}

function etDate(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms)).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2');
}

function toET(ms: number): string {
  return new Date(ms).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function avg(arr: number[]): string {
  if (!arr.length) return '  -';
  return (arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1);
}
function med(arr: number[]): string {
  if (!arr.length) return '  -';
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return (s.length % 2 === 0 ? (s[m-1]! + s[m]!) / 2 : s[m]!).toFixed(1);
}
function pct(n: number, d: number): string {
  return d === 0 ? ' -' : `${Math.round(100 * n / d)}%`;
}
function sgn(n: number): string { return (n >= 0 ? '+' : '') + n.toFixed(1); }

// ─── per-signal outcome ───────────────────────────────────────────────────────

interface Outcome {
  noData:    boolean;
  t1Mins:    number | null;
  t2Mins:    number | null;
  t3Mins:    number | null;
  ddAtT1:    number | null;
  ddAtT2:    number | null;
  ddAtT3:    number | null;
  maxGain:   number;
  maxDD:     number;
  finalPnl:  number;
}

const fwdQuery = ticksDb.prepare(
  `SELECT ts, price FROM trades WHERE symbol='NQ' AND ts > ? AND ts <= ? ORDER BY ts ASC`
);

function analyze(entryTs: number, entryPrice: number, dir: 'long' | 'short'): Outcome {
  const trades = fwdQuery.all(entryTs, entryTs + WINDOW_MS) as { ts: number; price: number }[];
  if (!trades.length) {
    return { noData: true, t1Mins: null, t2Mins: null, t3Mins: null,
             ddAtT1: null, ddAtT2: null, ddAtT3: null, maxGain: 0, maxDD: 0, finalPnl: 0 };
  }
  let maxGain = 0, maxDD = 0, runDD = 0;
  let t1Ts: number | null = null, t2Ts: number | null = null, t3Ts: number | null = null;
  let ddAtT1: number | null = null, ddAtT2: number | null = null, ddAtT3: number | null = null;

  for (const t of trades) {
    const pnl = dir === 'long' ? t.price - entryPrice : entryPrice - t.price;
    if (pnl > maxGain) maxGain = pnl;
    const dd = Math.max(0, -pnl);
    if (dd > runDD) runDD = dd;
    if (dd > maxDD) maxDD = dd;
    if (t1Ts === null && pnl >= T1) { t1Ts = t.ts; ddAtT1 = runDD; }
    if (t2Ts === null && pnl >= T2) { t2Ts = t.ts; ddAtT2 = runDD; }
    if (t3Ts === null && pnl >= T3) { t3Ts = t.ts; ddAtT3 = runDD; }
  }
  const last = trades.at(-1)!;
  const finalPnl = dir === 'long' ? last.price - entryPrice : entryPrice - last.price;
  const toMin = (ts: number | null) => ts === null ? null : (ts - entryTs) / 60_000;
  return {
    noData: false,
    t1Mins: toMin(t1Ts), t2Mins: toMin(t2Ts), t3Mins: toMin(t3Ts),
    ddAtT1, ddAtT2, ddAtT3, maxGain, maxDD, finalPnl,
  };
}

// ─── print block ──────────────────────────────────────────────────────────────

interface Row { entryTs: number; entryPrice: number; score: number; out: Outcome }

function printBlock(label: string, all: Row[], yday: Row[]) {
  const valid    = all.filter(r => !r.out.noData);
  const ydayV    = yday.filter(r => !r.out.noData);
  const prior    = valid.filter(r => etDate(r.entryTs) !== YESTERDAY);

  const stats = (rows: Row[]) => {
    if (!rows.length) return null;
    const h1 = rows.filter(r => r.out.t1Mins !== null);
    const h2 = rows.filter(r => r.out.t2Mins !== null);
    const h3 = rows.filter(r => r.out.t3Mins !== null);
    return {
      n: rows.length,
      wr1: pct(h1.length, rows.length), wr2: pct(h2.length, rows.length), wr3: pct(h3.length, rows.length),
      t1: avg(h1.map(r => r.out.t1Mins!)), t2: avg(h2.map(r => r.out.t2Mins!)), t3: avg(h3.map(r => r.out.t3Mins!)),
      t1med: med(h1.map(r => r.out.t1Mins!)),
      dd1: avg(h1.map(r => r.out.ddAtT1!)), dd2: avg(h2.map(r => r.out.ddAtT2!)),
      clean1: pct(h1.filter(r => r.out.ddAtT1! < 10).length, rows.length),
      avgGain: avg(rows.map(r => r.out.maxGain)), avgDD: avg(rows.map(r => r.out.maxDD)),
      avgFinal: avg(rows.map(r => r.out.finalPnl)),
    };
  };

  const priorSt = stats(prior);
  const allSt   = stats(valid);
  const ydSt    = stats(ydayV);

  const LINE = '─'.repeat(72);
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  ${label}  (all-time n=${valid.length}, ${all.filter(r=>r.out.noData).length} no-data skipped)`);
  console.log(`${'═'.repeat(72)}`);

  if (allSt) {
    console.log(`\n  ┌── ALL-TIME (n=${allSt.n}) ────────────────────────────────────────`);
    console.log(`  │  T1 +${T1}pts: ${allSt.wr1.padStart(4)}  avg ${allSt.t1.padStart(5)}m  med ${allSt.t1med.padStart(5)}m  avg DD before: ${allSt.dd1.padStart(5)}pts`);
    console.log(`  │  T2 +${T2}pts: ${allSt.wr2.padStart(4)}  avg ${allSt.t2.padStart(5)}m`);
    console.log(`  │  T3 +${T3}pts: ${allSt.wr3.padStart(4)}  avg ${allSt.t3.padStart(5)}m`);
    console.log(`  │  Clean T1 (DD<10): ${allSt.clean1.padStart(4)}  │  avg peak gain: ${allSt.avgGain.padStart(6)}pts  avg max DD: ${allSt.avgDD.padStart(6)}pts  avg final: ${sgn(parseFloat(allSt.avgFinal))}pts`);
    console.log(`  └──────────────────────────────────────────────────────────────────`);
  }

  if (ydSt) {
    const arrow1 = priorSt ? ` (was ${priorSt.wr1} pre-May22)` : '';
    const arrow2 = priorSt ? ` (was ${priorSt.wr2})` : '';
    console.log(`\n  ┌── MAY 22 — YESTERDAY (n=${ydSt.n}) ─────────────────────────────`);
    console.log(`  │  T1 +${T1}pts: ${ydSt.wr1.padStart(4)}  avg ${ydSt.t1.padStart(5)}m  med ${ydSt.t1med.padStart(5)}m  avg DD before: ${ydSt.dd1.padStart(5)}pts${arrow1}`);
    console.log(`  │  T2 +${T2}pts: ${ydSt.wr2.padStart(4)}  avg ${ydSt.t2.padStart(5)}m${arrow2}`);
    console.log(`  │  T3 +${T3}pts: ${ydSt.wr3.padStart(4)}  avg ${ydSt.t3.padStart(5)}m`);
    console.log(`  │  Clean T1 (DD<10): ${ydSt.clean1.padStart(4)}  │  avg peak gain: ${ydSt.avgGain.padStart(6)}pts  avg max DD: ${ydSt.avgDD.padStart(6)}pts  avg final: ${sgn(parseFloat(ydSt.avgFinal))}pts`);

    // Signal-level detail for yesterday
    console.log(`  │`);
    console.log(`  │  Detail (May 22)`);
    for (const r of ydayV) {
      const o = r.out;
      const hit = o.t1Mins !== null ? `✅ T1 in ${o.t1Mins.toFixed(1)}m` + (o.t2Mins !== null ? `  T2 in ${o.t2Mins.toFixed(1)}m` : '') + (o.t3Mins !== null ? `  T3 in ${o.t3Mins.toFixed(1)}m` : '') : `❌ miss  maxGain:${o.maxGain.toFixed(0)}pts`;
      console.log(`  │    ${toET(r.entryTs).padEnd(16)} entry:${r.entryPrice.toFixed(2)}  ${hit}  maxDD:${o.maxDD.toFixed(0)}pts`);
    }
    console.log(`  └──────────────────────────────────────────────────────────────────`);
  } else {
    console.log(`\n  No signals yesterday.`);
  }
}

// ─── load signals ─────────────────────────────────────────────────────────────

const entryQuery = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? ORDER BY ts ASC LIMIT 1`
);
function entryPrice(ts: number, payload: string): number {
  const p = JSON.parse(payload);
  if (p.entry && p.entry > 1000) return p.entry;
  const row = entryQuery.get(ts) as any;
  return row?.price ?? 0;
}

// ── CF long ───────────────────────────────────────────────────────────────────
const cfLongSigs = trDb.prepare(`
  SELECT id, ts, score, payload FROM signals
  WHERE rule_id='clean-impulse' AND direction='long' AND strategy_version='H'
  ORDER BY ts
`).all() as any[];

const cfLongAll  = cfLongSigs.filter(s => isRTH(s.ts)).map(s => {
  const ep = entryPrice(s.ts, s.payload);
  return { entryTs: s.ts, entryPrice: ep, score: s.score, out: ep > 0 ? analyze(s.ts, ep, 'long') : { noData: true, t1Mins:null,t2Mins:null,t3Mins:null,ddAtT1:null,ddAtT2:null,ddAtT3:null,maxGain:0,maxDD:0,finalPnl:0 } };
});
const cfLongYday = cfLongAll.filter(r => etDate(r.entryTs) === YESTERDAY);

// ── CF short ──────────────────────────────────────────────────────────────────
const cfShortSigs = trDb.prepare(`
  SELECT id, ts, score, payload FROM signals
  WHERE rule_id='clean-impulse' AND direction='short' AND strategy_version='H'
  ORDER BY ts
`).all() as any[];

const cfShortAll  = cfShortSigs.filter(s => isRTH(s.ts)).map(s => {
  const ep = entryPrice(s.ts, s.payload);
  return { entryTs: s.ts, entryPrice: ep, score: s.score, out: ep > 0 ? analyze(s.ts, ep, 'short') : { noData: true, t1Mins:null,t2Mins:null,t3Mins:null,ddAtT1:null,ddAtT2:null,ddAtT3:null,maxGain:0,maxDD:0,finalPnl:0 } };
});
const cfShortYday = cfShortAll.filter(r => etDate(r.entryTs) === YESTERDAY);

// ── EXPL long (gold only: zones > 0, rangePct >= 0.5 or null) ─────────────────
const explLongSigs = trDb.prepare(`
  SELECT id, ts, score, payload,
    CAST(json_extract(payload,'$.rangePct') AS REAL) AS rangePct,
    json_array_length(json_extract(payload,'$.stackedBidZones')) AS zones
  FROM signals
  WHERE rule_id='expl' AND direction='long' AND strategy_version='EXPL'
  ORDER BY ts
`).all() as any[];

const explLongAll  = explLongSigs.filter(s => isRTH(s.ts) && s.zones > 0 && (s.rangePct === null || s.rangePct >= 0.5)).map(s => {
  const ep = entryPrice(s.ts, s.payload);
  return { entryTs: s.ts, entryPrice: ep, score: s.score, out: ep > 0 ? analyze(s.ts, ep, 'long') : { noData: true, t1Mins:null,t2Mins:null,t3Mins:null,ddAtT1:null,ddAtT2:null,ddAtT3:null,maxGain:0,maxDD:0,finalPnl:0 } };
});
const explLongYday = explLongAll.filter(r => etDate(r.entryTs) === YESTERDAY);

// ── ABSO long (score >= 80, RTH) ──────────────────────────────────────────────
const absoLongSigs = trDb.prepare(`
  SELECT id, ts, score, payload FROM signals
  WHERE rule_id='absorption' AND direction='long' AND strategy_version='B' AND score >= 80
  ORDER BY ts
`).all() as any[];

const absoLongAll  = absoLongSigs.filter(s => isRTH(s.ts)).map(s => {
  const ep = entryPrice(s.ts, s.payload);
  return { entryTs: s.ts, entryPrice: ep, score: s.score, out: ep > 0 ? analyze(s.ts, ep, 'long') : { noData: true, t1Mins:null,t2Mins:null,t3Mins:null,ddAtT1:null,ddAtT2:null,ddAtT3:null,maxGain:0,maxDD:0,finalPnl:0 } };
});
const absoLongYday = absoLongAll.filter(r => etDate(r.entryTs) === YESTERDAY);

// ─── print ────────────────────────────────────────────────────────────────────

console.log(`\n${'█'.repeat(72)}`);
console.log(`  TIME & WIN-RATE REPORT — CF / EXPL / ABSO  (targets: T1=${T1} T2=${T2} T3=${T3}pts, 90min window)`);
console.log(`  Yesterday: ${YESTERDAY}`);
console.log(`${'█'.repeat(72)}`);

printBlock('CF LONG  (clean-impulse, strategy H)',  cfLongAll,  cfLongYday);
printBlock('CF SHORT (clean-impulse, strategy H)', cfShortAll, cfShortYday);
printBlock('EXPL LONG (gold quality: zones>0, rangePct>=0.5)', explLongAll, explLongYday);
printBlock('ABSO LONG (score >= 80, RTH)',          absoLongAll, absoLongYday);

trDb.close();
ticksDb.close();
