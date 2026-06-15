// Phase 1E — Train vs Test side-by-side validation of the FRESH filter.
//
// Computes WR / $/trade for the canonical "touch_type=FRESH" filter across
// the full TP/SL grid on both train and test sets, side by side.
//
// If the test numbers hold within reasonable noise of train, the FRESH
// signal is robust. If test collapses, it was overfit (or coincidence).
//
// Usage:
//   tsx scripts/phase1/train_vs_test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../../..');
const DOLLAR_PER_PT = 2;

interface OutcomeResult { result: 'TP'|'SL'|'TIMEOUT'; raw_pnl_pts: number; slip_pnl_pts: number }
interface Event {
  touch_type: string;
  level_label: string;
  features: { bucket: 'OPEN'|'MID'|'CLOSE' };
  outcomes: Record<string, { fade: OutcomeResult; breakout: OutcomeResult }>;
}

interface Stats { n: number; w: number; l: number; t: number; raw_pts: number; slip_pts: number }
const emptyStats = (): Stats => ({ n:0, w:0, l:0, t:0, raw_pts:0, slip_pts:0 });

function aggregate(events: Event[], pred: (e:Event)=>boolean, dir:'fade'|'breakout', tpsl:string): Stats {
  const s = emptyStats();
  for (const e of events) {
    if (!pred(e)) continue;
    const o = e.outcomes[tpsl]![dir];
    s.n++;
    s.raw_pts += o.raw_pnl_pts;
    s.slip_pts += o.slip_pnl_pts;
    if (o.result === 'TP') s.w++;
    else if (o.result === 'SL') s.l++;
    else s.t++;
  }
  return s;
}

function fmt(s: Stats): string {
  const wr = s.n ? (s.w / s.n * 100) : 0;
  const $ = (s.slip_pts * DOLLAR_PER_PT).toFixed(0);
  const per = s.n ? (s.slip_pts * DOLLAR_PER_PT / s.n).toFixed(1) : '0';
  return `n=${String(s.n).padStart(3)} W=${String(s.w).padStart(3)} L=${String(s.l).padStart(3)}  WR=${wr.toFixed(0).padStart(3)}%  $=${$.padStart(6)}  $/t=${per.padStart(6)}`;
}

function main() {
  const train = JSON.parse(fs.readFileSync(path.join(REPO, 'phase1-events-train.json'), 'utf8'));
  const test  = JSON.parse(fs.readFileSync(path.join(REPO, 'phase1-events-test.json'),  'utf8'));
  const trEv: Event[] = train.events;
  const teEv: Event[] = test.events;

  const filters: Array<{name:string; pred:(e:Event)=>boolean}> = [
    { name: 'BASELINE',                         pred: () => true },
    { name: 'FRESH',                            pred: e => e.touch_type === 'FRESH' },
    { name: 'POST_BREACH',                      pred: e => e.touch_type === 'POST_BREACH' },
    { name: 'FRESH + level∈{VAL,POC,IBL,IBH}',  pred: e => e.touch_type === 'FRESH' && ['VAL','POC','IBL','IBH'].includes(e.level_label) },
    { name: 'FRESH + bucket=OPEN',              pred: e => e.touch_type === 'FRESH' && e.features.bucket === 'OPEN' },
    { name: 'FRESH + bucket=OPEN/MID',          pred: e => e.touch_type === 'FRESH' && e.features.bucket !== 'CLOSE' },
  ];

  const tpSlKeys = Object.keys(trEv[0]!.outcomes);

  console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('Phase 1E — Train vs Test side-by-side, FADE direction');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════\n');

  for (const f of filters) {
    console.log(`── Filter: ${f.name} ──\n`);
    console.log(`  ${'TP/SL'.padEnd(7)}  ${'TRAIN'.padEnd(58)}   ${'TEST'.padEnd(58)}`);
    console.log(`  ${'-'.repeat(7)}  ${'-'.repeat(58)}   ${'-'.repeat(58)}`);
    for (const k of tpSlKeys) {
      const trS = aggregate(trEv, f.pred, 'fade', k);
      const teS = aggregate(teEv, f.pred, 'fade', k);
      console.log(`  ${k.padEnd(7)}  ${fmt(trS).padEnd(58)}   ${fmt(teS).padEnd(58)}`);
    }
    console.log();
  }

  // Aggregate "deploy decision" table — for the FRESH filter, which TP/SL has
  // best post-slippage $/trade on TEST? (Test is our out-of-sample.)
  console.log('── Deployment decision: FRESH cohort ranked by TEST $/trade ──\n');
  const trFresh = (e:Event) => e.touch_type === 'FRESH';
  const ranking: Array<{tpsl:string; train:Stats; test:Stats}> = [];
  for (const k of tpSlKeys) {
    ranking.push({ tpsl: k, train: aggregate(trEv, trFresh, 'fade', k), test: aggregate(teEv, trFresh, 'fade', k) });
  }
  ranking.sort((a,b) => (b.test.slip_pts / Math.max(1, b.test.n)) - (a.test.slip_pts / Math.max(1, a.test.n)));
  for (const r of ranking) {
    console.log(`  ${r.tpsl.padEnd(7)}  train ${fmt(r.train)}   test ${fmt(r.test)}`);
  }
}

main();
