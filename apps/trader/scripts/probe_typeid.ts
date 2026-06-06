import 'dotenv/config';
import { TradovateClient } from '../src/broker/tradovate.js';
const broker = new TradovateClient();
await broker.authenticate();
await broker.loadAccount();

const acc = { accountSpec: broker.account.name, accountId: broker.account.id };
const baseParams = JSON.stringify({
  entryVersion: { orderQty: 1, orderType: 'Market', isAutomated: true },
  brackets: [{ qty: 1, profitTarget: '+80', stopLoss: '-55', trailingStop: false }],
});
for (const id of [1, 2, 3, 4, 5]) {
  const body = { ...acc, symbol: 'MNQM6', action: 'Buy', orderStrategyTypeId: id, params: baseParams };
  try {
    const res = await (broker as any).post('/orderStrategy/startOrderStrategy', body);
    const ok = res.orderStrategyId && !res.errorText;
    console.log(`typeId=${id}  →  ${JSON.stringify(res)}`);
    if (ok) {
      console.log(`>>> typeId=${id} WORKS — STOPPING`);
      break;
    }
  } catch (e: any) {
    console.log(`typeId=${id}  →  err: ${e.message?.split('\n')[0]}`);
  }
}
