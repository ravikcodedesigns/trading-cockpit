// RTH-only passive CDP read of the RS platform on Chrome :9333 (NO API calls).
// Answers three questions for the "drop DOM scraping?" decision:
//   1) COVERAGE  — does RS_SOCK.resil.marketState (+ scanner.MASTER_TABLE / tvlive)
//      hold all the data the DOM scrapers use (LM, 3 resiliences, DD, HP/MHP, levels)?
//   2) FRESHNESS — does marketState update in place so a 5s poll yields fresh
//      resilience/irrational values (read twice ~5s apart, diff)?
//   3) SPEED     — is grabbing+parsing marketState faster than DOM scraping?
//      (in-page per-read ms + payload size + end-to-end CDP round-trip ms)
//   node scripts/rs_marketstate_compare.js
const http = require('http');
const fs = require('fs');
const WS = require('/Users/ravikumarbasker/trading-cockpit/node_modules/.pnpm/ws@8.20.0/node_modules/ws');
const PORT = process.env.CDP_PORT || '9333';

const getTabs = () => new Promise((res, rej) =>
  http.get(`http://127.0.0.1:${PORT}/json`, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const evalOn = (wsUrl, expr) => new Promise((res, rej) => {
  const ws = new WS(wsUrl, { maxPayload: 120 * 1024 * 1024 });
  const to = setTimeout(() => { try { ws.close(); } catch {} rej(new Error('timeout')); }, 12000);
  ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })));
  ws.on('message', m => { const msg = JSON.parse(m); if (msg.id === 1) { clearTimeout(to); try { ws.close(); } catch {} const r = msg.result || {}; if (r.exceptionDetails) return rej(new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))); res(r.result && r.result.value); } });
  ws.on('error', rej);
});
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── helpers used inside the page ──────────────────────────────────────────────
const MS_DATA = `(function(){var o=window.RS_SOCK&&window.RS_SOCK.resil&&window.RS_SOCK.resil.marketState;return o?(o.data||(typeof o.get==='function'&&o.get())||o):null;})()`;
const DOM_SCRAPE = `(function(){var o={};o.lm=(document.querySelector('.liq-map-image-text')||{}).textContent||null;o.dd=(function(e){return e?(e.innerText||e.textContent||'').trim():null;})(document.getElementById('sp-DD'));o.resil=[];document.querySelectorAll('.rules-container').forEach(function(b){var sect=((b.querySelector('.title')||{}).textContent||'').trim();b.querySelectorAll('.rule-item').forEach(function(el){var nm=((el.querySelector('.rule-name')||{}).textContent||'').trim();if(nm)o.resil.push({section:sect,name:nm,text:(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80)});});});return o;})()`;

// ── 1) full coverage snapshot ─────────────────────────────────────────────────
const coverageExpr = `(function(){
  var d=function(x){try{return JSON.parse(JSON.stringify(x));}catch(e){return '<unser>';}};
  var pull=function(o){if(o==null)return null;var out={ownProps:Object.getOwnPropertyNames(o)};
    try{if('data' in o)out.data=d(o.data);}catch(e){out.data='ERR '+e.message;}
    try{if(typeof o.get==='function')out.get=d(o.get());}catch(e){out.get='ERR '+e.message;}
    if(out.data===undefined&&out.get===undefined)out.full=d(o);return out;};
  var S=window.RS_SOCK||{};
  return { ts:Date.now(), premarket:window.PREMARKET_HOURS,
    marketState:pull(S.resil&&S.resil.marketState),
    masterTable:pull(S.scanner&&S.scanner.MASTER_TABLE),
    tvlive_keys:S.tvlive?Object.getOwnPropertyNames(S.tvlive):null, tvlive:pull(S.tvlive),
    globals:{DYN_HP:d(window.DYN_HP),DD:d(window.DD?(Array.isArray(window.DD)?window.DD.slice(-1):window.DD):null),NQHPNOW:window.NQHPNOW,NQMHPNOW:window.NQMHPNOW,SPHPNOW:window.SPHPNOW,SPMHPNOW:window.SPMHPNOW},
    dom:JSON.parse(JSON.stringify((${DOM_SCRAPE}))) };
})()`;

