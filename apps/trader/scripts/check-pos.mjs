import 'dotenv/config';
const BASE = 'https://demo.tradovateapi.com/v1';
const env = process.env;
const auth = await (await fetch(BASE + '/auth/accesstokenrequest', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: env.TRADOVATE_USERNAME, password: env.TRADOVATE_PASSWORD,
    appId: env.TRADOVATE_APP_ID, appVersion: env.TRADOVATE_APP_VERSION,
    deviceId: env.TRADOVATE_DEVICE_ID,
    cid: parseInt(env.TRADOVATE_CID), sec: env.TRADOVATE_SECRET,
  })
})).json();
const t = auth.accessToken;
const h = { Authorization: 'Bearer ' + t };

console.log('=== positions ===');
const pos = await (await fetch(BASE + '/position/list', { headers: h })).json();
console.log(JSON.stringify(pos, null, 2));

console.log('\n=== orders today (last 50) ===');
const orders = await (await fetch(BASE + '/order/items?ids=525611950337', { headers: h })).json();
console.log(JSON.stringify(orders, null, 2));

console.log('\n=== working orders ===');
const wo = await (await fetch(BASE + '/order/list', { headers: h })).json();
const working = (Array.isArray(wo) ? wo : []).filter(o => o.ordStatus && !['Filled','Canceled','Cancelled','Rejected','Expired'].includes(o.ordStatus));
console.log(JSON.stringify(working.slice(-20), null, 2));
