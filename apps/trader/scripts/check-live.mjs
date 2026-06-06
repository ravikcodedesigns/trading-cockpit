const BASE = 'https://live.tradovateapi.com/v1';
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
console.log('=== LIVE positions ===');
console.log(JSON.stringify(await (await fetch(BASE + '/position/list', { headers: h })).json(), null, 2));
console.log('\n=== LIVE working orders ===');
const wo = await (await fetch(BASE + '/order/list', { headers: h })).json();
console.log(JSON.stringify(wo, null, 2));
