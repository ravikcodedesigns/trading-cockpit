// Passive CDP probe: find a single comprehensive RS data object on the page and
// compare its coverage vs the DOM-scraped fields. Read-only — NO API calls.
//   node scripts/rs_probe.js
const http = require('http');
const WS = require('/Users/ravikumarbasker/trading-cockpit/node_modules/.pnpm/ws@8.20.0/node_modules/ws');
const PORT = process.env.CDP_PORT || '9333';

const getTabs = () => new Promise((res, rej) => {
  http.get(`http://127.0.0.1:${PORT}/json`, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});
const evalOn = (wsUrl, expr) => new Promise((res, rej) => {
  const ws = new WS(wsUrl, { maxPayload: 50 * 1024 * 1024 });
  const to = setTimeout(() => { try { ws.close(); } catch {} rej(new Error('timeout')); }, 8000);
  ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })));
  ws.on('message', m => { const msg = JSON.parse(m); if (msg.id === 1) { clearTimeout(to); try { ws.close(); } catch {} res(msg.result && msg.result.result && msg.result.result.value); } });
  ws.on('error', rej);
});

// expression: scan window for candidate data globals + dump the known ones
const expr = `(function(){
  var out={};
  // 1) candidate comprehensive objects by name
  var cand=Object.keys(window).filter(function(k){return /market|read|context|rsdata|rs_|store|state|liqmap|liq_map|dataset/i.test(k);});
  out.candidateKeys=cand.slice(0,60);
  // 2) any object that holds NQ & ES sub-objects with hp/mhp/close/dd
  var rich=[];
  for (var k in window){ try{ var v=window[k];
    if(v && typeof v==='object' && (v.NQ||v.nq) && (v.ES||v.es)){ rich.push(k); }
  }catch(e){} }
  out.richNQES=rich.slice(0,40);
  // 3) dump the globals the current scrapers use
  var dump=function(x){try{return JSON.parse(JSON.stringify(x));}catch(e){return String(x);}};
  out.DYN_HP=dump(window.DYN_HP);
  out.DD=dump(window.DD ? (Array.isArray(window.DD)?window.DD.slice(-1):window.DD) : null);
  out.NQHPNOW=window.NQHPNOW; out.NQMHPNOW=window.NQMHPNOW;
  out.SPHPNOW=window.SPHPNOW; out.SPMHPNOW=window.SPMHPNOW;
  out.marketRead = (typeof window.marketRead!=='undefined')? dump(window.marketRead): 'UNDEFINED';
  // 4) DOM fields the scraper relies on
  var el=function(id){var e=document.getElementById(id);return e?(e.innerText||e.textContent||'').trim():null;};
  out.dom_spDD = el('sp-DD');
  out.dom_lm = (document.querySelector('.liq-map-image-text')||{}).textContent||null;
  out.dom_ruleContainers = document.querySelectorAll('.rules-container').length;
  return out;
})()`;

(async () => {
  const tabs = await getTabs();
  const tab = tabs.find(t => t.type === 'page' && /pro-plus|rocket\.place/i.test(t.url || '')) || tabs.find(t => t.type === 'page');
  if (!tab) { console.log('no RS tab found'); process.exit(1); }
  console.log('probing tab:', tab.title, '::', tab.url);
  const v = await evalOn(tab.webSocketDebuggerUrl, expr);
  console.log(JSON.stringify(v, null, 2));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
