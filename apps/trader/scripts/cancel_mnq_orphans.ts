// One-shot: cancel any Working orders for MNQM6 (contractId 4327110).
// Leaves other contracts (e.g. 4327108) alone.
import 'dotenv/config';
import { TradovateClient } from '../src/broker/tradovate.js';
const broker = new TradovateClient();
await broker.authenticate();
await broker.loadAccount();
const orders = (await (broker as any).get('/order/list') as any[])
  .filter(o => o.ordStatus === 'Working' && o.contractId === 4327110);
console.log(`Found ${orders.length} working MNQM6 orders`);
for (const o of orders) {
  try {
    await broker.cancelOrder(o.id);
    console.log(`  ✅ cancelled ${o.id} (${o.action} ${o.orderType})`);
  } catch (e:any) {
    console.log(`  ❌ ${o.id}: ${e.message}`);
  }
}
