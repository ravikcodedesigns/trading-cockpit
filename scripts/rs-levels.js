// rs-levels — passive reader of the platform's plotted RS levels/zones → daily_levels{,_es}.json.
//
// For BOTH NQ (MNQ chart) and ES (MES chart): reads the platform's own plotted
// shapes via CDP (TV widget shape API — local read, NO network): lines=levels,
// rectangles=zones (full top+bottom), text=labels (incl RS context). Merges the
// RS-platform levels into the per-symbol levels file, PRESERVING price-derived
// levels (PDH/POC/VWAP/…). DRY_RUN=1 prints only.
//
//   DRY_RUN=1 node scripts/rs-levels.js   # read + parse + show mapping, no write
//   node scripts/rs-levels.js             # also write daily_levels{,_es}.json
const http = require('http');
const fs = require('fs');
const path = require('path');
const WS = require('/Users/ravikumarbasker/trading-cockpit/node_modules/.pnpm/ws@8.20.0/node_modules/ws');

const PORT = process.env.CDP_PORT || '9333';
const DRY = process.env.DRY_RUN === '1';
const log = (...a) => console.error(new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }) + ' ET', ...a);

// ON HP / ON MHP removed 2026-06-18: the platform does NOT draw these, so they
// are entered manually in daily_levels{,_es}.json. Keeping them out of RS_OWNED
// means rs-levels treats them as user-owned and preserves them instead of
// wiping them when the platform read returns nothing for them.
const RS_OWNED = ['HP', 'MHP', 'HG', 'QQQ Open', 'QQQ Close', 'Bull Zone', 'Bear Zone', 'DD'];

const TARGETS = [
  { name: 'NQ', re: /MNQ|F\.US\.ENQ/, file: path.resolve(__dirname, '../daily_levels.json'),    hpNow: 'NQHPNOW', mhpNow: 'NQMHPNOW' },
  { name: 'ES', re: /MES|F\.US\.EP|F\.US\.ES/, file: path.resolve(__dirname, '../daily_levels_es.json'), hpNow: 'SPHPNOW', mhpNow: 'SPMHPNOW' },
];

// Return every chart's shapes + the per-index HP/MHP "now" globals + DD.
const SCRAPE = `(function(){
  var w=window.tvWidget; if(!w) return JSON.stringify({err:'no tvWidget'});
  var n=w.chartsCount?w.chartsCount():1; var charts=[];
  for(var i=0;i<n;i++){ try{
    var c=w.chart(i); var ids=c.getAllShapes(); var sh=[];
    ids.forEach(function(s){ try{
      var o=c.getShapeById(s.id); var pts=o.getPoints?o.getPoints():[]; var pr={};
      try{pr=o.getProperties?o.getProperties():{};}catch(e){}
      sh.push({name:s.name, prices:pts.map(function(p){return p.price;}), text:(pr.text||pr.title||'')});
    }catch(e){} });
    charts.push({symbol:c.symbol(), shapes:sh});
  }catch(e){} }
  var ddLast=(function(a){if(!Array.isArray(a))return a;for(var i=a.length-1;i>=0;i--)if(a[i]&&a[i].value!==undefined)return a[i].value;return null;})(window.DD);
  return JSON.stringify({charts:charts, NQHPNOW:window.NQHPNOW, NQMHPNOW:window.NQMHPNOW, SPHPNOW:window.SPHPNOW, SPMHPNOW:window.SPMHPNOW, DD:ddLast});
})()`;

