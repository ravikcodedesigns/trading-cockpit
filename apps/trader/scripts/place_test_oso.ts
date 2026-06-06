// Atomic bracket via /order/placeoso — parent Market BUY + TP Limit SELL + SL Stop SELL,
// all in ONE call. Replaces the previous 2-step placeOrder→placeOCO pattern.
//
// Bracket prices are ABSOLUTE in placeoso (not offsets from fill). For a Market parent we
// estimate the entry from the latest live tick (ticks.db — NQ ≈ MNQ within 1 tick), then
// compute TP = estimate+TP_PTS and SL = estimate-SL_PTS. If actual fill differs from the
// estimate, brackets will be slightly displaced — but the position-watcher (built next)
// catches any orphans regardless.
//
// Spec ref: components/schemas/PlaceOSO @ https://api.tradovate.com/spec.json

import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'node:path';
import { TradovateClient } from '../src/broker/tradovate.js';

const broker   = new TradovateClient();
const CONTRACT = 'MNQM6';
const QTY      = 1;
const TP_PTS   = 80;
const SL_PTS   = 55;

function latestNQPrice(): number {
  const dbPath = path.resolve(process.cwd(), '../../data/ticks.db');
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare(`SELECT price FROM trades WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`).get() as { price: number } | undefined;
  db.close();
  if (!row) throw new Error('No NQ ticks available — is the tick-store running?');
  return row.price;
}

async function main() {
  console.log('[oso] authenticating + loading account...');
  await broker.authenticate();
  await broker.loadAccount();
  console.log(`[oso] account: id=${broker.account.id} name=${broker.account.name}`);

  const estimate = latestNQPrice();
  // Round to 0.25 tick (MNQ tick size)
  const tpPx = Math.round((estimate + TP_PTS) * 4) / 4;
  const slPx = Math.round((estimate - SL_PTS) * 4) / 4;
  console.log(`[oso] live NQ estimate: ${estimate}  →  TP=${tpPx}  SL=${slPx}  (R:R = 1:${(TP_PTS/SL_PTS).toFixed(2)})`);

  const body = {
    accountSpec: broker.account.name,
    accountId:   broker.account.id,
    action:      'Buy',
    symbol:      CONTRACT,
    orderQty:    QTY,
    orderType:   'Market',
    timeInForce: 'Day',
    isAutomated: true,
    bracket1: {
      action:      'Sell',
      orderType:   'Limit',
      price:       tpPx,
      timeInForce: 'GTC',
    },
    bracket2: {
      action:      'Sell',
      orderType:   'Stop',
      stopPrice:   slPx,
      timeInForce: 'GTC',
    },
  };

  console.log('[oso] POST /order/placeoso ...');
  const res = await (broker as any).post('/order/placeoso', body) as {
    orderId?: number; oso1Id?: number; oso2Id?: number;
    failureReason?: string; failureText?: string;
  };

  if (res.failureReason || res.failureText) {
    console.log(`[oso] ❌ Tradovate rejected: ${res.failureReason ?? '?'} — ${res.failureText ?? ''}`);
    console.log('[oso] raw:', JSON.stringify(res));
    process.exit(2);
  }

  console.log(`[oso] ✅ accepted — parent=${res.orderId}  bracket1(TP)=${res.oso1Id}  bracket2(SL)=${res.oso2Id}`);

  // Poll briefly to capture fill + bracket placement
  await new Promise(r => setTimeout(r, 1500));
  const parent  = await (broker as any).get(`/order/item?id=${res.orderId}`);
  const tpOrd   = await (broker as any).get(`/order/item?id=${res.oso1Id}`);
  const slOrd   = await (broker as any).get(`/order/item?id=${res.oso2Id}`);
  const fills   = (await (broker as any).get('/fill/list') as any[]).filter(f => f.orderId === res.orderId);
  const posList = (await (broker as any).get('/position/list') as any[]).filter(p => p.netPos !== 0);

  console.log(`\n══ Status ══`);
  console.log(`  parent(${res.orderId})   : ${parent.ordStatus}  ${fills.length ? `→ filled @ ${fills[0].price}` : ''}`);
  console.log(`  TP    (${res.oso1Id})   : ${tpOrd.ordStatus}    Limit @ ${tpPx}`);
  console.log(`  SL    (${res.oso2Id})   : ${slOrd.ordStatus}    Stop  @ ${slPx}`);
  if (posList.length) {
    for (const p of posList) console.log(`  position: contractId=${p.contractId} netPos=${p.netPos} netPrice=${p.netPrice}`);
  } else {
    console.log(`  position: flat`);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('[oso] ❌ FAILED:', err.message ?? err);
  process.exit(1);
});
