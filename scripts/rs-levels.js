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
// MM_ONLY: refresh only the per-symbol LM code + Monthly-Map bias (mmBullish) into
// rs-context — skip the once-daily zones/DD/HP/MHP read. Used by the 30-min RTH job
// so MM tracks price moving into/out of zones intraday without rewriting levels.
const MM_ONLY = process.env.MM_ONLY === '1';
const log = (...a) => console.error(new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }) + ' ET', ...a);

// ON HP / ON MHP removed 2026-06-18: the platform does NOT draw these, so they
// are entered manually in daily_levels{,_es}.json. Keeping them out of RS_OWNED
// means rs-levels treats them as user-owned and preserves them instead of
// wiping them when the platform read returns nothing for them.
const RS_OWNED = ['HP', 'MHP', 'HG', 'QQQ Open', 'QQQ Close', 'Bull Zone', 'Bear Zone', 'DD'];

const TARGETS = [
  // re matches tvWidget.chart(i).symbol() (e.g. F.US.MNQU26); paneRe matches the
  // chart-widget's DESCRIPTIVE legend ("Micro E-mini Nasdaq-100") for the LM click.
  { name: 'NQ', re: /MNQ|F\.US\.ENQ/, paneRe: /nasdaq/i, file: path.resolve(__dirname, '../daily_levels.json'),    hpNow: 'NQHPNOW', mhpNow: 'NQMHPNOW' },
  { name: 'ES', re: /MES|F\.US\.EP|F\.US\.ES/, paneRe: /s&amp;p|s&p/i, file: path.resolve(__dirname, '../daily_levels_es.json'), hpNow: 'SPHPNOW', mhpNow: 'SPMHPNOW' },
  // Commodities (full-size CQG futures): F.US.CLEN26 = Crude Light, F.US.GCEN26 = Gold —
  // the root (CLE/GCE) is stable across the monthly roll. The platform plots DD bands on
  // both (and HP/MHP/zones on gold). No per-symbol HP/MHP "now" globals exist for these,
  // so HP/MHP come from the plotted shapes. These panes run on 15m (not 1m), so readLmMm
  // restores each chart's ORIGINAL resolution after the 1D Monthly-Map flip. Completeness
  // is relaxed to ddBands only (needIntraday) with no LM/MM gating (needLmMm): zones/LM/MM
  // may be absent — esp. crude — and must not stall the retry loop.
  { name: 'CL', re: /F\.US\.CLE/, paneRe: /crude/i, file: path.resolve(__dirname, '../daily_levels_cl.json'), hpNow: 'CLHPNOW', mhpNow: 'CLMHPNOW', needIntraday: ['ddBands'], needLmMm: [] },
  { name: 'GC', re: /F\.US\.GCE/, paneRe: /gold/i,  file: path.resolve(__dirname, '../daily_levels_gc.json'), hpNow: 'GCHPNOW', mhpNow: 'GCMHPNOW', needIntraday: ['ddBands'], needLmMm: [] },
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Generic one-shot CDP command over a fresh WS (used for Input.dispatchMouseEvent).
function cdp(method, params) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/json`, res => { let b=''; res.on('data',d=>b+=d); res.on('end',()=>{
      let tab; try{ const _pp=JSON.parse(b).filter(t=>t.type==='page'&&(t.url||'').includes('rocket.place/pro-plus'));
        tab=_pp.find(t=>/\/pro-plus\/?($|[?#])/.test(t.url))||_pp.find(t=>!/\/(settings|account|pricing|dashboard)/.test(t.url))||_pp[0]; }catch(e){ return reject(new Error('cdp list')); }
      if(!tab) return reject(new Error('no pro-plus tab'));
      const ws=new WS(tab.webSocketDebuggerUrl,{maxPayload:50*1024*1024});
      const to=setTimeout(()=>{try{ws.close();}catch{};reject(new Error('cdp timeout'));},8000);
      ws.on('open',()=>ws.send(JSON.stringify({id:1,method,params})));
      ws.on('message',m=>{const msg=JSON.parse(m);if(msg.id===1){clearTimeout(to);try{ws.close();}catch{};resolve(msg.result);}});
      ws.on('error',e=>{clearTimeout(to);reject(e);});
    });}).on('error',reject);
  });
}
async function clickAt(x, y) {
  await cdp('Input.dispatchMouseEvent', { type:'mousePressed',  x, y, button:'left', buttons:1, clickCount:1 });
  await sleep(60);
  await cdp('Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', buttons:0, clickCount:1 });
}

// chart index whose symbol matches a regex (by symbol, robust to extra ETF charts).
const findIdxExpr = reSrc => `(function(){var w=window.tvWidget,n=w.chartsCount();for(var i=0;i<n;i++){if(${reSrc}.test(w.chart(i).symbol()))return i;}return -1;})()`;
// pane center (viewport coords) for the chart matching re — the click target that refreshes the LM text.
const paneCenterExpr = reSrc => `(function(){var re=${reSrc};var fr=document.querySelector('iframe#tradingview_41ff2')||document.querySelector('iframe');if(!fr)return null;var off=fr.getBoundingClientRect();var doc;try{doc=fr.contentDocument||fr.contentWindow.document;}catch(e){return null;}if(!doc)return null;var ws=doc.querySelectorAll('.chart-widget');for(var i=0;i<ws.length;i++){var leg=ws[i].querySelector('[class*=legend]');var txt=leg?(leg.innerText||''):(ws[i].innerText||'');if(re.test(txt)){var r=ws[i].getBoundingClientRect();if(r.width<80)continue;return JSON.stringify({x:Math.round(off.x+r.x+r.width/2),y:Math.round(off.y+r.y+r.height/2)});}}return null;})()`;
const lmExpr = `(document.querySelector('.liq-map-image-text')||{}).textContent||null`;
// per-chart 1D rectangles (price+time+color) + current price for the Monthly-Map read.
const mmScrape = idx => `(function(){var ch=window.tvWidget.chart(${idx});var out={rects:[]};try{out.res=ch.resolution();out.sym=ch.symbol();}catch(e){}try{var cbs=window.tvOnRealtimeBarsCallbacks||[];var pick=function(test){for(var i=0;i<cbs.length;i++){if(cbs[i].symbol===out.sym&&cbs[i].lastBar&&test(cbs[i])){out.price=cbs[i].lastBar.close;out.lastBarT=Math.floor(cbs[i].lastBar.time/1000);return true;}}return false;};pick(function(c){return String(c.resolution)===String(out.res);})||pick(function(){return true;});}catch(e){}try{ch.getAllShapes().forEach(function(s){if(!/rectangle/i.test(s.name||''))return;try{var o=ch.getShapeById(s.id);var pts=o.getPoints();var pr=pts.map(function(p){return p.price;});var tm=pts.map(function(p){return p.time;});var p=o.getProperties();out.rects.push({lo:Math.min.apply(null,pr),hi:Math.max.apply(null,pr),tmin:Math.min.apply(null,tm),tmax:Math.max.apply(null,tm),c:p.backgroundColor||p.color||''});}catch(e){}});}catch(e){}return JSON.stringify(out);})()`;

// Monthly-Map bias: filter rectangles to the next-day projection column, then
// price-in-#767a88-bear => bearish, else (bull zone or gap) => bullish. Returns null if unreadable.
function computeMM(d) {
  if (!d || d.price == null || !Array.isArray(d.rects) || !d.lastBarT) return null;
  const DAY = 86400, lb = d.lastBarT;
  const col = d.rects.filter(r => r.tmin >= lb - 0.5 * DAY && r.tmin <= lb + 1.5 * DAY);
  if (!col.length) return null;
  const norm = c => (c || '').toLowerCase().replace(/\s/g, '');
  const inBear = col.some(z => norm(z.c).includes('767a88') && d.price >= z.lo && d.price <= z.hi);
  return !inBear;
}

// Merge per-symbol lmCode/mmBullish into rs-context.json (preserve resiliences + everything else).
function writeRsContext(perSym) {
  const CTX = path.resolve(__dirname, '../data/rs-context.json');
  let cur = {}; try { cur = JSON.parse(fs.readFileSync(CTX, 'utf8')); } catch (e) {}
  const by = { ...(cur.bySymbol || {}) };
  for (const [sym, vals] of Object.entries(perSym)) by[sym] = { ...(by[sym] || {}), ...vals };
  cur.bySymbol = by;
  if (perSym.NQ && perSym.NQ.lmCode) cur.lmCode = perSym.NQ.lmCode; // global default mirrors NQ
  fs.writeFileSync(CTX, JSON.stringify(cur, null, 2));
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

// Phase 1 — intraday zones/levels → daily_levels{,_es}.json (charts must be on 1m).
// Returns true if at least one target had real zone bands (used to gate the retry).
async function readIntraday() {
  const d = JSON.parse(await evalExpr(SCRAPE));
  if (d.err) throw new Error(d.err);
  let zonesFound = false;
  const bySym = {};   // per-symbol derived values, for the completeness/retry check
  for (const t of TARGETS) {
    const chart = d.charts.find(c => t.re.test(c.symbol || ''));
    if (!chart) { log(`${t.name}: no matching chart`); bySym[t.name] = {}; continue; }
    const mapped = mapChart(chart.shapes, d[t.hpNow], d[t.mhpNow]);
    if (mapped.zones.bull.length + mapped.zones.bear.length > 0) zonesFound = true;
    log(`── ${t.name} (${chart.symbol}, ${chart.shapes.length} shapes) ──`);
    log(`  ${mapped.zones.bull.length} bull + ${mapped.zones.bear.length} bear zone bands`);
    const out = { primaryBull: mapped.bullZone, primaryBear: mapped.bearZone, ddBands: mapped.ddBands, HP: mapped.hedgePressure, MHP: mapped.mhp, additional: mapped.rsAdditionalLevels.map(a => `${a.label}@${a.price}`) };
    console.error('  →', JSON.stringify(out));
    bySym[t.name] = { primaryBull: mapped.bullZone, primaryBear: mapped.bearZone, ddBands: mapped.ddBands, HP: mapped.hedgePressure, MHP: mapped.mhp };
    if (!DRY) { const kept = writeFile(t, mapped); log(`  wrote ${t.file.split('/').pop()} [${etDate()}] (${kept} price-derived preserved)`); }
  }
  return { zonesFound, bySym };
}

// Phase 2 — per-symbol LM code + Monthly-Map bias. Flips each chart to 1D briefly
// (restores to 1m after), clicks the pane so the LM text refreshes (setResolution
// activates the chart but leaves the LM stale), reads next-day-column zones, then
// writes lmCode + mmBullish into rs-context. Failures are isolated per symbol.
async function readLmMm() {
  const perSym = {};
  for (const t of TARGETS) {
    try {
      const idx = await evalExpr(findIdxExpr(t.re.toString()));
      if (idx == null || idx < 0) { log(`${t.name}: no chart for LM/MM`); continue; }
      // capture the chart's current resolution so we restore it (CL/GC run on 15m, not 1m)
      let origRes = '1';
      try { origRes = ('' + (await evalExpr(`''+window.tvWidget.chart(${idx}).resolution()`))) || '1'; } catch (e) {}
      await evalExpr(`window.tvWidget.chart(${idx}).setResolution("1D");"ok"`);
      let lm = null;
      try { const c = await evalExpr(paneCenterExpr(t.paneRe.toString())); if (c) { const p = JSON.parse(c); await clickAt(p.x, p.y); } } catch (e) {}
      await sleep(3500); // let LM refresh + daily bars/zone rectangles render
      try { lm = await evalExpr(lmExpr); } catch (e) {}
      let mm = null;
      try { mm = computeMM(JSON.parse(await evalExpr(mmScrape(idx)))); } catch (e) {}
      await evalExpr(`window.tvWidget.chart(${idx}).setResolution(${JSON.stringify(origRes)});"ok"`);
      const v = {};
      if (lm) v.lmCode = ('' + lm).trim();
      if (mm != null) v.mmBullish = mm;
      if (Object.keys(v).length) perSym[t.name] = v;
      log(`  ${t.name}: LM=${lm ? ('' + lm).trim() : '?'}  MM=${mm == null ? '?' : (mm ? 'bullish' : 'bearish')}`);
    } catch (e) { log(`${t.name}: LM/MM read failed — ${e.message}`); }
  }
  if (!DRY && Object.keys(perSym).length) { writeRsContext(perSym); log(`  rs-context updated: ${Object.keys(perSym).join(', ')}`); }
  // mmOk = every symbol produced a non-null Monthly-Map read this pass. A null read
  // (charts not loaded at the open) must NOT count as success — otherwise the prior
  // day's stale mmBullish is left in place all session.
  const mmOk = TARGETS.every(t => {
    const need = t.needLmMm || NEED_LMMM;
    return !need.includes('mmBullish') || (perSym[t.name] && perSym[t.name].mmBullish != null);
  });
  return { perSym, mmOk };
}

// Every value the job derives, per symbol. A null in ANY of these means the read
// was incomplete (charts not rendered yet) → the run should retry.
const NEED_INTRADAY = ['primaryBull', 'primaryBear', 'ddBands', 'HP', 'MHP'];
const NEED_LMMM = ['lmCode', 'mmBullish'];

async function main() {
  const bySym = MM_ONLY ? {} : (await readIntraday()).bySym;
  const { perSym } = await readLmMm();
  // Re-assert mmBullish after one rs-feed cycle so a concurrent 5s write (which
  // read the file just before our write) can't permanently drop it.
  if (!DRY && Object.keys(perSym).length) { await sleep(7000); writeRsContext(perSym); }
  if (DRY) log('DRY — no files written.');
  // Completeness: every value the run derives must be non-null (MM_ONLY checks just
  // LM+MM). Any null → retry, so a partial read at the open self-heals.
  const nulls = [];
  for (const t of TARGETS) {
    const iv = bySym[t.name] || {}, lv = perSym[t.name] || {};
    const needI = t.needIntraday || NEED_INTRADAY;   // CL/GC: just ddBands
    const needL = t.needLmMm || NEED_LMMM;           // CL/GC: none (LM/MM optional)
    const miss = [
      ...(MM_ONLY ? [] : needI.filter(k => iv[k] == null)),
      ...needL.filter(k => lv[k] == null),
    ];
    if (miss.length) nulls.push(`${t.name}:${miss.join(',')}`);
  }
  if (nulls.length) log(`  null derived values: ${nulls.join(' | ')}`);
  return { allOk: nulls.length === 0 };
}

(async () => {
  try {
    // 09:32 fires ~2 min after the open, when the intraday zone bands and the 1D
    // charts often haven't rendered yet. Retry until BOTH the zone bands are drawn
    // AND the Monthly-Map read succeeds for every symbol — a single early failure
    // must not leave the prior day's stale mmBullish in place.
    const MAX = 6;
    for (let attempt = 1; ; attempt++) {
      const { allOk } = await main();
      if (DRY || allOk || attempt >= MAX) break;
      log(`retry ${attempt}/${MAX - 1}: incomplete read (null value) — again in 60s`);
      await sleep(60_000);
    }
  } catch (e) { log('ERROR', e.message); process.exit(1); }
})();
