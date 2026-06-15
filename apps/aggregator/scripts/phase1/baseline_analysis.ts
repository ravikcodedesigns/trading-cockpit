// Phase 1D-baseline — unfiltered cohort summary.
//
// Reads phase1-events-<set>.json and reports per-(TP/SL × direction) WR/PnL.
// Then breaks down by touch_type, level, bucket, approach_dir so we can
// see where the natural signal lives BEFORE any feature filtering.
//
// Usage:
//   tsx scripts/phase1/baseline_analysis.ts --set train
//   tsx scripts/phase1/baseline_analysis.ts --set test

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

interface EnrichedEvent {
  day: string;
  level_label: string;
  touch_type: string;
  approach_dir: string;
  features: { bucket: 'OPEN' | 'MID' | 'CLOSE' };
  outcomes: Record<string, { fade: OutcomeResult; breakout: OutcomeResult }>;
}

interface AggKey { tpsl: string; dir: 'fade' | 'breakout'; subset?: string }
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
function fmtAgg(a: AggValue) {
  const wr = a.n ? (a.w / a.n * 100) : 0;
  const closed = a.w + a.l;
  const wrClosed = closed ? (a.w / closed * 100) : 0;
  const $ = (a.slip_pts * DOLLAR_PER_PT).toFixed(0);
  const perTrade = a.n ? (a.slip_pts * DOLLAR_PER_PT / a.n).toFixed(1) : '0';
  return `n=${String(a.n).padStart(3)}  W=${String(a.w).padStart(3)} L=${String(a.l).padStart(3)} T=${String(a.t).padStart(3)}  WR=${wr.toFixed(0).padStart(3)}%  WR(closed)=${wrClosed.toFixed(0).padStart(3)}%  raw=${String(a.raw_pts.toFixed(0)).padStart(5)}pt  slip=${String(a.slip_pts.toFixed(0)).padStart(5)}pt  $=${$.padStart(6)}  $/trade=${perTrade.padStart(6)}`;
}

function main() {
  const argv = process.argv.slice(2);
  const setArg = argv.includes('--set') ? argv[argv.indexOf('--set') + 1] : 'train';
  const file = path.join(REPO, `phase1-events-${setArg}.json`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events: EnrichedEvent[] = data.events;
  const tpSlKeys = Object.keys(events[0]!.outcomes);

  console.log(`\n═══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`Phase 1D baseline — set=${setArg}, n=${events.length} touches`);
  console.log(`═══════════════════════════════════════════════════════════════════════════════════════\n`);

  // ── Overall TP/SL × direction matrix ──
  console.log('── Overall: each TP/SL combo, each direction (slip-adjusted PnL) ──\n');
  for (const tpsl of tpSlKeys) {
    for (const dir of ['fade', 'breakout'] as const) {
      const agg = emptyAgg();
      for (const e of events) addOutcome(agg, e.outcomes[tpsl]![dir]);
      console.log(`  ${tpsl.padEnd(8)} ${dir.padEnd(9)}  ${fmtAgg(agg)}`);
    }
    console.log();
  }

  // Identify the best-performing combo for each direction
  console.log('── Best $-yield combo per direction ──\n');
  for (const dir of ['fade', 'breakout'] as const) {
    let best: { tpsl: string; agg: AggValue } | null = null;
    for (const tpsl of tpSlKeys) {
      const agg = emptyAgg();
      for (const e of events) addOutcome(agg, e.outcomes[tpsl]![dir]);
      if (!best || agg.slip_pts > best.agg.slip_pts) best = { tpsl, agg };
    }
    console.log(`  ${dir.padEnd(9)}: best is ${best!.tpsl}  ${fmtAgg(best!.agg)}`);
  }
  console.log();

  // ── Breakdown by touch_type ──
  console.log('── By touch_type × direction (using 30/10 combo as representative scalp) ──\n');
  const repTpSl = '30/10';
  const byType: Record<string, Record<'fade' | 'breakout', AggValue>> = {};
  for (const e of events) {
    if (!byType[e.touch_type]) byType[e.touch_type] = { fade: emptyAgg(), breakout: emptyAgg() };
    addOutcome(byType[e.touch_type]!.fade, e.outcomes[repTpSl]!.fade);
    addOutcome(byType[e.touch_type]!.breakout, e.outcomes[repTpSl]!.breakout);
  }
  for (const [tt, dirs] of Object.entries(byType).sort((a, b) => b[1].fade.n - a[1].fade.n)) {
    console.log(`  ${tt.padEnd(15)} FADE:     ${fmtAgg(dirs.fade)}`);
    console.log(`  ${tt.padEnd(15)} BREAKOUT: ${fmtAgg(dirs.breakout)}`);
    console.log();
  }

  // ── Breakdown by level_label × direction ──
  console.log('── By level_label × direction (30/10 scalp) ──\n');
  const byLevel: Record<string, Record<'fade' | 'breakout', AggValue>> = {};
  for (const e of events) {
    if (!byLevel[e.level_label]) byLevel[e.level_label] = { fade: emptyAgg(), breakout: emptyAgg() };
    addOutcome(byLevel[e.level_label]!.fade, e.outcomes[repTpSl]!.fade);
    addOutcome(byLevel[e.level_label]!.breakout, e.outcomes[repTpSl]!.breakout);
  }
  for (const [lvl, dirs] of Object.entries(byLevel).sort((a, b) => b[1].fade.n - a[1].fade.n)) {
    console.log(`  ${lvl.padEnd(6)} FADE:     ${fmtAgg(dirs.fade)}`);
    console.log(`  ${lvl.padEnd(6)} BREAKOUT: ${fmtAgg(dirs.breakout)}`);
    console.log();
  }

  // ── Breakdown by bucket × direction ──
  console.log('── By bucket × direction (30/10 scalp) ──\n');
  const byBucket: Record<string, Record<'fade' | 'breakout', AggValue>> = {};
  for (const e of events) {
    const b = e.features.bucket;
    if (!byBucket[b]) byBucket[b] = { fade: emptyAgg(), breakout: emptyAgg() };
    addOutcome(byBucket[b]!.fade, e.outcomes[repTpSl]!.fade);
    addOutcome(byBucket[b]!.breakout, e.outcomes[repTpSl]!.breakout);
  }
  for (const b of ['OPEN', 'MID', 'CLOSE']) {
    if (!byBucket[b]) continue;
    console.log(`  ${b.padEnd(7)} FADE:     ${fmtAgg(byBucket[b]!.fade)}`);
    console.log(`  ${b.padEnd(7)} BREAKOUT: ${fmtAgg(byBucket[b]!.breakout)}`);
    console.log();
  }

  // ── Breakdown by approach_dir × direction ──
  console.log('── By approach_dir × direction (30/10 scalp) ──\n');
  const byApproach: Record<string, Record<'fade' | 'breakout', AggValue>> = {};
  for (const e of events) {
    if (!byApproach[e.approach_dir]) byApproach[e.approach_dir] = { fade: emptyAgg(), breakout: emptyAgg() };
    addOutcome(byApproach[e.approach_dir]!.fade, e.outcomes[repTpSl]!.fade);
    addOutcome(byApproach[e.approach_dir]!.breakout, e.outcomes[repTpSl]!.breakout);
  }
  for (const [ad, dirs] of Object.entries(byApproach)) {
    console.log(`  ${ad.padEnd(12)} FADE:     ${fmtAgg(dirs.fade)}`);
    console.log(`  ${ad.padEnd(12)} BREAKOUT: ${fmtAgg(dirs.breakout)}`);
    console.log();
  }
}

main();
