// One-shot bracket-strategy order using Tradovate's native /orderStrategy/startOrderStrategy.
// orderStrategyTypeId=2 = Bracket. Tradovate manages the full lifecycle:
//   - Auto-places TP limit + SL stop when parent fills
//   - TP fires → SL canceled (OCO)
//   - SL fires → TP canceled (OCO)
//   - Position flattened by ANY means → orphan brackets auto-canceled
//
// This replaces the manual placeOrder + placeOCO pattern in place_test_bracket.ts.

import 'dotenv/config';
import { TradovateClient } from '../src/broker/tradovate.js';

const broker = new TradovateClient();
const CONTRACT = 'MNQM6';
const QTY      = 1;
const TP_PTS   = 80;
const SL_PTS   = 55;
const ACTION   = 'Buy';  // Long

async function postRaw(path: string, body: any) {
  return await (broker as any).post(path, body);
}
async function getRaw(path: string) {
  return await (broker as any).get(path);
}

async function main() {
  console.log('[bracket-strategy] authenticating + loading account...');
  await broker.authenticate();
  await broker.loadAccount();
  console.log(`[bracket-strategy] account: id=${broker.account.id} name=${broker.account.name}`);

  // Tradovate's bracket strategy params (stringified JSON in the `params` field):
  //   entryVersion: the parent order spec
  //   brackets[]:   exit pair specs; profitTarget/stopLoss are signed price offsets
  //                 ("+80" = +80 points from entry fill, "-55" = -55 points)
  const params = {
    entryVersion: {
      orderQty:  QTY,
      orderType: 'Market',
    },
    brackets: [{
      qty:           QTY,
      profitTarget: `+${TP_PTS}`,
      stopLoss:     `-${SL_PTS}`,
      trailingStop:  false,
    }],
  };

  const body = {
    accountSpec:          broker.account.name,
    accountId:            broker.account.id,
    symbol:               CONTRACT,
    action:               ACTION,
    orderStrategyTypeId:  2,  // Bracket
    params:               JSON.stringify(params),
  };

  console.log(`[bracket-strategy] starting bracket strategy: ${ACTION} ${QTY} ${CONTRACT}  TP=+${TP_PTS}pts  SL=-${SL_PTS}pts`);
  console.log('[bracket-strategy] payload:', JSON.stringify(body, null, 2));

  const res = await postRaw('/orderStrategy/startOrderStrategy', body);
  console.log('[bracket-strategy] response:', JSON.stringify(res, null, 2));

  if (res.errorText || res.failureReason) {
    console.log('[bracket-strategy] ❌ FAILED:', res.errorText ?? res.failureReason);
    process.exit(2);
  }

  const strategyId = res.orderStrategyId ?? res.id;
  console.log(`[bracket-strategy] ✅ strategy started — orderStrategyId=${strategyId}`);

  // Poll to inspect the children
  await new Promise(r => setTimeout(r, 1500));
  const allOrders = await getRaw('/order/list') as any[];
  const recent = allOrders
    .filter(o => o.timestamp && Date.now() - new Date(o.timestamp).getTime() < 10_000)
    .sort((a, b) => a.id - b.id);
  console.log(`\n[bracket-strategy] recent orders (last 10s):`);
  for (const o of recent) {
    console.log(`  id=${o.id} status=${o.ordStatus} action=${o.action} type=${o.orderType ?? '?'} ` +
                `qty=${o.orderQty ?? '?'} price=${o.price ?? o.stopPrice ?? '?'} contractId=${o.contractId}`);
  }

  const fills = await getRaw('/fill/list') as any[];
  const myFills = fills.filter(f => Date.now() - new Date(f.timestamp).getTime() < 10_000);
  console.log(`\n[bracket-strategy] recent fills:`);
  for (const f of myFills) console.log(`  fillId=${f.id} orderId=${f.orderId} price=${f.price} qty=${f.qty}`);

  const positions = await getRaw('/position/list') as any[];
  console.log(`\n[bracket-strategy] positions:`);
  for (const p of positions) {
    if (p.netPos !== 0) console.log(`  contractId=${p.contractId} netPos=${p.netPos} netPrice=${p.netPrice}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('[bracket-strategy] ❌ FAILED:', err.message ?? err);
  process.exit(1);
});
