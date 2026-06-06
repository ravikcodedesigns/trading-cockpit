// One-shot test order — Market BUY 1 MNQ on demo account.
// Authenticated by user 2026-06-02 for visual chart confirmation.
import 'dotenv/config';
import { TradovateClient } from '../src/broker/tradovate.js';

const broker = new TradovateClient();

async function main() {
  console.log('[test-long] authenticating...');
  await broker.authenticate();

  console.log('[test-long] loading account...');
  await broker.loadAccount();
  console.log(`[test-long] account: id=${broker.account.id} name=${broker.account.name}`);

  // Front-month MNQ on 2026-06-02 = MNQM6 (June 2026 micro NQ).
  // Hardcoded because findContract filters status==='Active' but demo returns 'DefinitionChecked'.
  const contractName = 'MNQM6';
  console.log(`[test-long] contract: ${contractName} (hardcoded front-month)`);

  console.log('[test-long] submitting Market BUY 1...');
  const orderId = await broker.placeMarketOrder({
    contractName,
    action: 'Buy',
    qty: 1,
  });
  console.log(`[test-long] ✅ ORDER PLACED — orderId=${orderId}`);
  console.log(`[test-long]    contract=${contract.name}  action=Buy  qty=1  type=Market  account=${broker.account.name}`);

  // Brief grace period for the fill, then query order status
  await new Promise(r => setTimeout(r, 1500));
  process.exit(0);
}

main().catch(err => {
  console.error('[test-long] ❌ FAILED:', err.message ?? err);
  process.exit(1);
});
