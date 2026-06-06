import 'dotenv/config';
import { TradovateClient } from '../src/broker/tradovate.js';
const broker = new TradovateClient();
await broker.authenticate();
const orderId = 525611950004;
// Try a few endpoints that may carry rejection reason
for (const ep of ['/executionReport/list','/commandReport/list','/orderVersion/list']) {
  try {
    const r = await (broker as any).get(ep) as any[];
    const filt = r.filter(x => x.orderId === orderId || x.commandId === orderId);
    if (filt.length) {
      console.log(`\n=== ${ep} ===`);
      console.log(JSON.stringify(filt, null, 2));
    }
  } catch (e: any) {
    console.log(`(${ep} → ${e.message?.split('\n')[0]})`);
  }
}
