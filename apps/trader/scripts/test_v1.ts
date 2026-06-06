import 'dotenv/config';
import { TradovateClient } from '../src/broker/tradovate.js';
const broker = new TradovateClient();
await broker.authenticate();
await broker.loadAccount();
const body = {
  accountSpec: broker.account.name,
  accountId: broker.account.id,
  symbol: 'MNQM6',
  action: 'Buy',
  orderStrategyTypeId: 2,
  params: JSON.stringify({
    entryVersion: { orderQty: 1, orderType: 'Market', isAutomated: true },
    brackets: [{ qty: 1, profitTarget: '+80', stopLoss: '-55', trailingStop: false }],
  }),
};
const res = await (broker as any).post('/orderStrategy/startOrderStrategy', body);
console.log(JSON.stringify(res, null, 2));
