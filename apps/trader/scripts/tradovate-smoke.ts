// Standalone Tradovate connectivity smoke test.
// Runs: auth → account list → contract lookup for MNQ. No orders placed.
// Usage: cd apps/trader && pnpm exec tsx scripts/tradovate-smoke.ts

import 'dotenv/config';
import { config } from '../src/config.js';

const BASE = config.mode === 'live'
  ? 'https://live.tradovateapi.com/v1'
  : 'https://demo.tradovateapi.com/v1';

async function post(path: string, body: unknown, token?: string): Promise<any> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, body: json };
}
async function get(path: string, token: string): Promise<any> {
  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, body: json };
}

async function main() {
  console.log(`mode=${config.mode}  base=${BASE}`);
  console.log(`username=${config.tradovate.username}  cid=${config.tradovate.cid}\n`);

  // 1) Auth
  console.log('── 1. POST /auth/accesstokenrequest ──');
  const auth = await post('/auth/accesstokenrequest', {
    name:       config.tradovate.username,
    password:   config.tradovate.password,
    appId:      config.tradovate.appId,
    appVersion: config.tradovate.appVersion,
    deviceId:   config.tradovate.deviceId,
    cid:        config.tradovate.cid,
    sec:        config.tradovate.secret,
  });
  console.log(`status=${auth.status} ok=${auth.ok}`);
  if (!auth.ok || !auth.body.accessToken) {
    console.log('AUTH FAILED:', JSON.stringify(auth.body, null, 2));
    process.exit(1);
  }
  const token = auth.body.accessToken as string;
  console.log(`✓ authed userId=${auth.body.userId} name=${auth.body.name} expirationTime=${auth.body.expirationTime}\n`);

  // 2) Account list
  console.log('── 2. GET /account/list ──');
  const accts = await get('/account/list', token);
  console.log(`status=${accts.status} ok=${accts.ok}`);
  if (!accts.ok) { console.log('FAIL:', JSON.stringify(accts.body, null, 2)); process.exit(1); }
  for (const a of accts.body) {
    console.log(`  id=${a.id} name=${a.name} type=${a.accountType} active=${a.active}`);
  }
  console.log();

  // 3) Contract lookup — MNQ + MES
  for (const root of ['MNQ', 'MES', 'MNQM6']) {
    console.log(`── 3.${root}. GET /contract/suggest?t=${root}&l=10 ──`);
    const sug = await get(`/contract/suggest?t=${encodeURIComponent(root)}&l=10`, token);
    console.log(`status=${sug.status} ok=${sug.ok}`);
    if (!sug.ok) { console.log('  FAIL:', JSON.stringify(sug.body, null, 2)); continue; }
    if (!Array.isArray(sug.body)) { console.log('  Unexpected:', JSON.stringify(sug.body)); continue; }
    if (sug.body.length === 0) { console.log('  (empty result)'); continue; }
    for (const c of sug.body) {
      console.log(`  id=${c.id} name=${c.name} status=${c.status} maturityId=${c.contractMaturityId}`);
    }
    console.log();
  }

  // 4) Position list (cheap sanity)
  console.log('── 4. GET /position/list ──');
  const pos = await get('/position/list', token);
  console.log(`status=${pos.status} ok=${pos.ok}`);
  if (Array.isArray(pos.body)) {
    if (pos.body.length === 0) console.log('  (no open positions)');
    for (const p of pos.body) {
      console.log(`  posId=${p.id} contractId=${p.contractId} netPos=${p.netPos} netPrice=${p.netPrice}`);
    }
  } else {
    console.log('  ', JSON.stringify(pos.body));
  }
  console.log('\n✅ smoke test done — no orders placed');
}

main().catch(err => { console.error(err); process.exit(1); });
