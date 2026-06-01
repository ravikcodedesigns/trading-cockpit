// Smoke test for the refactored tradingDayFor() in @trading/contracts.
//
// Verifies the new 16:00 ET session-end boundary convention:
//   - Mon's session: Sun 18:00 → Mon 16:00 ET
//   - Tue's session: Mon 16:00 → Tue 16:00 ET
//   - Weekend gap (Fri 16:00 → Sun 18:00): all map to next Mon
//   - DST handling

import { tradingDayFor } from '@trading/contracts';

let passed = 0, failed = 0;
function check(label: string, ts: number, expected: string) {
  const got = tradingDayFor(ts);
  const ok = got === expected;
  if (ok) { passed++; console.log(`  ✓ ${label} → ${got}`); }
  else    { failed++; console.error(`  ❌ ${label} → ${got}  (expected ${expected})`); }
}

// Helper: build a UTC ms for the given ET wall time on date (yyyy, mm, dd)
// Assumes EDT (UTC-4) for May/Jun 2026.
function et(y: number, m: number, d: number, h: number, min = 0): number {
  return Date.UTC(y, m - 1, d, h + 4, min, 0); // +4 because EDT
}

console.log('\n── Mon 6/1 session (Sun 18:00 → Mon 16:00 ET) ──');
check('Sun 5/31 17:59 ET (weekend gap)', et(2026,5,31,17,59), '2026-06-01');
check('Sun 5/31 18:00 ET (Sun reopen)',  et(2026,5,31,18,0),  '2026-06-01');
check('Sun 5/31 23:00 ET',               et(2026,5,31,23,0),  '2026-06-01');
check('Mon 6/1 03:00 ET (pre-RTH)',      et(2026,6,1,3,0),    '2026-06-01');
check('Mon 6/1 09:30 ET (RTH open)',     et(2026,6,1,9,30),   '2026-06-01');
check('Mon 6/1 14:00 ET',                et(2026,6,1,14,0),   '2026-06-01');
check('Mon 6/1 15:59 ET',                et(2026,6,1,15,59),  '2026-06-01');

console.log('\n── Tue 6/2 session (Mon 16:00 → Tue 16:00 ET) ──');
check('Mon 6/1 16:00 ET (boundary)',     et(2026,6,1,16,0),   '2026-06-02');
check('Mon 6/1 22:00 ET',                et(2026,6,1,22,0),   '2026-06-02');
check('Tue 6/2 09:30 ET',                et(2026,6,2,9,30),   '2026-06-02');
check('Tue 6/2 15:59 ET',                et(2026,6,2,15,59),  '2026-06-02');

console.log('\n── Mid-week sessions ──');
check('Wed 6/3 10:00 ET',                et(2026,6,3,10,0),   '2026-06-03');
check('Wed 6/3 16:00 ET → Thu',          et(2026,6,3,16,0),   '2026-06-04');
check('Thu 6/4 13:00 ET',                et(2026,6,4,13,0),   '2026-06-04');
check('Thu 6/4 16:01 ET → Fri',          et(2026,6,4,16,1),   '2026-06-05');

console.log('\n── Weekend gap (Fri 16:00 → Sun 18:00) ──');
check('Fri 6/5 15:59 ET',                et(2026,6,5,15,59),  '2026-06-05');
check('Fri 6/5 16:00 ET → next Mon',     et(2026,6,5,16,0),   '2026-06-08');
check('Fri 6/5 23:00 ET',                et(2026,6,5,23,0),   '2026-06-08');
check('Sat 6/6 12:00 ET',                et(2026,6,6,12,0),   '2026-06-08');
check('Sun 6/7 17:59 ET',                et(2026,6,7,17,59),  '2026-06-08');
check('Sun 6/7 18:00 ET → Mon 6/8',      et(2026,6,7,18,0),   '2026-06-08');

console.log('\n── DST sanity check (EST winter, Dec 2026) ──');
// Dec dates are EST (UTC-5), not EDT. Helper builds with +4 → off by 1 hour.
// Build directly in UTC for EST.
const estEt = (y: number, m: number, d: number, h: number, min = 0): number =>
  Date.UTC(y, m - 1, d, h + 5, min, 0); // +5 for EST
check('Dec 1 (Tue) 15:59 EST',           estEt(2026,12,1,15,59), '2026-12-01');
check('Dec 1 (Tue) 16:00 EST → Wed',     estEt(2026,12,1,16,0),  '2026-12-02');
check('Dec 6 (Sun) 18:00 EST → Mon 12/7', estEt(2026,12,6,18,0),  '2026-12-07');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('ALL tradingDayFor SMOKE TESTS PASSED');
