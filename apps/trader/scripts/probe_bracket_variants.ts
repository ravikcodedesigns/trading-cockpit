// Try various bracket payloads to discover which schema Tradovate accepts.
// NOTE: each successful variant FIRES A REAL DEMO ORDER. We dry-run via a guard.
import 'dotenv/config';
import { TradovateClient } from '../src/broker/tradovate.js';
const broker = new TradovateClient();
await broker.authenticate();
await broker.loadAccount();

const DRY = process.argv.includes('--dry');
console.log(`DRY=${DRY} (use --dry to validate payloads without firing)`);

const acc = { accountSpec: broker.account.name, accountId: broker.account.id };

const variants: Array<{name: string; endpoint: string; body: any}> = [
  // V1 — startOrderStrategy with isAutomated in entryVersion
  {
    name: 'V1: startOrderStrategy + isAutomated in entry',
    endpoint: '/orderStrategy/startOrderStrategy',
    body: {
      ...acc,
      symbol: 'MNQM6',
      action: 'Buy',
      orderStrategyTypeId: 2,
      params: JSON.stringify({
        entryVersion: { orderQty: 1, orderType: 'Market', isAutomated: true },
        brackets: [{ qty: 1, profitTarget: '+80', stopLoss: '-55', trailingStop: false }],
      }),
    },
  },
  // V2 — startOrderStrategy with params as OBJECT (not string)
  {
    name: 'V2: startOrderStrategy + params as object',
    endpoint: '/orderStrategy/startOrderStrategy',
    body: {
      ...acc,
      symbol: 'MNQM6',
      action: 'Buy',
      orderStrategyTypeId: 2,
      params: {
        entryVersion: { orderQty: 1, orderType: 'Market', isAutomated: true },
        brackets: [{ qty: 1, profitTarget: '+80', stopLoss: '-55', trailingStop: false }],
      },
    },
  },
  // V3 — placeOSO: explicit parent + bracket1 + bracket2
  {
    name: 'V3: placeOSO with bracket1+bracket2',
    endpoint: '/order/placeOSO',
    body: {
      ...acc,
      action: 'Buy',
      symbol: 'MNQM6',
      orderQty: 1,
      orderType: 'Market',
      timeInForce: 'Day',
      isAutomated: true,
      bracket1: {
        action: 'Sell',
        orderType: 'Limit',
        price: 99999,    // placeholder; we'd compute from entry
        timeInForce: 'GTC',
        isAutomated: true,
      },
      bracket2: {
        action: 'Sell',
        orderType: 'Stop',
        stopPrice: 1,    // placeholder
        timeInForce: 'GTC',
        isAutomated: true,
      },
    },
  },
];

for (const v of variants) {
  console.log(`\n────────── ${v.name} ──────────`);
  if (DRY) {
    console.log(`(dry) POST ${v.endpoint}`);
    console.log(JSON.stringify(v.body, null, 2));
    continue;
  }
  try {
    const res = await (broker as any).post(v.endpoint, v.body);
    console.log(`✅ POST ${v.endpoint} →`, JSON.stringify(res));
    if (res.orderStrategyId || (res.orderId && !res.errorText)) {
      console.log(`>>> THIS VARIANT WORKS — orderStrategyId=${res.orderStrategyId ?? '(orderId only)'}`);
      console.log(`>>> STOPPING here so we don't fire more orders.`);
      break;
    }
  } catch (e: any) {
    console.log(`❌ POST ${v.endpoint} → ${e.message?.split('\n')[0]}`);
  }
}
