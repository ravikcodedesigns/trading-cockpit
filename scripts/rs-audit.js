// rs-audit — ONE-SHOT, READ-ONLY discovery probe of the RS platform DOM.
// Passive: a single Runtime.evaluate on the already-loaded page (no writes, no
// clicks, no navigation, nothing originated). Used once to map what the engine
// can read for the IRRATIONAL RULES gate + dynamic HP/MHP. Safe to delete after.
//   node scripts/rs-audit.js
const http = require('http');
const WS = require('/Users/ravikumarbasker/trading-cockpit/node_modules/.pnpm/ws@8.20.0/node_modules/ws');
const PORT = process.env.CDP_PORT || '9333';

const EXPR = `(function(){
  function col(el){ try{return getComputedStyle(el).color;}catch(e){return null;} }
  function bg(el){ try{return getComputedStyle(el).backgroundColor;}catch(e){return null;} }
  var all = Array.from(document.querySelectorAll('*'));

  // 1) Locate any "Irrational"/"Unusual" header and dump its container's rows.
  var headers = all.filter(function(e){ return e.childElementCount===0 && /irrational|unusual/i.test(e.textContent||''); });
  var sections = [];
  headers.forEach(function(h){
    var box = h.parentElement; for (var k=0;k<4 && box && box.parentElement;k++){ if (box.querySelectorAll('*').length>6) break; box=box.parentElement; }
    if (!box) return;
    var rows=[];
    Array.from(box.querySelectorAll('*')).forEach(function(c){
      if (c.childElementCount>0) return; var t=(c.textContent||'').trim(); if(!t||t.length>70) return;
      var arrows=[]; var row=c.closest('li,tr,div')||c.parentElement;
      if (row) Array.from(row.querySelectorAll('*')).forEach(function(a){ var at=(a.textContent||''); if(/[\\u25B2\\u25BC\\u2191\\u2193\\u25B4\\u25BE]/.test(at)&&a.childElementCount===0) arrows.push({ch:at.trim(),color:col(a)}); });
      rows.push({ text:t, id:c.id||'', color:col(c), bg:bg(c), arrows:arrows });
    });
    sections.push({ header:(h.textContent||'').trim(), rows:rows.slice(0,40), html:(box.outerHTML||'').slice(0,3500) });
  });

  // 2) Any leaf row mentioning the alert phrases (in case the header text differs).
  var phrase=/(dd[- ]?band|hedge|mhp|risk interval|catalyst|break)/i;
  var hits=[];
  all.forEach(function(e){ if(e.childElementCount>0) return; var t=(e.textContent||'').trim(); if(!t||t.length>70||!phrase.test(t)) return;
    var row=e.closest('li,tr,div')||e.parentElement; var arrows=[];
    if(row) Array.from(row.querySelectorAll('*')).forEach(function(a){var at=(a.textContent||'');if(/[\\u25B2\\u25BC\\u2191\\u2193\\u25B4\\u25BE]/.test(at)&&a.childElementCount===0)arrows.push({ch:at.trim(),color:col(a)});});
    hits.push({ text:t, id:e.id||'', color:col(e), arrows:arrows });
  });
  // dedupe by text
  var seen={}, uhits=[]; hits.forEach(function(h){ if(!seen[h.text]){seen[h.text]=1;uhits.push(h);} });

  // 3) Element IDs of interest + DYN_HP shape.
  var ids = all.filter(function(e){return e.id && /(DD|MHP|HP|alert|irration|unusual|break|cat|RI)/i.test(e.id);}).map(function(e){return e.id;});
  var dynKeys = window.DYN_HP ? Object.keys(window.DYN_HP) : null;
  var dynSample = {}; if(window.DYN_HP) ['NQ','SP','ES','VX','NQ100','SP500'].forEach(function(k){ if(window.DYN_HP[k]) dynSample[k]=window.DYN_HP[k]; });

  return JSON.stringify({ sections:sections, alertHits:uhits.slice(0,50), idsOfInterest:ids.slice(0,120), dynKeys:dynKeys, dynSample:dynSample });
})()`;

http.get(`http://localhost:${PORT}/json`, res => { let b=''; res.on('data',d=>b+=d); res.on('end',()=>{
  let tab; try{ const pp=JSON.parse(b).filter(t=>t.type==='page'&&(t.url||'').includes('rocket.place/pro-plus'));
    tab=pp.find(t=>/\/pro-plus\/?($|[?#])/.test(t.url))||pp.find(t=>!/\/(settings|account|pricing|dashboard)/.test(t.url))||pp[0]; }catch(e){ console.error('list parse',e.message); process.exit(1); }
  if(!tab){ console.error('no pro-plus tab'); process.exit(1); }
  const ws=new WS(tab.webSocketDebuggerUrl,{maxPayload:50*1024*1024});
  const to=setTimeout(()=>{console.error('timeout');process.exit(1);},8000);
  ws.on('open',()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:EXPR,returnByValue:true}})));
  ws.on('message',m=>{const msg=JSON.parse(m);if(msg.id===1){clearTimeout(to);try{ws.close();}catch{};
    if(msg.result&&msg.result.exceptionDetails){console.error('eval error',JSON.stringify(msg.result.exceptionDetails).slice(0,400));process.exit(1);}
    console.log(JSON.stringify(JSON.parse(msg.result.result.value),null,2));process.exit(0);}});
  ws.on('error',e=>{clearTimeout(to);console.error('ws',e.message);process.exit(1);});
});}).on('error',e=>{console.error('http',e.message);process.exit(1);});
