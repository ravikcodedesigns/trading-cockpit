/**
 * Phase 2 — load + validate human-labeled tier-1 reversal setups from TSV.
 *
 * Usage:
 *   import { loadSetups } from './load_setups';
 *   const setups = loadSetups('scripts/phase2/setups.tsv');
 *
 * Validation enforced:
 *   - date is in one of the cohort buckets (else: cohort='unknown', warned)
 *   - level_label ∈ TIER1 (PDH/PDL/PDC/POC/VAH/VAL)
 *   - direction ∈ {long, short}
 *   - outcome ∈ {pos, neg}
 *   - sl_pts, tp_pts > 0
 *   - entry_ts_et within RTH (09:30:00 → 15:54:00)
 *
 * Output: each row gets `entry_ts_ms` (UTC ms) computed from date + entry_ts_et
 * using DST-aware ET→UTC, so downstream analysis can window strictly.
 */

import fs from 'node:fs';
import { TRAIN_DAYS, TEST_DAYS, HOLDOUT_DAYS } from '../phase1/days.js';

export const TIER1_LEVELS = ['PDH', 'PDL', 'PDC', 'POC', 'VAH', 'VAL'] as const;
export type Tier1Level = (typeof TIER1_LEVELS)[number];
export type Cohort = 'train' | 'test' | 'holdout' | 'unknown';

// June days where we have full BMD L2/L3 MBO data (Tier B).
const MBO_TRAIN = new Set(['2026-06-02', '2026-06-04', '2026-06-08', '2026-06-10']);
const MBO_TEST  = new Set(['2026-06-03', '2026-06-05', '2026-06-09', '2026-06-11']);

const TRAIN = new Set<string>(TRAIN_DAYS as readonly string[]);
const TEST  = new Set<string>(TEST_DAYS  as readonly string[]);
const HOLD  = new Set<string>(HOLDOUT_DAYS as readonly string[]);

const COLUMNS = [
  'date', 'symbol', 'entry_ts_et', 'level_label',
  'direction', 'outcome', 'sl_pts', 'tp_pts', 'note',
] as const;

export interface Setup {
  date: string;            // YYYY-MM-DD ET
  symbol: 'NQ' | 'ES';
  entry_ts_et: string;     // HH:MM:SS.mmm
  entry_ts_ms: number;     // UTC ms — what queries use
  level_label: Tier1Level;
  direction: 'long' | 'short';
  outcome: 'pos' | 'neg';
  sl_pts: number;
  tp_pts: number;
  note: string;
  cohort_a: Cohort;        // price-action cohort (Phase 1 buckets)
  cohort_b: Cohort | null; // MBO cohort (null if date has no MBO data)
}

/** ET wall clock → UTC ms (DST-aware). */
function etToUtcMs(date: string, hms: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const m_ = m! - 1;
  const [hh, mm, rest] = hms.split(':');
  const [ss, ms = '0'] = rest!.split('.');
  const h = Number(hh), min = Number(mm), s = Number(ss);
  const milli = Number(ms.padEnd(3, '0').slice(0, 3));

  // Anchor at UTC = ET+4 (EDT default) and correct against the actual NY hour
  // — handles standard time and DST without bundling a tz library.
  const guess = Date.UTC(y!, m_, d!, h + 4, min, s, milli);
  const nyHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false })
      .format(new Date(guess)),
    10,
  );
  return guess + (h - nyHour) * 3600_000;
}

function cohortA(date: string): Cohort {
  if (TRAIN.has(date)) return 'train';
  if (TEST.has(date))  return 'test';
  if (HOLD.has(date))  return 'holdout';
  return 'unknown';
}

function cohortB(date: string): Cohort | null {
  if (MBO_TRAIN.has(date)) return 'train';
  if (MBO_TEST.has(date))  return 'test';
  if (HOLD.has(date))      return 'holdout'; // 06-12 has MBO + is held out
  return null;
}

function isRth(hms: string): boolean {
  const [h, m] = hms.split(':').map(Number);
  const min = h! * 60 + m!;
  return min >= 9 * 60 + 30 && min <= 15 * 60 + 54;
}

