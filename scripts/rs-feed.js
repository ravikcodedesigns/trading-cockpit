// rs-feed — passive reader of the Rocket Scooter platform → data/rs-context.json.
//
// Reads ONLY values the platform has already rendered in the debug-port Chrome
// (CDP Runtime.evaluate on element IDs — a local DOM read, NO network originated).
// Merges DD ratio + the 3 resiliences (per index) into rs-context.json, which the
// aggregator (rs-context.ts watchContext) hot-reloads. Preserves all unscraped
// fields (greaterMarket, lmCode, vx, bbb, vvix).
//
//   node scripts/rs-feed.js            # live loop (writes), every INTERVAL s
//   DRY_RUN=1 node scripts/rs-feed.js  # one read, prints, writes nothing
//
// Resilience mapping (confirmed via platform color settings + DOM):
//   white  = redistribution/half-gap  → NQValues-w / SPValues-w
//   orange = MHP resilience           → NQMHP-w   / SPMHP-w
//   blue   = HP resilience            → NQHP-w    / SPHP-w
//   DD ratio (market, SP500)          → sp-DD   (same for NQ + ES)
const http = require('http');
const fs = require('fs');
const path = require('path');
const WS = require('/Users/ravikumarbasker/trading-cockpit/node_modules/.pnpm/ws@8.20.0/node_modules/ws');

const PORT = process.env.CDP_PORT || '9333';
const INTERVAL = (parseInt(process.env.INTERVAL || '5', 10)) * 1000;
const DRY = process.env.DRY_RUN === '1';
const CTX = path.resolve(__dirname, '../data/rs-context.json');
const log = (...a) => console.error(
  new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }) + ' ET', ...a);

// Current trading day as YYYY-MM-DD in ET (matches context_set.ts todayNY()). rs-feed is
// RTH-gated, so "today in ET" is always the live session. Stamped on every write because the
// once-daily writers (context_set CLI / rs-levels) don't refresh it — without this, tradingDay
// freezes at whatever last ran while setAt keeps ticking (froze at 2026-06-18 until 06-25).
function etDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// RTH gate: Mon–Fri 09:30–16:00 ET (DST-correct via America/New_York).
function inRTH() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t)?.value;
  const min = parseInt(g('hour'), 10) * 60 + parseInt(g('minute'), 10);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(g('weekday')) && min >= 570 && min < 960;
}

const SCRAPE = `(function(){
  var n=function(id){var e=document.getElementById(id); if(!e) return null;
    var v=parseFloat((e.innerText||e.textContent||'').replace(/[^0-9.\\-]/g,'')); return isNaN(v)?null:v;};
  return JSON.stringify({
    dd: n('sp-DD'),
    nq: { redist:n('NQValues-w'), mhp:n('NQMHP-w'), hp:n('NQHP-w') },
    sp: { redist:n('SPValues-w'), mhp:n('SPMHP-w'), hp:n('SPHP-w') },
    spyMhp: n('sp-MHP'),  // SP500 MHP price (vs SPY for ES greater-market)
    qqqMhp: n('nq-MHP'),  // NQ100 MHP price (vs QQQ for NQ greater-market)
    // VX gamma HP/MHP (UVXY-scale) — vs live UVXY for the vol-inflection read.
    vxg: (function(){ var v=(window.DYN_HP||{}).VX; return v?{hp:v.hp,mhp:v.mhp}:null; })(),
    // Dynamic/overnight HP/MHP estimate (window.DYN_HP), all on ETF scale: NQ→QQQ,
    // ES→SPY, GCE→GLD (≈ gold × 0.093, e.g. 377 for gold ~4080). Crude has no DYN_HP
    // entry — its levels come only from the chart via rs-levels.
    dyn: (function(){ var d=window.DYN_HP||{}; var p=function(o){return o?{hp:o.hp,mhp:o.mhp,close:o.close}:null;}; return {nq:p(d.NQ), es:p(d.ES), gc:p(d.GCE)}; })(),
    // Irrational/Unusual Rules panel: per-row {section,name,state,dir}. state from the
    // .rule-item status class (red=active / yellow=caution / green=none); dir from the
    // .direction svg path (up='M4 10…' / down='M4 6…'). The engine derives the sit-out gate.
    irr: (function(){
      var out=[];
      document.querySelectorAll('.rules-container').forEach(function(box){
        var sect=((box.querySelector('.title')||{}).textContent||'').trim();
        box.querySelectorAll('.rule-item').forEach(function(el){
          var nm=((el.querySelector('.rule-name')||{}).textContent||'').trim(); if(!nm) return;
          var cls=''+(el.className||'');
          var st=/status-red/.test(cls)?'red':/status-yellow/.test(cls)?'yellow':/status-green/.test(cls)?'green':null;
          var dr=null, p=el.querySelector('.direction svg path');
          if(p){ var d=''+(p.getAttribute('d')||''); dr=d.indexOf('M4 10')===0?'up':d.indexOf('M4 6')===0?'down':null; }
          out.push({section:sect, name:nm, state:st, dir:dr});
        });
      });
      return out.length?out:null;
    })()
  });
})()`;

