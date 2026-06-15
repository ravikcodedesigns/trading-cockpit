// Phase 1F — Look-ahead-corrected analysis.
//
// IBH/IBL are written by the EVENING structural cron — they reflect today's
// 09:30-10:30 RTH range and are NOT known in real time before 10:30 ET.
// Any IBH/IBL touch fired before 10:30 was using future information.
//
// This script reruns the train_vs_test analysis with that exclusion applied,
// to give the honest no-look-ahead picture.
//
// Usage:
//   tsx scripts/phase1/no_lookahead_analysis.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../../..');
const DOLLAR_PER_PT = 2;

interface OutcomeResult { result: 'TP'|'SL'|'TIMEOUT'; raw_pnl_pts: number; slip_pnl_pts: number }
interface Event {
  touch_ts: number;
  touch_type: string;
  level_label: string;
  features: { bucket: 'OPEN'|'MID'|'CLOSE' };
  outcomes: Record<string, { fade: OutcomeResult; breakout: OutcomeResult }>;
}

function etHourMinute(tsMs: number): { hh: number; mm: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(tsMs));
  return {
    hh: parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10),
    mm: parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10),
  };
}

// Look-ahead filter: IBH/IBL not available before 10:30 ET. Drop those.
function hasLookahead(e: Event): boolean {
  if (e.level_label !== 'IBH' && e.level_label !== 'IBL') return false;
  const { hh, mm } = etHourMinute(e.touch_ts);
  return (hh * 60 + mm) < (10 * 60 + 30);
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
  const trAll: Event[] = train.events;
  const teAll: Event[] = test.events;

  // Look-ahead-filtered cohorts
  const trEv = trAll.filter(e => !hasLookahead(e));
  const teEv = teAll.filter(e => !hasLookahead(e));

  console.log(`Removed look-ahead touches:`);
  console.log(`  train: ${trAll.length - trEv.length}/${trAll.length} dropped (${100*(trAll.length-trEv.length)/trAll.length|0}%)`);
  console.log(`  test:  ${teAll.length - teEv.length}/${teAll.length} dropped (${100*(teAll.length-teEv.length)/teAll.length|0}%)`);

  const tpSlKeys = Object.keys(trEv[0]!.outcomes);
  const filters: Array<{name:string; pred:(e:Event)=>boolean}> = [
    { name: 'BASELINE (no-lookahead)',           pred: () => true },
    { name: 'FRESH',                              pred: e => e.touch_type === 'FRESH' },
    { name: 'POST_BREACH',                        pred: e => e.touch_type === 'POST_BREACH' },
    { name: 'FRESH + level∈{VAL,POC,IBL,IBH}',    pred: e => e.touch_type === 'FRESH' && ['VAL','POC','IBL','IBH'].includes(e.level_label) },
    { name: 'FRESH + level∉{IBH,IBL}',            pred: e => e.touch_type === 'FRESH' && !['IBH','IBL'].includes(e.level_label) },
    { name: 'FRESH + bucket=OPEN',                pred: e => e.touch_type === 'FRESH' && e.features.bucket === 'OPEN' },
    { name: 'FRESH + bucket=MID',                 pred: e => e.touch_type === 'FRESH' && e.features.bucket === 'MID' },
  ];

  console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('Phase 1F — NO-LOOK-AHEAD: Train vs Test, FADE direction');
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
}

main();
