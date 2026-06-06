// One-shot bracket order — Market BUY 1 MNQM6 + OCO exit pair (TP+80, SL-55).
// User-authorized 2026-06-02 to see bracket lines on the demo chart.
import 'dotenv/config';
import { TradovateClient } from '../src/broker/tradovate.js';

const broker = new TradovateClient();
const CONTRACT = 'MNQM6';
const QTY      = 1;
const TP_PTS   = 80;
const SL_PTS   = 55;

async function postRaw(path: string, body: any) {
  return await (broker as any).post(path, body);
}
async function getRaw(path: string) {
  return await (broker as any).get(path);
}

async function main() {
  console.log('[bracket] authenticating + loading account...');
  await broker.authenticate();
  await broker.loadAccount();
  console.log(`[bracket] account: id=${broker.account.id} name=${broker.account.name}`);

  // ── Step 1: market entry ───────────────────────────────────────────
  console.log(`[bracket] placing parent Market BUY ${QTY} ${CONTRACT}...`);
  const entryId = await broker.placeMarketOrder({ contractName: CONTRACT, action: 'Buy', qty: QTY });
  console.log(`[bracket] parent orderId=${entryId}`);

  // ── Step 2: wait for fill (poll up to 5s) ───────────────────────────
  let fill: any = null;
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 200));
    const fills = await getRaw('/fill/list') as any[];
    fill = fills.find(f => f.orderId === entryId);
    if (fill) break;
  }
  if (!fill) {
    // Check order status — likely rejected
    const ord = await getRaw(`/order/item?id=${entryId}`);
    console.log(`[bracket] no fill within 5s — order:`, JSON.stringify(ord));
    if (ord?.ordStatus !== 'Filled') {
      const reports = await getRaw('/commandReport/list') as any[];
      const rej = reports.find(r => r.commandId === entryId && r.commandStatus === 'ExecutionRejected');
      if (rej) console.log(`[bracket] ❌ REJECTED: ${rej.rejectReason} — ${rej.text}`);
    }
    process.exit(2);
  }
  const entryPx = fill.price;
  console.log(`[bracket] ✅ filled @ ${entryPx} (fillId=${fill.id})`);

  // ── Step 3: place OCO exit pair ─────────────────────────────────────
  const tpPx = entryPx + TP_PTS;
  const slPx = entryPx - SL_PTS;
  console.log(`[bracket] placing OCO exit pair → TP Limit SELL @ ${tpPx} | SL Stop SELL @ ${slPx}`);

  const ocoRes = await postRaw('/order/placeOCO', {
    accountSpec:  broker.account.name,
    accountId:    broker.account.id,
    action:       'Sell',
    symbol:       CONTRACT,
    orderQty:     QTY,
    orderType:    'Limit',
    price:        tpPx,
    timeInForce:  'GTC',
    isAutomated:  true,
    other: {
      action:      'Sell',
      orderType:   'Stop',
      stopPrice:   slPx,
      timeInForce: 'GTC',
      isAutomated: true,
    },
  });

  const tpId = ocoRes.orderId ?? ocoRes.id;
  const slId = ocoRes.oso2Id ?? ocoRes.oco2Id ?? ocoRes.otherOrderId ?? null;
  console.log(`[bracket] ✅ OCO placed — primary (TP) orderId=${tpId}, sibling (SL) orderId=${slId ?? 'unknown — check /order/list'}`);
  console.log(`[bracket] OCO raw response:`, JSON.stringify(ocoRes));

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('\n══ Summary ══');
  console.log(`  Entry:  BUY 1 ${CONTRACT} @ ${entryPx}   (orderId ${entryId})`);
  console.log(`  TP:     SELL 1 Limit @ ${tpPx}   (orderId ${tpId})`);
  console.log(`  SL:     SELL 1 Stop  @ ${slPx}   (orderId ${slId ?? '?'})`);
  console.log(`  Risk:   ${SL_PTS} pts = $${(SL_PTS * 2).toFixed(2)} (MNQ @ $2/pt)`);
  console.log(`  Reward: ${TP_PTS} pts = $${(TP_PTS * 2).toFixed(2)}`);
  console.log(`  R:R:    1 : ${(TP_PTS / SL_PTS).toFixed(2)}`);
  process.exit(0);
}

main().catch(err => {
  console.error('[bracket] ❌ FAILED:', err.message ?? err);
  process.exit(1);
});
