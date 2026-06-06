import 'dotenv/config';
import { TradovateClient } from '../src/broker/tradovate.js';
const broker = new TradovateClient();
await broker.authenticate();
const orderId = 525611950016;
const order = await (broker as any).get(`/order/item?id=${orderId}`);
console.log('ORDER:', JSON.stringify(order, null, 2));
// Fills tied to this order
const fills = await (broker as any).get(`/fill/list`);
const relevant = (fills as any[]).filter(f => f.orderId === orderId);
console.log('FILLS:', JSON.stringify(relevant, null, 2));
// Current position
const positions = await (broker as any).get(`/position/list`);
console.log('POSITIONS:', JSON.stringify(positions, null, 2));
