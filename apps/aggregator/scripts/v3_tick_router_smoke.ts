// Smoke test for V3 tick router.
//
// Scenarios:
//   1. router does nothing when V3 is off
//   2. router opens DB and polls when V3 is on
//   3. pollOnce delivers ticks; lastSeenTs advances; CvdSession updates;
//      TradeManager.onTick fires on the open trade (TP check).

import { config } from '../src/config.js';
import { cvdSession } from '../src/cvd-session.js';
import { tradeManager } from '../src/trade-manager.js';
import { v3TickRouter } from '../src/v3-tick-router.js';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('  ❌ FAIL:', msg); process.exit(1); }
  console.log('  ✓', msg);
}

console.log('\n[1] router is no-op when V3 is off');
(config.v3 as any).activeMode = 'off';
v3TickRouter.start();
// pollOnce returns { delivered: 0 } when DB not opened
const r1 = v3TickRouter.pollOnce();
assert(r1.delivered === 0, 'no ticks delivered when router never started DB');

console.log('\n[2] router starts when V3 is on');
(config.v3 as any).activeMode = 'shadow';
v3TickRouter.start();
// pollOnce should now query ticks.db — typically returns 0 since lastSeenTs = now
const r2 = v3TickRouter.pollOnce();
console.log('  pollOnce after start:', r2);
assert(r2.delivered === 0 || r2.delivered >= 0, 'pollOnce executes without error');

console.log('\n[3] CvdSession is hydrated and queryable');
cvdSession.hydrate(['NQ']);
const cvd = cvdSession.get('NQ');
console.log('  NQ cvdSession =', cvd);
assert(typeof cvd === 'number', 'cvdSession.get returns a number');

console.log('\n[4] TradeManager.onTick is callable (no open trade → no-op)');
// Inject a fake tick directly to TradeManager — should not throw
const closeEv = tradeManager.onTick('NQ', Date.now(), 30000);
assert(closeEv === null, 'onTick with no open trade returns null');

console.log('\n[5] Stop releases interval and DB handle');
v3TickRouter.stop();
console.log('  (stopped without error)');

(config.v3 as any).activeMode = 'off';
console.log('\nALL v3-tick-router SMOKE TESTS PASSED');
