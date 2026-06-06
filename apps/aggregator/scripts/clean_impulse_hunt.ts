// Clean-impulse hunter
//
// Empirical signal discovery: scan full ticks.db history (May-June) for moments
// where price ACTUALLY moves +12pt within 10 min without ever pulling back -3pt.
// These are the "clean impulse" moments that the goal's R:R 1:4 constraint
// requires. Find their COUNT (per day, per time-of-day) and identify
// common features that precede them.
//
// Two outputs:
//   1. Daily count of clean-impulse moments (LONG direction)
//   2. Distribution of features in the 60s window BEFORE each clean-impulse:
//      - 1-min bar range (compression score)
//      - VWAP distance
//      - Recent net aggressor volume
//      - Time-of-day
//
// If clean impulses are rare but identifiable, we have a 70%+ WR target setup.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

console.log = (...a:any[]) => { fs.writeSync(1, a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')+'\n'); };

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TK_DB = path.resolve(__dirname, '../../../data/ticks.db');
const tk = new Database(TK_DB, { readonly: true });

const SYMBOL = 'NQ';
const TP_PTS = 12;
const SL_PTS = 3;
const HORIZON_MS = 10 * 60_000;
const SCAN_RES_MS = 5_000;   // evaluate every 5 seconds
const LOOKBACK_FEAT_MS = 60_000;

// Date range: May-June 2026
const SCAN_START = Date.parse('2026-05-01T00:00:00Z');
const SCAN_END   = Date.parse('2026-06-03T05:00:00Z');

console.log(`═══ Clean-impulse hunt — LONG +${TP_PTS}pt without -${SL_PTS}pt adverse ═══`);
console.log(`Scanning every ${SCAN_RES_MS/1000}s; horizon ${HORIZON_MS/60_000}min\n`);

// We'll process one day at a time to manage memory
function dayBounds(dayStartMs: number): { start: number; end: number } {
  return { start: dayStartMs, end: dayStartMs + 24*60*60_000 };
}
function isRTH(tsMs: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(get('weekday'))
    && min >= 570 && min < 960;
}
function etDate(tsMs: number): string {
  return new Date(tsMs - 4*60*60_000).toISOString().substring(0, 10);
}
function etMinute(tsMs: number): number {
  const d = new Date(tsMs - 4*60*60_000);
  return d.getUTCHours()*60 + d.getUTCMinutes();
}

interface CleanImpulse {
  ts: number;
  entryPx: number;
  features: {
    range_5min: number;
    vwap_dist: number;
    net_aggressor_60s: number;
    et_minute: number;
    et_date: string;
  };
}

const impulses: CleanImpulse[] = [];
const dayCounts: Record<string, number> = {};

let curMs = SCAN_START;
while (curMs < SCAN_END) {
  const { start, end } = dayBounds(curMs);
  curMs = end;
  // Skip weekends
  const wd = new Date(start - 4*60*60_000).getUTCDay();
  if (wd === 0 || wd === 6) continue;
  const dayLabel = etDate(start + 12*60*60_000);

  // Load this day's NQ ticks
  const ticks = tk.prepare(`
    SELECT ts, price, size, is_bid_aggressor FROM trades
    WHERE symbol = ? AND ts BETWEEN ? AND ?
    ORDER BY ts ASC
  `).all(SYMBOL, start, end) as Array<{ts:number;price:number;size:number;is_bid_aggressor:number}>;
  if (ticks.length < 1000) continue;

  // Index by ts for fast lookups
  const tsArr = ticks.map(t => t.ts);
  function idxAtOrAfter(ts: number): number {
    let lo=0,hi=tsArr.length-1,res=tsArr.length;
    while(lo<=hi){const m=(lo+hi)>>1;if(tsArr[m]!>=ts){res=m;hi=m-1}else lo=m+1}
    return res;
  }
  function priceAt(ts: number): number | null {
    let lo=0,hi=tsArr.length-1,res=-1;
    while(lo<=hi){const m=(lo+hi)>>1;if(tsArr[m]!<=ts){res=m;lo=m+1}else hi=m-1}
    return res>=0?ticks[res]!.price:null;
  }

  let dayImpulses = 0;
  let lastFoundTs = 0;  // cooldown between detected impulses

  // Scan every 5s during RTH
  const dayStartScan = ticks[0]!.ts;
  const dayEndScan = ticks[ticks.length-1]!.ts - HORIZON_MS;
  for (let scanTs = dayStartScan; scanTs < dayEndScan; scanTs += SCAN_RES_MS) {
    if (!isRTH(scanTs)) continue;
    if (scanTs - lastFoundTs < 10*60_000) continue;  // 10-min cooldown

    const entryPx = priceAt(scanTs);
    if (entryPx === null) continue;
    const tp = entryPx + TP_PTS;
    const sl = entryPx - SL_PTS;

    // Walk forward
    const startIdx = idxAtOrAfter(scanTs+1);
    const horizonEnd = scanTs + HORIZON_MS;
    let hitTP = false, hitSL = false;
    for (let i = startIdx; i < ticks.length; i++) {
      const t = ticks[i]!;
      if (t.ts > horizonEnd) break;
      if (t.price >= tp) { hitTP = true; break; }
      if (t.price <= sl) { hitSL = true; break; }
    }
    if (!hitTP || hitSL) continue;

    // Clean impulse found! Compute features
    const featStart = scanTs - LOOKBACK_FEAT_MS;
    const featStartIdx = idxAtOrAfter(featStart);
    let hi = -Infinity, lo = Infinity, netVol = 0;
    let sumPV = 0, sumV = 0;
    const vwapStart = scanTs - 5*60_000;
    const vwapStartIdx = idxAtOrAfter(vwapStart);
    for (let i = vwapStartIdx; i < ticks.length; i++) {
      const t = ticks[i]!;
      if (t.ts > scanTs) break;
      sumPV += t.price * t.size;
      sumV += t.size;
      if (t.ts >= featStart) {
        if (t.price > hi) hi = t.price;
        if (t.price < lo) lo = t.price;
        netVol += (t.is_bid_aggressor === 1 ? 1 : -1) * t.size;
      }
    }
    const vwap = sumV > 0 ? sumPV / sumV : entryPx;
    impulses.push({
      ts: scanTs, entryPx,
      features: {
        range_5min: hi - lo,
        vwap_dist: entryPx - vwap,
        net_aggressor_60s: netVol,
        et_minute: etMinute(scanTs),
        et_date: dayLabel,
      },
    });
    dayImpulses++;
    lastFoundTs = scanTs;
  }
  if (dayImpulses > 0) dayCounts[dayLabel] = dayImpulses;
}

console.log(`Total clean-impulse moments found: ${impulses.length}`);
console.log(`Across ${Object.keys(dayCounts).length} trading days`);
console.log(`Daily distribution:`);
const days = Object.entries(dayCounts).sort();
for (const [d, n] of days) console.log(`  ${d}: ${n}`);
const counts = days.map(([, n]) => n).sort((a,b)=>a-b);
console.log(`  min=${counts[0]}, p50=${counts[Math.floor(counts.length*0.5)]}, p90=${counts[Math.floor(counts.length*0.9)]}, max=${counts[counts.length-1]}`);

// Feature analysis
console.log(`\n══ Feature distribution at clean-impulse moments ══`);
function stats(name: string, vals: number[]) {
  const s = [...vals].sort((a,b)=>a-b);
  if (!s.length) return;
  console.log(`  ${name}: n=${s.length}  p10=${s[Math.floor(s.length*0.1)]!.toFixed(1)}  p50=${s[Math.floor(s.length*0.5)]!.toFixed(1)}  p90=${s[Math.floor(s.length*0.9)]!.toFixed(1)}  mean=${(s.reduce((a,b)=>a+b,0)/s.length).toFixed(1)}`);
}
stats('range_5min', impulses.map(i => i.features.range_5min));
stats('vwap_dist', impulses.map(i => i.features.vwap_dist));
stats('net_agg_60s', impulses.map(i => i.features.net_aggressor_60s));
stats('et_minute', impulses.map(i => i.features.et_minute));

// Time-of-day buckets
console.log(`\n  Time-of-day bucket distribution:`);
const buckets = [
  ['09:30-10:00', 570, 600],
  ['10:00-11:00', 600, 660],
  ['11:00-12:00', 660, 720],
  ['12:00-13:00', 720, 780],
  ['13:00-14:00', 780, 840],
  ['14:00-15:00', 840, 900],
  ['15:00-16:00', 900, 960],
] as const;
for (const [label, lo, hi] of buckets) {
  const n = impulses.filter(i => i.features.et_minute >= lo && i.features.et_minute < hi).length;
  console.log(`    ${label}: ${n}`);
}

console.log(`\nDone.`);
