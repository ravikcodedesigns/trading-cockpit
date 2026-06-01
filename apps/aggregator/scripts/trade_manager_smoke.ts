// TradeManager lifecycle smoke test.
//
// Walks an end-to-end scenario for each close path:
//   1. TP hit
//   2. SL hit
//   3. Opposite-direction signal exit (asymmetric rule)
//   4. RTH close-at-bell
// Cleans the db state at the end so the live aggregator is unaffected.

import { tradeManager } from '../src/trade-manager.js';
import { db } from '../src/db.js';

const sym = 'NQ';
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('  ❌ FAIL:', msg); process.exit(1); }
  console.log('  ✓', msg);
}

console.log('\n[scenario 1] open absorption LONG at 30000, TP hit at 30080');
tradeManager.openTrade({
  symbol: sym, signalId: 1, ruleId: 'absorption', pattern: null,
  direction: 'long', entry: 30000, openTs: Date.now(),
});
assert(tradeManager.getOpen(sym) !== null, 'trade is open');
let ev = tradeManager.onTick(sym, Date.now()+1000, 30050);  // mid-move, no close
assert(ev === null, 'no close on intermediate tick');
ev = tradeManager.onTick(sym, Date.now()+5000, 30080);     // TP hit
assert(ev !== null && ev.reason === 'TP_HIT' && ev.pnlPts === 80, 'TP_HIT close at +80');
assert(tradeManager.getOpen(sym) === null, 'trade is gone');

console.log('\n[scenario 2] open FLIP LONG at 30000, SL hit at 29945 (SL=55)');
tradeManager.openTrade({
  symbol: sym, signalId: 2, ruleId: 'clean-impulse', pattern: 'FLIP',
  direction: 'long', entry: 30000, openTs: Date.now(),
});
ev = tradeManager.onTick(sym, Date.now()+3000, 29945);
assert(ev !== null && ev.reason === 'SL_HIT' && ev.pnlPts === -55, 'SL_HIT close at -55');

console.log('\n[scenario 3] open EXPL LONG at 30000, then qualified SHORT signal arrives');
tradeManager.openTrade({
  symbol: sym, signalId: 3, ruleId: 'expl', pattern: null,
  direction: 'long', entry: 30000, openTs: Date.now(),
});
let should = tradeManager.shouldExitOnSignal(sym, 'short', /*qualified*/ true);
assert(should === true, 'LONG should exit on qualified opposite');
should = tradeManager.shouldExitOnSignal(sym, 'short', /*qualified*/ false);
assert(should === false, 'LONG should NOT exit on silenced opposite (asymmetric rule)');
should = tradeManager.shouldExitOnSignal(sym, 'long', true);
assert(should === false, 'LONG should NOT exit on same-direction signal');
ev = tradeManager.closeTrade(sym, 30025, Date.now()+10000, 'OPP_SIG_EXIT', 99);
assert(ev !== null && ev.reason === 'OPP_SIG_EXIT' && ev.pnlPts === 25, 'OPP_SIG_EXIT close at +25');

console.log('\n[scenario 4] open absorption SHORT at 30000, ANY opposite closes it (silenced)');
tradeManager.openTrade({
  symbol: sym, signalId: 4, ruleId: 'absorption', pattern: null,
  direction: 'short', entry: 30000, openTs: Date.now(),
});
should = tradeManager.shouldExitOnSignal(sym, 'long', /*qualified*/ false);
assert(should === true, 'SHORT exits even on SILENCED opposite (asymmetric rule)');
tradeManager.closeTrade(sym, 29980, Date.now()+5000, 'OPP_SIG_EXIT', 100);

console.log('\n[scenario 5] RTH close at bell on absorption LONG');
tradeManager.openTrade({
  symbol: sym, signalId: 5, ruleId: 'absorption', pattern: null,
  direction: 'long', entry: 30000, openTs: Date.now(),
});
ev = tradeManager.onRthClose(sym, 30015, Date.now()+ 4*3600_000);
assert(ev !== null && ev.reason === 'CLOSE_AT_BELL' && ev.pnlPts === 15, 'CLOSE_AT_BELL at +15');

console.log('\n[scenario 6] hydrate from DB (insert a stale row, expect dropped)');
db.v3.upsertOpenTrade({
  symbol: sym, signalId: 999, ruleId: 'absorption', pattern: null,
  direction: 'long', entry: 28000, tpPts: 80, slPts: 140,
  openTs: Date.now() - 24*3600_000,  // yesterday
});
// Construct a fresh TradeManager? We use the singleton — but we can simulate
// hydrate behavior by calling it directly. The current singleton's in-memory
// state may not be empty after prior scenarios, but stale row should be deleted.
tradeManager.hydrate();
const persisted = db.v3.getAllOpenTrades();
assert(!persisted.some(r => r.openTs < Date.now() - 12*3600_000), 'stale rows dropped on hydrate');

console.log('\nALL TradeManager SMOKE TESTS PASSED');
