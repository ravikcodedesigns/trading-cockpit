// Phase 1D-filter — composite filter analysis on train set.
//
// Tests cascading filters against the unfiltered baseline for the FADE
// direction (winners from baseline_analysis). Also runs the chosen filters
// across all TP/SL combos so the best risk/reward can be selected.
//
// Usage:
//   tsx scripts/phase1/filter_analysis.ts --set train
//   tsx scripts/phase1/filter_analysis.ts --set test

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../../..');
const DOLLAR_PER_PT = 2;

interface OutcomeResult {
  result: 'TP' | 'SL' | 'TIMEOUT';
  raw_pnl_pts: number;
  slip_pnl_pts: number;
}
interface Event {
  day: string;
  level_label: string;
  touch_type: string;
  approach_dir: 'from_above' | 'from_below';
  features: {
    bucket: 'OPEN' | 'MID' | 'CLOSE';
    [k: string]: unknown;
  };
  outcomes: Record<string, { fade: OutcomeResult; breakout: OutcomeResult }>;
}

interface AggValue { n: number; w: number; l: number; t: number; raw_pts: number; slip_pts: number }
function emptyAgg(): AggValue { return { n: 0, w: 0, l: 0, t: 0, raw_pts: 0, slip_pts: 0 }; }
function addOutcome(agg: AggValue, o: OutcomeResult) {
  agg.n++;
  agg.raw_pts += o.raw_pnl_pts;
  agg.slip_pts += o.slip_pnl_pts;
  if (o.result === 'TP') agg.w++;
  else if (o.result === 'SL') agg.l++;
  else agg.t++;
}
function fmt(a: AggValue) {
  const wr = a.n ? (a.w / a.n * 100) : 0;
  const closed = a.w + a.l;
  const wrC = closed ? (a.w / closed * 100) : 0;
  const $ = (a.slip_pts * DOLLAR_PER_PT).toFixed(0);
  const per = a.n ? (a.slip_pts * DOLLAR_PER_PT / a.n).toFixed(1) : '0';
  return `n=${String(a.n).padStart(3)} W=${String(a.w).padStart(3)} L=${String(a.l).padStart(3)} T=${String(a.t).padStart(2)}  WR=${wr.toFixed(0).padStart(3)}% (closed=${wrC.toFixed(0).padStart(3)}%)  slip $=${$.padStart(7)}  $/trade=${per.padStart(7)}`;
}

function runFilter(
  events: Event[],
  filterFn: (e: Event) => boolean,
  dir: 'fade' | 'breakout',
  tpsl: string,
): AggValue {
  const agg = emptyAgg();
  for (const e of events) if (filterFn(e)) addOutcome(agg, e.outcomes[tpsl]![dir]);
  return agg;
}

