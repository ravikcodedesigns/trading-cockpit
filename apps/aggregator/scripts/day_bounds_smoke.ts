// Smoke test for the refactored dayBoundsSeconds in Chart.tsx.
// (Re-implemented here as a copy since it's not exported. Confirms the
// session boundaries match the new tradingDayFor convention.)

function dayBoundsSeconds(tradingDay: string): { start: number; end: number } {
  const parts = tradingDay.split('-').map(Number);
  const y = parts[0]!, m = parts[1]!, d = parts[2]!;
  const probeNoon = new Date(Date.UTC(y, m - 1, d, 16, 0, 0));
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const weekday = dayFmt.format(probeNoon);
  const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
  const tsForEt = (yy: number, mm: number, dd: number, etHour: number): number => {
    const naive = new Date(Date.UTC(yy, mm - 1, dd, etHour + 4, 0, 0));
    const nyHour = parseInt(hourFmt.format(naive), 10);
    return naive.getTime() + (etHour - nyHour) * 60 * 60 * 1000;
  };
  const end = tsForEt(y, m, d, 16);
  const isMonLike = (weekday === 'Mon' || weekday === 'Sat' || weekday === 'Sun');
  const startHour = isMonLike ? 18 : 16;
  const priorDay = new Date(Date.UTC(y, m - 1, d - 1, 12, 0, 0));
  const start = tsForEt(priorDay.getUTCFullYear(), priorDay.getUTCMonth() + 1, priorDay.getUTCDate(), startHour);
  return { start: Math.floor(start / 1000), end: Math.floor(end / 1000) };
}

function fmtEt(secs: number): string {
  const d = new Date(secs * 1000);
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
}

let passed = 0, failed = 0;
function check(tradingDay: string, expStart: string, expEnd: string) {
  const { start, end } = dayBoundsSeconds(tradingDay);
  const gotStart = fmtEt(start);
  const gotEnd   = fmtEt(end);
  const okS = gotStart === expStart, okE = gotEnd === expEnd;
  if (okS && okE) { passed++; console.log(`  ✓ ${tradingDay}: [${gotStart}] → [${gotEnd}]`); }
  else { failed++; console.error(`  ❌ ${tradingDay}: got [${gotStart}] → [${gotEnd}], expected [${expStart}] → [${expEnd}]`); }
}

console.log('\nMonday session: Sun 18:00 → Mon 16:00 ET');
check('2026-06-01', 'Sun, 05/31, 18:00', 'Mon, 06/01, 16:00');

console.log('\nTuesday session: Mon 16:00 → Tue 16:00 ET');
check('2026-06-02', 'Mon, 06/01, 16:00', 'Tue, 06/02, 16:00');

console.log('\nFriday session: Thu 16:00 → Fri 16:00 ET');
check('2026-06-05', 'Thu, 06/04, 16:00', 'Fri, 06/05, 16:00');

console.log('\nMonday after weekend: Sun 18:00 → Mon 16:00 ET');
check('2026-06-08', 'Sun, 06/07, 18:00', 'Mon, 06/08, 16:00');

console.log('\nDST winter (Dec 2026, EST)');
check('2026-12-02', 'Tue, 12/01, 16:00', 'Wed, 12/02, 16:00');
check('2026-12-07', 'Sun, 12/06, 18:00', 'Mon, 12/07, 16:00');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('ALL dayBoundsSeconds SMOKE TESTS PASSED');