function evalExpr(expr) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/json`, res => { let b=''; res.on('data',d=>b+=d); res.on('end',()=>{
      let tab; try{ const _pp=JSON.parse(b).filter(t=>t.type==='page'&&(t.url||'').includes('rocket.place/pro-plus'));
        tab=_pp.find(t=>/\/pro-plus\/?($|[?#])/.test(t.url))||_pp.find(t=>!/\/(settings|account|pricing|dashboard)/.test(t.url))||_pp[0]; }catch(e){ return reject(new Error('cdp list')); }
      if(!tab) return reject(new Error('rocket pro-plus tab not found'));
      const ws=new WS(tab.webSocketDebuggerUrl,{maxPayload:50*1024*1024});
      const to=setTimeout(()=>{try{ws.close();}catch{};reject(new Error('timeout'));},8000);
      ws.on('open',()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:expr,returnByValue:true}})));
      ws.on('message',m=>{const msg=JSON.parse(m);if(msg.id===1){clearTimeout(to);try{ws.close();}catch{};resolve(msg.result?.result?.value);}});
      ws.on('error',e=>{clearTimeout(to);reject(e);});
    });}).on('error',reject);
  });
}

function parseLabel(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/(\d[\d,]*\.?\d*)/);
  const price = m ? parseFloat(m[1].replace(/,/g, '')) : null;
  const label = t.split(':')[0].replace(/[:]+$/, '').trim();
  return { label, price };
}
const etDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function mapChart(shapes, nowHP, nowMHP) {
  // Separate text labels (name+price) from rectangle bands (low/high, label is a
  // SEPARATE text shape). Zone rule: Bull-Zone label sits at the rectangle BOTTOM,
  // Bear-Zone label at the TOP.
  const labels = [], rects = [];
  for (const s of shapes) {
    if (s.name === 'rectangle' && s.prices.length >= 2) rects.push({ low: Math.min(...s.prices), high: Math.max(...s.prices) });
    else if (s.text) { const { label, price } = parseLabel(s.text); if (price != null) labels.push({ label, price }); }
  }
  const near = (arr, v, tol = 2.5) => arr.some(x => Math.abs(x - v) <= tol);
  const bullLabels = labels.filter(l => /bull zone/i.test(l.label)).map(l => l.price);
  const bearLabels = labels.filter(l => /bear zone/i.test(l.label)).map(l => l.price);
  const bull = [], bear = [];
  for (const r of rects) {
    if (near(bullLabels, r.low)) bull.push({ low: +r.low.toFixed(2), high: +r.high.toFixed(2) });
    else if (near(bearLabels, r.high)) bear.push({ high: +r.high.toFixed(2), low: +r.low.toFixed(2) });
  }
  bull.sort((a, b) => a.low - b.low); bear.sort((a, b) => a.high - b.high);

  const dd = labels.filter(l => /^DD/i.test(l.label)).map(l => l.price).sort((a, b) => a - b);
  const ddBands = dd.length >= 2 ? { upper: dd[dd.length - 1], lower: dd[0] } : null;
  const findLine = lbl => labels.find(l => l.label.toLowerCase() === lbl.toLowerCase())?.price ?? null;
  // primary zone = band nearest the DD-mid (proxy for current price), for scorer back-compat
  const mid = ddBands ? (ddBands.upper + ddBands.lower) / 2 : (nowMHP || 0);
  const nearest = zs => zs.length ? zs.reduce((a, b) => Math.abs((a.low + a.high) / 2 - mid) <= Math.abs((b.low + b.high) / 2 - mid) ? a : b) : null;
  const pBull = nearest(bull), pBear = nearest(bear);
  // RS-owned point levels for additionalLevels (HG, QQQ/SPY Open/Close; not zones/DD/HP/MHP)
  const rsAdd = labels.filter(l => RS_OWNED.some(r => l.label.toLowerCase() === r.toLowerCase())
      && !/zone/i.test(l.label) && !/^DD$/i.test(l.label) && !/^HP$|^MHP$/i.test(l.label))
    .map(l => ({ label: l.label, price: l.price }))
    // include the platform's *Open/*Close even though not in RS_OWNED list literally
    .concat(labels.filter(l => /(QQQ|SPY) (Open|Close)/i.test(l.label)).map(l => ({ label: l.label, price: l.price })))
    .filter((v, i, a) => a.findIndex(x => x.label === v.label) === i);
  return {
    bullZone: pBull, bearZone: pBear,
    zones: { bull, bear },
    ddBands,
    hedgePressure: findLine('HP') ?? (nowHP || null),
    mhp: findLine('MHP') ?? (nowMHP || null),
    rsAdditionalLevels: rsAdd,
    _lines: labels, _zones: [...bull.map(z => ({ ...z, t: 'B' })), ...bear.map(z => ({ ...z, t: 'R' }))],
  };
}

function writeFile(target, mapped) {
  const doc = JSON.parse(fs.readFileSync(target.file, 'utf8'));
  doc.days = doc.days || {};
  const date = etDate();
  doc.days[date] = doc.days[date] || { levels: [{ symbol: target.name }] };
  let lv = doc.days[date].levels.find(x => x.symbol === target.name);
  if (!lv) { lv = { symbol: target.name }; doc.days[date].levels.push(lv); }
  if (mapped.bullZone) lv.bullZone = mapped.bullZone;
  if (mapped.bearZone) lv.bearZone = mapped.bearZone;
  if (mapped.zones && (mapped.zones.bull.length || mapped.zones.bear.length)) lv.zones = mapped.zones;
  if (mapped.ddBands) lv.ddBands = mapped.ddBands;
  if (mapped.hedgePressure) lv.hedgePressure = mapped.hedgePressure;
  if (mapped.mhp) lv.mhp = mapped.mhp;
  const others = (lv.additionalLevels || []).filter(a => !RS_OWNED.some(r => a.label.toLowerCase() === r.toLowerCase()));
  lv.additionalLevels = [...others, ...mapped.rsAdditionalLevels];
  fs.writeFileSync(target.file, JSON.stringify(doc, null, 2));
  return others.length;
}

async function main() {
  const d = JSON.parse(await evalExpr(SCRAPE));
  if (d.err) throw new Error(d.err);
  for (const t of TARGETS) {
    const chart = d.charts.find(c => t.re.test(c.symbol || ''));
    if (!chart) { log(`${t.name}: no matching chart`); continue; }
    const mapped = mapChart(chart.shapes, d[t.hpNow], d[t.mhpNow]);
    log(`── ${t.name} (${chart.symbol}, ${chart.shapes.length} shapes) ──`);
    log(`  ${mapped.zones.bull.length} bull + ${mapped.zones.bear.length} bear zone bands`);
    log(`  zones near mid: ${mapped._zones.sort((a, b) => b.low - a.low).filter(z => Math.abs((z.low + z.high) / 2 - ((mapped.ddBands?.upper + mapped.ddBands?.lower) / 2 || z.low)) < 700).map(z => `${z.t} ${z.low}–${z.high}`).join('  ') || '(none)'}`);
    const out = { primaryBull: mapped.bullZone, primaryBear: mapped.bearZone, ddBands: mapped.ddBands, HP: mapped.hedgePressure, MHP: mapped.mhp, additional: mapped.rsAdditionalLevels.map(a => `${a.label}@${a.price}`) };
    console.error('  →', JSON.stringify(out));
    if (!DRY) { const kept = writeFile(t, mapped); log(`  wrote ${t.file.split('/').pop()} [${etDate()}] (${kept} price-derived preserved)`); }
  }
  if (DRY) log('DRY — no files written.');
}
main().catch(e => { log('ERROR', e.message); process.exit(1); });
