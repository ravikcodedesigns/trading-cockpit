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
    // LM code per ticker from the scanner MASTER_TABLE (CPbook). QQQ→NQ, SPY→ES. Pure JS-object read
    // (no chart click / no DOM overlay) — moved here from rs-levels/rs-mm so every 5s tick carries fresh LM.
    lm: (function(){ try{ var mt=(((window.RS_SOCK||{}).scanner||{}).MASTER_TABLE||{}).data||{}; return {nq:(mt.QQQ||{}).CPbook||null, es:(mt.SPY||{}).CPbook||null}; }catch(e){ return null; } })(),
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
  if (v.lm && v.lm.nq) { upd.bySymbol.NQ.lmCode = v.lm.nq; upd.lmCode = v.lm.nq; }  // rs-feed now OWNS LM; global mirrors NQ
  if (v.lm && v.lm.es) upd.bySymbol.ES.lmCode = v.lm.es;
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

// ── atomic write (temp + rename so a reader never sees a partial file) ────────
function writeAtomic(file, str) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, str);
  fs.renameSync(tmp, file);   // atomic on the same filesystem
}

// ── generic CDP command (for Page.reload) over a fresh WS to the pro-plus tab ─
function cdp(method, params) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/json`, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => {
      let tab; try { const _pp = JSON.parse(b).filter(t => t.type === 'page' && (t.url || '').includes('rocket.place/pro-plus'));
        tab = _pp.find(t => /\/pro-plus\/?($|[?#])/.test(t.url)) || _pp.find(t => !/\/(settings|account|pricing|dashboard)/.test(t.url)) || _pp[0]; }
      catch (e) { return reject(new Error('cdp list parse')); }
      if (!tab) return reject(new Error('no pro-plus tab'));
      const ws = new WS(tab.webSocketDebuggerUrl, { maxPayload: 50 * 1024 * 1024 });
      const to = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('cdp timeout')); }, 8000);
      ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
      ws.on('message', m => { const msg = JSON.parse(m); if (msg.id === 1) { clearTimeout(to); try { ws.close(); } catch {} resolve(msg.result); } });
      ws.on('error', e => { clearTimeout(to); reject(e); });
    }); }).on('error', reject);
  });
}
// Hard reload of the rocket.place tab (≡ user pressing refresh; passive, no platform API).
// Wakes a page that loaded overnight with stale/empty scanner fields. Falls back to location.reload().
const reloadTab = () => cdp('Page.reload', { ignoreCache: true }).catch(() => evalExpr('location.reload();0').catch(() => {}));

// Dead-zero detector: the 06-29 partial-feed signature — DD AND all 3 NQ resiliences
// exactly 0 (platform rendered the scanner/MASTER_TABLE fields as 0). A real row never
// has all four at exactly 0, so this = BAD tick → never recorded, triggers reload logic.
const deadZero = v => v.dd === 0 && v.nq.redist === 0 && v.nq.mhp === 0 && v.nq.hp === 0;

// ── reload state-machine knobs ───────────────────────────────────────────────
const M_BAD = 3;                              // consecutive bad ticks before the FIRST reload (~15s)
const SETTLE_MS = 90_000;                     // after a reload, don't scrape/record (page re-rendering)
const BACKOFF = [90_000, 180_000, 300_000];   // extra cooldown before each subsequent reload (capped 5m)
const MAX_RELOADS = 4;                        // then stop reloading and ALARM for a human
const ALARM_EVERY = 60_000;
const KEEPALIVE_MS = 120_000;                 // synthetic mousemove every 2m so the platform's inactivity detector never suspends the page mid-session

// One passive scrape → parsed+sane values, or null on any failure (never throws).
async function scrapeOnce() {
  let raw; try { raw = await evalExpr(SCRAPE); } catch (e) { log('scrape error:', e.message); return null; }
  if (!raw) { log('empty scrape'); return null; }
  let v; try { v = JSON.parse(raw); } catch (e) { log('scrape parse error'); return null; }
  if (!sane(v)) { log('insane values:', raw); return null; }
  return v;
}

// Build + merge + ATOMIC write. Only ever called with a GOOD value (bad ticks are never recorded).
function record(v) {
  const upd = buildUpdate(v);
  const reds = (v.irr || []).filter(r => r.state === 'red').map(r => `${r.name}${r.dir ? (r.dir === 'up' ? '↑' : '↓') : ''}`);
  log(`DD=${v.dd}  NQ[redist/mhp/hp]=${v.nq.redist}/${v.nq.mhp}/${v.nq.hp}  SP=${v.sp.redist}/${v.sp.mhp}/${v.sp.hp}` +
      (v.irr ? `  IRR[${reds.length}]${reds.length ? ' ' + reds.join(',') : ''}` : ''));
  const cur = fs.existsSync(CTX) ? JSON.parse(fs.readFileSync(CTX, 'utf8')) : {};
  // Deep-merge per-symbol so we preserve lmCode/mmBullish (rs-levels/rs-mm) + carry through
  // symbols rs-feed doesn't touch (CL, GC chart levels). (Drops to own-file once the aggregator merge lands.)
  const mergedBySym = { ...(cur.bySymbol || {}) };
  for (const s of Object.keys(upd.bySymbol)) mergedBySym[s] = { ...(cur.bySymbol && cur.bySymbol[s]), ...upd.bySymbol[s] };
  upd.bySymbol = mergedBySym;
  if (DRY) { log('WOULD MERGE:'); console.error(JSON.stringify(upd, null, 2));
    log(`preserve: greaterMarket=${cur.greaterMarket} lmCode=${cur.lmCode} vx=${cur.vx} bbb=${cur.bbb} vvix=${cur.vvix}`); return; }
  // feedSetAt = rs-feed's OWN last write. setAt can also be bumped by vx-poller/extension (saveContext),
  // which would mask an rs-feed death; the staleness gate uses feedSetAt to detect rs-feed specifically.
  const now = new Date().toISOString();
  writeAtomic(CTX, JSON.stringify({ ...cur, ...upd, tradingDay: etDate(), setAt: now, feedSetAt: now }, null, 2));
}

(async () => {
  if (DRY) { const v = await scrapeOnce(); if (!v) { log('DRY: scrape failed'); process.exit(1); } record(v); process.exit(0); }
  log(`rs-feed live — every ${INTERVAL / 1000}s during RTH (09:30–16:00 ET, Mon–Fri), CDP :${PORT} → ${CTX}`);
  // Reload state machine: ignore single blips (M_BAD consecutive bad ticks before the first reload),
  // settle ~90s after each reload (page re-rendering), capped exponential backoff between reloads, and
  // ALARM (stop reloading, page a human) if MAX_RELOADS don't cure it. A bad tick is NEVER recorded —
  // the file keeps its last-good values and setAt freezes, which is itself the staleness signal.
  let wasRTH = null, badStreak = 0, reloadCount = 0, settleUntil = 0, nextReloadAt = 0, lastAlarm = 0, lastKeepAlive = 0;
  const run = async () => {
    const now = Date.now();
    const rth = inRTH();
    if (rth !== wasRTH) { log(rth ? 'RTH open — feeding' : 'outside RTH — idle'); wasRTH = rth; if (!rth) { badStreak = reloadCount = settleUntil = 0; } }
    if (!rth) return;
    if (now < settleUntil) return;                                  // page mid-reload — do nothing
    // Keep-alive: a synthetic mousemove (real browser input) every KEEPALIVE_MS so the platform's
    // inactivity detector never suspends the page mid-session. Fire-and-forget; if the page is already
    // unresponsive the scrape below catches it and the reload SM recovers.
    if (now - lastKeepAlive >= KEEPALIVE_MS) { lastKeepAlive = now; cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 }).catch(() => {}); }

    const v = await scrapeOnce();
    if (!(!v || deadZero(v))) {                                     // GOOD → record + reset
      if (reloadCount || badStreak) log(`recovered → healthy (after ${badStreak} bad, ${reloadCount} reload${reloadCount === 1 ? '' : 's'})`);
      record(v); badStreak = 0; reloadCount = 0; nextReloadAt = 0; return;
    }

    badStreak++;                                                   // BAD → never record
    log(`bad tick (${badStreak}) — ${!v ? 'scrape failed' : 'dead-zero (DD+resiliences all 0)'}; not recording`);
    if (reloadCount >= MAX_RELOADS) {                              // ALARM — reloads didn't cure it
      if (now - lastAlarm >= ALARM_EVERY) { log(`** STALE: ${reloadCount} reloads did not recover the feed — MANUAL CHECK (logged out / offline / unresponsive?) **`); lastAlarm = now; }
      return;
    }
    const reloadDue = reloadCount === 0 ? badStreak >= M_BAD : now >= nextReloadAt;
    if (reloadDue) {
      reloadCount++;
      log(`reload #${reloadCount} — bad ${badStreak} ticks; reloading platform, settle ${SETTLE_MS / 1000}s`);
      try { await reloadTab(); } catch (e) { log('reload failed:', e.message); }
      settleUntil = now + SETTLE_MS;
      nextReloadAt = settleUntil + BACKOFF[Math.min(reloadCount - 1, BACKOFF.length - 1)];
      badStreak = 0;
    }
  };
  await run(); setInterval(run, INTERVAL);
})();
