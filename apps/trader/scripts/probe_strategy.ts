import 'dotenv/config';
import { TradovateClient } from '../src/broker/tradovate.js';
const broker = new TradovateClient();
await broker.authenticate();
for (const ep of [
  '/orderStrategyType/list',
  '/orderStrategyTypeSchema/list',
  '/orderStrategyType/find?text=bracket',
]) {
  try {
    const r = await (broker as any).get(ep);
    console.log(`\n=== ${ep} ===`);
    console.log(JSON.stringify(r, null, 2));
  } catch (e: any) {
    console.log(`(${ep} → ${e.message?.split('\n')[0]})`);
  }
}