// ── 3) in-page micro-benchmark (isolates parse/scrape cost from network) ───────
const benchExpr = `(function(){var K=100;
  var msData=(${MS_DATA});
  var t0=performance.now(),s1;for(var i=0;i<K;i++){s1=JSON.stringify(msData);}var tMS=(performance.now()-t0)/K;
  var t1=performance.now(),s2;for(var j=0;j<K;j++){s2=JSON.stringify((${DOM_SCRAPE}));}var tDOM=(performance.now()-t1)/K;
  return {iters:K, marketState_ms_per_read:+tMS.toFixed(4), dom_ms_per_read:+tDOM.toFixed(4),
          marketState_bytes:(s1||'').length, dom_bytes:(s2||'').length};
})()`;

(async () => {
  const tabs = await getTabs();
  const tab = tabs.find(t => t.type === 'page' && /pro-plus|rocket\.place/i.test(t.url || ''));
  if (!tab) { console.error('no RS tab'); process.exit(1); }
  const url = tab.webSocketDebuggerUrl;

  // 1) coverage
  const cov = await evalOn(url, coverageExpr);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = `data/rs-marketstate-capture-${stamp}.json`;
  fs.writeFileSync(outFile, JSON.stringify(cov, null, 2));
  const has = x => x && (x.data || x.get || x.full) ? 'POPULATED' : (x ? 'present-but-empty' : 'NULL');

  // 2) freshness — read marketState now and ~5s later, diff
  const r1 = await evalOn(url, `JSON.stringify((${MS_DATA}))`);
  await sleep(5000);
  const r2 = await evalOn(url, `JSON.stringify((${MS_DATA}))`);
  const changed = r1 !== r2;

  // 3) speed — in-page bench + end-to-end CDP round-trip (10 each)
  const bench = await evalOn(url, benchExpr);
  const e2e = async expr => { const t = []; for (let i = 0; i < 10; i++) { const s = Date.now(); await evalOn(url, expr); t.push(Date.now() - s); } return median(t); };
  const e2eMS = await e2e(`JSON.stringify((${MS_DATA}))`);
  const e2eDOM = await e2e(`JSON.stringify((${DOM_SCRAPE}))`);

  console.log('captured →', outFile);
  console.log('premarket:', cov.premarket);
  console.log('── COVERAGE ──');
  console.log('  marketState :', has(cov.marketState), cov.marketState ? '(ownProps: ' + (cov.marketState.ownProps || []).slice(0, 14).join(',') + ')' : '');
  console.log('  MASTER_TABLE:', has(cov.masterTable));
  console.log('  tvlive keys :', cov.tvlive_keys ? cov.tvlive_keys.join(',') : 'NULL');
  console.log('  DOM lm/dd   :', JSON.stringify(cov.dom.lm), '/', cov.dom.dd, ' resilRows:', (cov.dom.resil || []).length);
  console.log('  globals NOW : NQHP', cov.globals.NQHPNOW, 'NQMHP', cov.globals.NQMHPNOW, 'SPHP', cov.globals.SPHPNOW, 'SPMHP', cov.globals.SPMHPNOW, 'DD', JSON.stringify(cov.globals.DD));
  console.log('── FRESHNESS (5s) ──');
  console.log('  marketState changed in 5s:', changed, ' (len', (r1 || '').length, '→', (r2 || '').length, ')');
  console.log('── SPEED ──');
  console.log('  in-page per-read:  marketState', bench.marketState_ms_per_read, 'ms  vs  DOM', bench.dom_ms_per_read, 'ms');
  console.log('  payload bytes:     marketState', bench.marketState_bytes, '  vs  DOM', bench.dom_bytes);
  console.log('  end-to-end (CDP) median:  marketState', e2eMS, 'ms  vs  DOM', e2eDOM, 'ms');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
