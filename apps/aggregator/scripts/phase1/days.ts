// Phase 1 — stratified train/test split for NQ structural-level analysis.
//
// 26 full-RTH trading days across two regimes:
//   • Bull rally   2026-05-06 → 2026-06-03   (20 days)
//   • Correction   2026-06-04 → 2026-06-11   (6 days)
//
// Days are alternated within each regime to ensure both train and test
// see both market conditions. 2026-06-12 (today) is held out for final
// live-deployment validation.
//
// Excluded:
//   2026-05-05  — no daily_levels.json entry (prior-day 05-04 too partial for PDH/PDL/PDC)
//   2026-05-07, 05-10, 05-17, 05-24, 05-25, 05-31, 06-06, 06-07
//                — partial / weekend overnight days
//   2026-06-12  — today, holdout

export const TRAIN_DAYS = [
  // Bull (10)
  '2026-05-06',
  '2026-05-08',
  '2026-05-12',
  '2026-05-14',
  '2026-05-18',
  '2026-05-20',
  '2026-05-22',
  '2026-05-27',
  '2026-05-29',
  '2026-06-02',
  // Correction (3)
  '2026-06-04',
  '2026-06-08',
  '2026-06-10',
] as const;

export const TEST_DAYS = [
  // Bull (9)
  '2026-05-11',
  '2026-05-13',
  '2026-05-15',
  '2026-05-19',
  '2026-05-21',
  '2026-05-26',
  '2026-05-28',
  '2026-06-01',
  '2026-06-03',
  // Correction (3)
  '2026-06-05',
  '2026-06-09',
  '2026-06-11',
] as const;

export const HOLDOUT_DAYS = ['2026-06-12'] as const;

export const TIER1_LEVELS = ['PDH', 'PDL', 'PDC', 'POC', 'VAH', 'VAL', 'IBH', 'IBL'] as const;

// RTH window in ET
export const RTH_START = { hour: 9, minute: 30 };
export const RTH_END   = { hour: 15, minute: 54 };