function main() {
  const argv = process.argv.slice(2);
  const setArg = argv.includes('--set') ? argv[argv.indexOf('--set') + 1] : 'train';
  const file = path.join(REPO, `phase1-events-${setArg}.json`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events: Event[] = data.events;
  const tpSlKeys = Object.keys(events[0]!.outcomes);

  console.log(`\n═══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`Phase 1D filter analysis — set=${setArg}, n=${events.length}`);
  console.log(`═══════════════════════════════════════════════════════════════════════════════════════\n`);

  const filters: Array<{ name: string; pred: (e: Event) => boolean }> = [
    { name: 'BASELINE',                                       pred: () => true },
    { name: 'touch_type=FRESH',                               pred: e => e.touch_type === 'FRESH' },
    { name: 'touch_type=POST_BREACH',                         pred: e => e.touch_type === 'POST_BREACH' },
    { name: 'level∈{VAL,POC,IBL,IBH}',                        pred: e => ['VAL','POC','IBL','IBH'].includes(e.level_label) },
    { name: 'level∈{VAL,POC}',                                pred: e => ['VAL','POC'].includes(e.level_label) },
    { name: 'bucket=OPEN',                                    pred: e => e.features.bucket === 'OPEN' },
    { name: 'bucket=MID',                                     pred: e => e.features.bucket === 'MID' },
    { name: 'bucket∈{OPEN,MID}',                              pred: e => e.features.bucket !== 'CLOSE' },
    { name: 'FRESH + VAL/POC/IBL/IBH',                        pred: e => e.touch_type === 'FRESH' && ['VAL','POC','IBL','IBH'].includes(e.level_label) },
    { name: 'FRESH + VAL/POC',                                pred: e => e.touch_type === 'FRESH' && ['VAL','POC'].includes(e.level_label) },
    { name: 'FRESH + bucket=OPEN',                            pred: e => e.touch_type === 'FRESH' && e.features.bucket === 'OPEN' },
    { name: 'FRESH + bucket∈{OPEN,MID}',                      pred: e => e.touch_type === 'FRESH' && e.features.bucket !== 'CLOSE' },
    { name: 'FRESH + VAL/POC/IBL/IBH + OPEN',                 pred: e => e.touch_type === 'FRESH' && ['VAL','POC','IBL','IBH'].includes(e.level_label) && e.features.bucket === 'OPEN' },
    { name: 'FRESH + VAL/POC/IBL/IBH + OPEN/MID',             pred: e => e.touch_type === 'FRESH' && ['VAL','POC','IBL','IBH'].includes(e.level_label) && e.features.bucket !== 'CLOSE' },
    { name: 'POST_BREACH + VAL/POC/IBL/IBH',                  pred: e => e.touch_type === 'POST_BREACH' && ['VAL','POC','IBL','IBH'].includes(e.level_label) },
    { name: 'POST_BREACH + VAL/POC/IBL/IBH + OPEN',           pred: e => e.touch_type === 'POST_BREACH' && ['VAL','POC','IBL','IBH'].includes(e.level_label) && e.features.bucket === 'OPEN' },
  ];

  // For each filter: report on 30/10 fade (representative). Then re-run the best
  // filter across all TP/SL combos.
  console.log('── Filter sweep on FADE direction, 30/10 (representative scalp) ──\n');
  let bestName = '';
  let bestAgg: AggValue | null = null;
  let bestFilter: ((e: Event) => boolean) | null = null;
  for (const f of filters) {
    const agg = runFilter(events, f.pred, 'fade', '30/10');
    const star = agg.n >= 15 && agg.slip_pts * DOLLAR_PER_PT > (bestAgg?.slip_pts ?? -Infinity) * DOLLAR_PER_PT ? ' ★' : '';
    if (agg.n >= 15 && (!bestAgg || agg.slip_pts > bestAgg.slip_pts)) {
      bestAgg = agg;
      bestName = f.name;
      bestFilter = f.pred;
    }
    console.log(`  ${f.name.padEnd(45)} ${fmt(agg)}${star}`);
  }

  if (bestFilter) {
    console.log(`\n── Best filter "${bestName}" — sweep across all TP/SL on FADE ──\n`);
    for (const tpsl of tpSlKeys) {
      const agg = runFilter(events, bestFilter, 'fade', tpsl);
      console.log(`  ${tpsl.padEnd(8)} ${fmt(agg)}`);
    }
  }

  // Also dump the per-feature winners-vs-losers summary for the BEST filter cohort
  if (bestFilter) {
    console.log(`\n── Feature distributions for "${bestName}" cohort (30/10 fade) ──\n`);
    const winners: Event[] = [];
    const losers: Event[] = [];
    for (const e of events) {
      if (!bestFilter(e)) continue;
      const r = e.outcomes['30/10']!.fade.result;
      if (r === 'TP') winners.push(e);
      else if (r === 'SL') losers.push(e);
    }
    const featureKeys = Object.keys(events[0]!.features).filter(k => k !== 'bucket' && typeof events[0]!.features[k] === 'number');
    console.log(`  ${'feature'.padEnd(28)}${'W avg'.padStart(10)}${'L avg'.padStart(10)}${'Δ avg'.padStart(10)}${'  W med'.padStart(10)}${'L med'.padStart(10)}`);
    for (const k of featureKeys) {
      const wv = winners.map(e => e.features[k] as number).filter(v => Number.isFinite(v)).sort((a,b)=>a-b);
      const lv = losers.map(e => e.features[k] as number).filter(v => Number.isFinite(v)).sort((a,b)=>a-b);
      if (wv.length === 0 || lv.length === 0) continue;
      const wAvg = wv.reduce((a,b)=>a+b,0)/wv.length;
      const lAvg = lv.reduce((a,b)=>a+b,0)/lv.length;
      const wMed = wv[Math.floor(wv.length/2)];
      const lMed = lv[Math.floor(lv.length/2)];
      const dlt = wAvg - lAvg;
      const isInteresting = Math.abs(dlt) > 0 && Math.abs(dlt / ((Math.abs(wAvg) + Math.abs(lAvg))/2 || 1)) > 0.1;
      const tag = isInteresting ? ' *' : '';
      console.log(`  ${k.padEnd(28)}${wAvg.toFixed(2).padStart(10)}${lAvg.toFixed(2).padStart(10)}${dlt.toFixed(2).padStart(10)}${(wMed ?? 0).toFixed(2).padStart(10)}${(lMed ?? 0).toFixed(2).padStart(10)}${tag}`);
    }
  }
}

main();
