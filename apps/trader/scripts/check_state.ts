import 'dotenv/config';
import { TradovateClient } from '../src/broker/tradovate.js';
const broker = new TradovateClient();
await broker.authenticate();
await broker.loadAccount();
const positions = (await (broker as any).get('/position/list') as any[]).filter(p => p.netPos !== 0);
const orders = (await (broker as any).get('/order/list') as any[]).filter(o => o.ordStatus === 'Working');
console.log('Open positions:', positions.length, JSON.stringify(positions.map(p => ({contractId:p.contractId, netPos:p.netPos, netPrice:p.netPrice}))));
console.log('Working orders:', orders.length, JSON.stringify(orders.map(o => ({id:o.id, action:o.action, contractId:o.contractId, type:o.orderType, price:o.price, stopPrice:o.stopPrice}))));
