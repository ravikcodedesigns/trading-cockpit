// One-shot Tradovate authentication test.
//
// Sends exactly ONE /auth/accesstokenrequest call and exits.
// Used to validate credentials and rate-limit state without risk of
// PM2 auto-restart blowing through the 5/hour quota.
//
// Run:  pnpm exec tsx scripts/test_auth_once.ts

import 'dotenv/config';

const username   = process.env.TRADOVATE_USERNAME;
const password   = process.env.TRADOVATE_PASSWORD;
const cid        = process.env.TRADOVATE_CID;
const secret     = process.env.TRADOVATE_SECRET;
const appId      = process.env.TRADOVATE_APP_ID ?? 'Sample App';
const appVersion = process.env.TRADOVATE_APP_VERSION ?? '1.0';
const deviceId   = process.env.TRADOVATE_DEVICE_ID;
const mode       = process.env.TRADER_MODE ?? 'demo';

const base = mode === 'live'
  ? 'https://live.tradovateapi.com/v1'
  : 'https://demo.tradovateapi.com/v1';

console.log(`[auth-test] mode=${mode}, endpoint=${base}/auth/accesstokenrequest`);
console.log(`[auth-test] username set: ${!!username}, password set: ${!!password}, cid: ${cid}, secret set: ${!!secret}, deviceId set: ${!!deviceId}`);
if (!username || !password || !cid || !secret || !deviceId) {
  console.error('[auth-test] MISSING credentials — aborting (deviceId is now required to mirror the working curl)');
  process.exit(2);
}

const body = {
  name:       username,
  password:   password,
  appId,
  appVersion,
  deviceId,
  cid:        parseInt(cid, 10),
  sec:        secret,
};

const t0 = Date.now();
fetch(`${base}/auth/accesstokenrequest`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
  .then(async (res) => {
    const dt = Date.now() - t0;
    const txt = await res.text();
    console.log(`[auth-test] HTTP ${res.status} in ${dt}ms`);
    let parsed: any;
    try { parsed = JSON.parse(txt); } catch { parsed = null; }

    if (parsed?.accessToken) {
      console.log('[auth-test] ✅ SUCCESS — authenticated');
      console.log(`  userId:           ${parsed.userId}`);
      console.log(`  name:             ${parsed.name}`);
      console.log(`  userStatus:       ${parsed.userStatus}`);
      console.log(`  hasLive:          ${parsed.hasLive}`);
      console.log(`  expirationTime:   ${parsed.expirationTime}`);
      console.log(`  token (first 24): ${String(parsed.accessToken).slice(0,24)}...`);
      process.exit(0);
    }

    if (parsed?.['p-message']) {
      console.log('[auth-test] ⚠️  Tradovate refused — challenge response:');
      console.log(`  message:  ${parsed['p-message']}`);
      console.log(`  p-time:   ${parsed['p-time']} (wait this long before next attempt)`);
      console.log(`  captcha:  ${parsed['p-captcha']}`);
      console.log(`  ticket?   ${parsed['p-ticket'] ? 'yes (truncated)' : 'no'}`);
      process.exit(3);
    }

    console.log('[auth-test] ❌ Unexpected response:');
    console.log(txt);
    process.exit(4);
  })
  .catch((err) => {
    console.error('[auth-test] ❌ Network/fetch error:', err.message);
    process.exit(5);
  });
