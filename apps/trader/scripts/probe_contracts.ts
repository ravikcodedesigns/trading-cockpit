import 'dotenv/config';
import { TradovateClient } from '../src/broker/tradovate.js';
const broker = new TradovateClient();
await broker.authenticate();
const raw = await (broker as any).get(`/contract/suggest?t=MNQ&l=10`);
console.log(JSON.stringify(raw, null, 2));
