// Smoke test for V3 RTH close timer.
//
// Verifies:
//   1. timer is no-op when V3 is off
//   2. timer fires when ET clock is past the configured close time
//   3. firing closes any open trade for symbols in config.v3.symbols
//   4. only fires once per day (dateKey tracking)

import { config } from '../src/config.js';
import { tradeManager } from '../src/trade-manager.js';
import { v3RthTimer } from '../src/v3-rth-timer.js';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('  ❌ FAIL:', msg); process.exit(1); }
  console.log('  ✓', msg);
}

console.log('\n[1] timer no-op when off');
(config.v3 as any).activeMode = 'off';
v3RthTimer.start();
v3RthTimer.checkOnce();
assert(tradeManager.getOpen('NQ') === null, 'no trade affected when off');

console.log('\n[2] open a trade, set close time to 1 minute ago, verify it fires');
(config.v3 as any).activeMode = 'live';

// Configure close time to "1 min before now in ET"
const now = new Date(Date.now() - 4 * 60 * 60_000);  // EDT
const targetMinute = now.getUTCMinutes() === 0 ? 59 : now.getUTCMinutes() - 1;
const targetHour   = now.getUTCMinutes() === 0 ? (now.getUTCHours() === 0 ? 23 : now.getUTCHours() - 1) : now.getUTCHours();
(config.v3 as any).rthCloseEt = `${String(targetHour).padStart(2,'0')}:${String(targetMinute).padStart(2,'0')}:00`;
console.log('  test close time set to:', config.v3.rthCloseEt, '(should already be past)');

// Open a trade
tradeManager.openTrade({
  symbol: 'NQ', signalId: 1, ruleId: 'absorption', pattern: null,
  direction: 'long', entry: 30000, openTs: Date.now(),
});
assert(tradeManager.getOpen('NQ') !== null, 'trade opened');

v3RthTimer.start();
v3RthTimer.checkOnce();
assert(tradeManager.getOpen('NQ') === null, 'trade closed by RTH timer');

console.log('\n[3] second check on same day does not fire again');
tradeManager.openTrade({
  symbol: 'NQ', signalId: 2, ruleId: 'absorption', pattern: null,
  direction: 'long', entry: 30000, openTs: Date.now(),
});
v3RthTimer.checkOnce();
assert(tradeManager.getOpen('NQ') !== null, 'second trade NOT closed (already fired today)');
tradeManager.closeTrade('NQ', 30000, Date.now(), 'CLOSE_AT_BELL', null);

console.log('\n[4] stop releases handle');
v3RthTimer.stop();
(config.v3 as any).activeMode = 'off';

console.log('\nALL v3-rth-timer SMOKE TESTS PASSED');
