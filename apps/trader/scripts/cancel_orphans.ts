import 'dotenv/config';
import { TradovateClient } from '../src/broker/tradovate.js';
const broker = new TradovateClient();
await broker.authenticate();
await broker.loadAccount();

const orphanIds = [525611950066, 525611950067];
for (const id of orphanIds) {
  const item = await (broker as any).get(`/order/item?id=${id}`);
  console.log(`order ${id} status=${item?.ordStatus ?? '?'}`);
  if (item?.ordStatus === 'Working') {
    const res = await (broker as any).post('/order/cancelorder', { orderId: id });
    console.log(`  → cancel response:`, JSON.stringify(res));
  } else {
    console.log(`  → not Working, skipping`);
  }
}
