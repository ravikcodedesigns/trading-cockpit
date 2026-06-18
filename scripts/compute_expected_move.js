// compute_expected_move.js — desk-standard implied-move bands for NQ.
//
//   1σ daily move = priorSettle × (VXN/100) / √252      (VXN = Nasdaq-100 implied vol)
//   bands = mid (prior settle) ± 1σ and ± 2σ
//
// Anchored to the PRIOR SETTLEMENT (PDC from daily_levels = cockpit MNQU26 close,
// falls back to Yahoo NQ=F prior settle). VXN live from Yahoo ^VXN. Writes the 5
// levels into daily_levels.json (so the chart draws them) AND the band into
// rs-context.json (for the header chip). DRY_RUN=1 prints only.
const fs = require('fs');
const path = require('path');
const LV  = path.resolve(__dirname, '../daily_levels.json');
const CTX = path.resolve(__dirname, '../data/rs-context.json');
const DRY = process.env.DRY_RUN === '1';
const log = (...a) => console.error(new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }) + ' ET', ...a);

async function yf(ticker) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`yahoo ${ticker} ${r.status}`);
  const m = (await r.json()).chart.result[0].meta;
  return { price: m.regularMarketPrice, prev: m.chartPreviousClose };
}

(async () => {
  const doc = JSON.parse(fs.readFileSync(LV, 'utf8'));
  const days = doc.days || {};
  const date = Object.keys(days).sort().pop();
  const lv = days[date].levels.find(x => x.symbol === 'NQ');
  if (!lv) throw new Error('no NQ entry for ' + date);

  // Prior settlement: PDC (cockpit MNQU26 close) preferred; Yahoo NQ=F fallback.
  const nq = await yf('NQ%3DF');
  let settle = (lv.additionalLevels || []).find(a => a.label === 'PDC')?.price ?? nq.prev;
  if (Math.abs(settle - nq.prev) > 200) log(`WARN: PDC ${settle} vs NQ=F prior settle ${nq.prev} differ >200pt — check contract/date`);

  const vxn = (await yf('%5EVXN')).price;
  if (!(vxn > 0) || !(settle > 0)) throw new Error(`bad inputs settle=${settle} vxn=${vxn}`);

  const s1 = settle * (vxn / 100) / Math.sqrt(252);
  const s2 = 2 * s1;
  const r = v => +v.toFixed(2);
  const em = [
    { price: r(settle),      label: 'EM Mid', color: '#9aa0a6', style: 'dashed', width: 1 },
    { price: r(settle + s1), label: 'EM +1σ', color: '#4a90d9', style: 'solid',  width: 1 },
    { price: r(settle - s1), label: 'EM −1σ', color: '#4a90d9', style: 'solid',  width: 1 },
    { price: r(settle + s2), label: 'EM +2σ', color: '#7e6bc4', style: 'dotted', width: 1 },
    { price: r(settle - s2), label: 'EM −2σ', color: '#7e6bc4', style: 'dotted', width: 1 },
  ];
  log(`NQ EM [${date}]  settle=${r(settle)}  VXN=${vxn}  1σ=${s1.toFixed(0)}pt  ±1σ ${r(settle - s1)}–${r(settle + s1)}  ±2σ ${r(settle - s2)}–${r(settle + s2)}`);
  if (DRY) { log('DRY — no writes'); return; }

  // daily_levels — replace any prior EM levels, keep everything else.
  const EM = new Set(em.map(e => e.label));
  lv.additionalLevels = [...(lv.additionalLevels || []).filter(a => !EM.has(a.label)), ...em];
  fs.writeFileSync(LV, JSON.stringify(doc, null, 2));

  // rs-context — band for the header chip (preserve all other fields).
  let ctx = {}; try { ctx = JSON.parse(fs.readFileSync(CTX, 'utf8')); } catch (e) {}
  ctx.vxn = vxn;
  ctx.expectedRangePts = Math.round(s2);     // ±1σ band width (high − low)
  ctx.emMid = r(settle);
  ctx.em1Low = r(settle - s1); ctx.em1High = r(settle + s1);
  ctx.em2Low = r(settle - s2); ctx.em2High = r(settle + s2);
  fs.writeFileSync(CTX, JSON.stringify(ctx, null, 2));
  log('wrote daily_levels (5 EM lines) + rs-context (vxn, expectedRangePts, em bands)');
})().catch(e => { log('ERROR', e.message); process.exit(1); });
