// Long-running test harness for the position-watcher.
//
// Usage:
//   pnpm exec tsx scripts/run_position_watcher.ts
//
// Then manually open + flatten a position in the Tradovate app. The watcher
// should detect the flat transition and cancel any orphan TP/SL orders within
// ~1.5s (debounce delay).
//
// Ctrl-C to stop.

import 'dotenv/config';
import { TradovateClient } from '../src/broker/tradovate.js';
import { startPositionWatcher } from '../src/position-watcher.js';

const broker = new TradovateClient();

async function main() {
  console.log('[watcher-test] authenticating + loading account...');
  await broker.authenticate();
  await broker.loadAccount();
  console.log(`[watcher-test] account: id=${broker.account.id} name=${broker.account.name}`);

  console.log('[watcher-test] connecting WebSocket...');
  await broker.connectWebSocket();
  console.log('[watcher-test] WS connected + authorized + subscribed to user updates');

  // Echo every position event so we can see what the broker is delivering
  broker.onPositionUpdate((pos) => {
    const tag = pos.netPos === 0 ? '➖ FLAT' : pos.netPos > 0 ? `🟢 LONG ${pos.netPos}` : `🔴 SHORT ${pos.netPos}`;
    console.log(`[pos-event] contractId=${pos.contractId} ${tag} @ ${pos.netPrice ?? '—'}`);
  });

  // Start the watcher
  const stop = startPositionWatcher(broker);

  console.log('\n══ Watcher is running ══');
  console.log('  Open a bracket on Tradovate (or via place_test_oso.ts), then MANUALLY flatten the position.');
  console.log('  Within ~1.5s the watcher should cancel any orphan TP/SL orders.');
  console.log('  Ctrl-C to stop.\n');

  // Wire clean shutdown
  process.on('SIGINT', () => {
    console.log('\n[watcher-test] SIGINT — stopping watcher');
    stop();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[watcher-test] ❌ FAILED:', err.message ?? err);
  process.exit(1);
});