export interface LoadOptions {
  /** Throw on any validation error instead of warning. Default: false. */
  strict?: boolean;
}

export function loadSetups(path: string, opts: LoadOptions = {}): Setup[] {
  const text = fs.readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const setups: Setup[] = [];
  const warnings: string[] = [];

  let headerSeen = false;
  let lineNo = 0;
  for (const raw of lines) {
    lineNo++;
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.startsWith('#')) continue;

    const cols = line.split('\t');
    if (!headerSeen) {
      // Validate header exactly matches schema
      for (let i = 0; i < COLUMNS.length; i++) {
        if (cols[i] !== COLUMNS[i]) {
          throw new Error(`L${lineNo}: header mismatch at col ${i + 1} — got '${cols[i]}', want '${COLUMNS[i]}'`);
        }
      }
      headerSeen = true;
      continue;
    }

    if (cols.length < COLUMNS.length) {
      warnings.push(`L${lineNo}: only ${cols.length} cols (need ${COLUMNS.length}) — did you use spaces instead of tabs?`);
      continue;
    }

    const [date, symbol, entry_ts_et, level_label, direction, outcome, sl_pts, tp_pts, ...noteParts] = cols;
    const note = noteParts.join('\t');
    const errs: string[] = [];

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date!))               errs.push(`bad date '${date}'`);
    if (symbol !== 'NQ' && symbol !== 'ES')               errs.push(`bad symbol '${symbol}'`);
    if (!/^\d{2}:\d{2}:\d{2}(\.\d{1,3})?$/.test(entry_ts_et!)) errs.push(`bad entry_ts_et '${entry_ts_et}' (want HH:MM:SS.mmm)`);
    if (!(TIER1_LEVELS as readonly string[]).includes(level_label!)) errs.push(`bad level '${level_label}'`);
    if (direction !== 'long' && direction !== 'short')    errs.push(`bad direction '${direction}'`);
    if (outcome !== 'pos' && outcome !== 'neg')           errs.push(`bad outcome '${outcome}'`);

    const slN = Number(sl_pts), tpN = Number(tp_pts);
    if (!(slN > 0)) errs.push(`bad sl_pts '${sl_pts}'`);
    if (!(tpN > 0)) errs.push(`bad tp_pts '${tp_pts}'`);

    if (entry_ts_et && !isRth(entry_ts_et)) errs.push(`entry_ts_et '${entry_ts_et}' outside RTH 09:30-15:54`);

    if (errs.length) {
      warnings.push(`L${lineNo}: ${errs.join('; ')}`);
      continue;
    }

    setups.push({
      date: date!,
      symbol: symbol as 'NQ' | 'ES',
      entry_ts_et: entry_ts_et!,
      entry_ts_ms: etToUtcMs(date!, entry_ts_et!),
      level_label: level_label as Tier1Level,
      direction: direction as 'long' | 'short',
      outcome: outcome as 'pos' | 'neg',
      sl_pts: slN,
      tp_pts: tpN,
      note,
      cohort_a: cohortA(date!),
      cohort_b: cohortB(date!),
    });
  }

  if (warnings.length) {
    const msg = `loaded ${setups.length} setups; ${warnings.length} skipped:\n  ` + warnings.join('\n  ');
    if (opts.strict) throw new Error(msg);
    console.warn(msg);
  }

  return setups;
}

// ─── CLI: print a summary when run directly ──────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? 'apps/aggregator/scripts/phase2/setups.tsv';
  const setups = loadSetups(path);
  const by = (key: (s: Setup) => string) => {
    const m: Record<string, number> = {};
    for (const s of setups) m[key(s)] = (m[key(s)] ?? 0) + 1;
    return m;
  };
  console.log(`Loaded ${setups.length} setups from ${path}`);
  console.log('\nBy cohort A (price-action):'); console.table(by(s => `${s.cohort_a}/${s.outcome}`));
  console.log('\nBy cohort B (MBO):');           console.table(by(s => `${s.cohort_b ?? 'none'}/${s.outcome}`));
  console.log('\nBy level/direction:');          console.table(by(s => `${s.level_label}/${s.direction}`));
  console.log('\nBy date:');                     console.table(by(s => s.date));
}
