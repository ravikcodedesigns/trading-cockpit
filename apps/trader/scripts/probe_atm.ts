import 'dotenv/config';
import { TradovateClient } from '../src/broker/tradovate.js';
const broker = new TradovateClient();
await broker.authenticate();
await broker.loadAccount();

// 1) Look for ATM-related endpoints
console.log('── ATM endpoint discovery ──');
for (const ep of [
  '/orderStrategy/list',
  '/orderStrategyType/list',
  '/contractMaturity/find?text=MNQM6',
]) {
  try {
    const r = await (broker as any).get(ep);
    console.log(`✓ ${ep}: ${JSON.stringify(r).slice(0, 400)}`);
  } catch (e: any) {
    console.log(`✗ ${ep}: ${e.message?.split('\n')[0]}`);
  }
}

// 2) Retry typeId=1 (Bracket) now that ATM is on
console.log('\n── Retry typeId=1 (Bracket) ──');
const body1 = {
  accountSpec: broker.account.name,
  accountId:   broker.account.id,
  symbol:      'MNQM6',
  action:      'Buy',
  orderStrategyTypeId: 1,
  params: JSON.stringify({
    entryVersion: { orderQty: 1, orderType: 'Market', isAutomated: true },
    brackets: [{ qty: 1, profitTarget: '+80', stopLoss: '-55', trailingStop: false }],
  }),
};
const res1 = await (broker as any).post('/orderStrategy/startOrderStrategy', body1);
console.log('typeId=1 →', JSON.stringify(res1));