function evalExpr(expr) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/json`, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => {
        let tab; try { const _pp = JSON.parse(b).filter(t => t.type === 'page' && (t.url || '').includes('rocket.place/pro-plus'));
          tab = _pp.find(t => /\/pro-plus\/?($|[?#])/.test(t.url)) || _pp.find(t => !/\/(settings|account|pricing|dashboard)/.test(t.url)) || _pp[0]; }
        catch (e) { return reject(new Error('cdp list parse')); }
        if (!tab) return reject(new Error('rocket pro-plus tab not found (debug Chrome open + logged in?)'));
        const ws = new WS(tab.webSocketDebuggerUrl, { maxPayload: 50 * 1024 * 1024 });
        const to = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('cdp eval timeout')); }, 6000);
        ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })));
        ws.on('message', m => { const msg = JSON.parse(m); if (msg.id === 1) { clearTimeout(to); try { ws.close(); } catch {} resolve(msg.result?.result?.value); } });
        ws.on('error', e => { clearTimeout(to); reject(e); });
      });
    }).on('error', reject);
  });
}

const resOk = v => v === null || Math.abs(v) < 500;
function sane(v) {
  if (v.dd !== null && (v.dd < 0 || v.dd > 1)) return false;
  for (const sym of ['nq', 'sp']) for (const k of ['redist', 'mhp', 'hp']) if (!resOk(v[sym][k])) return false;
  return true;
}
function buildUpdate(v) {
  const map = r => ({ redistResilience: r.redist, mhpResilience: r.mhp, hpResilience: r.hp, resilience: r.redist });
  const upd = { bySymbol: { NQ: map(v.nq), ES: map(v.sp) } };
  if (v.dd !== null) upd.ddRatio = v.dd;
  if (v.spyMhp != null) upd.spyMhp = v.spyMhp;  // SP500 MHP price → GM SPY>MHP leg (ES)
  if (v.qqqMhp != null) upd.qqqMhp = v.qqqMhp;  // NQ100 MHP price → GM QQQ>MHP leg (NQ)
  if (v.vxg) { upd.vxGammaHp = v.vxg.hp; upd.vxGammaMhp = v.vxg.mhp; }  // VX gamma levels (UVXY scale)
  if (v.irr) upd.irrational = v.irr;  // Irrational/Unusual panel states → engine sit-out gate
  if (v.dyn && v.dyn.nq) Object.assign(upd.bySymbol.NQ, { dynHpEtf: v.dyn.nq.hp, dynMhpEtf: v.dyn.nq.mhp, dynCloseEtf: v.dyn.nq.close });
  if (v.dyn && v.dyn.es) Object.assign(upd.bySymbol.ES, { dynHpEtf: v.dyn.es.hp, dynMhpEtf: v.dyn.es.mhp, dynCloseEtf: v.dyn.es.close });
  // Gold dyn HP/MHP on GLD ETF scale (same convention as NQ/ES dynHpEtf). GC has no
  // resilience element, so this is its only rs-feed contribution; the DD bands / HP / MHP
  // price lines come from rs-levels (chart shapes, gold-futures scale).
  if (v.dyn && v.dyn.gc) upd.bySymbol.GC = { dynHpEtf: v.dyn.gc.hp, dynMhpEtf: v.dyn.gc.mhp, dynCloseEtf: v.dyn.gc.close };
  Object.assign(upd, map(v.nq)); // global defaults mirror NQ (the symbol we trade)
  return upd;
}

async function tick() {
  const raw = await evalExpr(SCRAPE);
  if (!raw) throw new Error('empty scrape');
  const v = JSON.parse(raw);
  if (!sane(v)) throw new Error('insane values: ' + raw);
  const upd = buildUpdate(v);
  const reds = (v.irr || []).filter(r => r.state === 'red').map(r => `${r.name}${r.dir ? (r.dir === 'up' ? '↑' : '↓') : ''}`);
  log(`DD=${v.dd}  NQ[redist/mhp/hp]=${v.nq.redist}/${v.nq.mhp}/${v.nq.hp}  SP=${v.sp.redist}/${v.sp.mhp}/${v.sp.hp}` +
      (v.irr ? `  IRR[${reds.length}]${reds.length ? ' ' + reds.join(',') : ''}` : ''));
  const cur = fs.existsSync(CTX) ? JSON.parse(fs.readFileSync(CTX, 'utf8')) : {};
  // Deep-merge per-symbol so we preserve lmCode/mmBullish (written once-daily by
  // rs-levels) while refreshing the resiliences every 5s. Start from ALL existing
  // symbols so the ones rs-feed doesn't touch (CL, and GC's chart-derived levels) are
  // carried through instead of being dropped by this 5s write.
  const mergedBySym = { ...(cur.bySymbol || {}) };
  for (const s of Object.keys(upd.bySymbol)) mergedBySym[s] = { ...(cur.bySymbol && cur.bySymbol[s]), ...upd.bySymbol[s] };
  upd.bySymbol = mergedBySym;
  if (DRY) { log('WOULD MERGE:'); console.error(JSON.stringify(upd, null, 2));
    log(`preserve: greaterMarket=${cur.greaterMarket} lmCode=${cur.lmCode} vx=${cur.vx} bbb=${cur.bbb} vvix=${cur.vvix}`); return; }
  fs.writeFileSync(CTX, JSON.stringify({ ...cur, ...upd, tradingDay: etDate(), setAt: new Date().toISOString() }, null, 2));
}

(async () => {
  if (DRY) { try { await tick(); } catch (e) { log('ERROR', e.message); process.exit(1); } process.exit(0); }
  log(`rs-feed live — every ${INTERVAL / 1000}s during RTH (09:30–16:00 ET, Mon–Fri), CDP :${PORT} → ${CTX}`);
  let fails = 0, wasRTH = null;
  const run = async () => {
    const rth = inRTH();
    if (rth !== wasRTH) { log(rth ? 'RTH open — feeding' : 'outside RTH — idle (no scrape/write)'); wasRTH = rth; }
    if (!rth) return;  // off-hours: do nothing (process stays alive, cheap 5s tick)
    try { await tick(); fails = 0; } catch (e) { fails++; log(`ERROR (${fails})`, e.message); if (fails >= 6) log(`** ${fails} consecutive fails — rs-context is STALE **`); }
  };
  await run(); setInterval(run, INTERVAL);
})();
