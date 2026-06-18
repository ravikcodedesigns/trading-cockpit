// feature_scan.cjs — do theory-backed bar features separate winners OOS?
// Features per signal: (1) prior-30min alignment, (2) distance to nearest daily level,
// (3) intraday trend-efficiency (open→signal). Random 100 train / rest test (seeded).
// WIN/LOSS via no-lookahead walk-forward to the fixed bracket. No MFE/MAE.
const D = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const sig = new D(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const tk  = new D(path.resolve(__dirname, '../../../data/ticks.db'),  { readonly: true });
const BR = { 'clean-impulse': { tp: 80, sl: { long: 55, short: 105 } }, 'cont-reentry': { tp: 80, sl: 70 } };

// daily levels per date (NQ) -> flat price list
const lv = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../daily_levels.json'), 'utf8')).days;
const levelsByDate = {};
for (const [date, d] of Object.entries(lv)) {
  const nq = (d.levels || []).find(x => x.symbol === 'NQ'); if (!nq) continue;
  const ps = [];
  (nq.additionalLevels || []).forEach(a => ps.push(a.price));
  if (nq.bullZone) ps.push(nq.bullZone.low, nq.bullZone.high);
  if (nq.bearZone) ps.push(nq.bearZone.low, nq.bearZone.high);
  if (nq.ddBands) ps.push(nq.ddBands.upper, nq.ddBands.lower);
  if (nq.hedgePressure) ps.push(nq.hedgePressure); if (nq.mhp) ps.push(nq.mhp);
  (nq.zones?.bull || []).forEach(z => ps.push(z.low, z.high));
  (nq.zones?.bear || []).forEach(z => ps.push(z.low, z.high));
  levelsByDate[date] = ps.filter(p => p != null);
}

const tkMin = tk.prepare('SELECT MIN(ts) a FROM trades WHERE symbol=?').get('NQ').a;
const sigs = sig.prepare(
  `SELECT signal_ts, direction, rule_id, entry FROM tradable_signals
   WHERE qualified=1 AND symbol='NQ' AND rule_id IN ('clean-impulse','cont-reentry') AND signal_ts >= ? ORDER BY signal_ts`).all(tkMin);
const firstTick = tk.prepare('SELECT price FROM trades WHERE symbol=? AND ts >= ? ORDER BY ts LIMIT 1');
const lastTick  = tk.prepare('SELECT price FROM trades WHERE symbol=? AND ts <= ? ORDER BY ts DESC LIMIT 1');
const rng = tk.prepare('SELECT MIN(price) lo, MAX(price) hi FROM trades WHERE symbol=? AND ts BETWEEN ? AND ?');
const walkQ = tk.prepare('SELECT ts, price FROM trades WHERE symbol=? AND ts BETWEEN ? AND ? ORDER BY ts');
const open = ts => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 30, 0, 0).getTime(); };
const close = ts => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 15, 54, 0, 0).getTime(); };
const dstr = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

const rows = [];
for (const s of sigs) {
  const entry = s.entry != null ? s.entry : firstTick.get('NQ', s.signal_ts + 60000)?.price;
  if (entry == null) continue;
  const br = BR[s.rule_id], tp = br.tp, sl = typeof br.sl === 'object' ? br.sl[s.direction] : br.sl;
  const long = s.direction === 'long';
  const ticks = walkQ.all('NQ', s.signal_ts + 60000, close(s.signal_ts));
  let pnl = null;
  for (const t of ticks) { if (long ? t.price >= entry + tp : t.price <= entry - tp) { pnl = tp; break; } if (long ? t.price <= entry - sl : t.price >= entry + sl) { pnl = -sl; break; } }
  if (pnl == null) continue;
  // features
  const p30 = lastTick.get('NQ', s.signal_ts - 30 * 60000)?.price;
  const aligned = p30 == null ? null : (long ? entry > p30 : entry < p30);
  const lvs = levelsByDate[dstr(s.signal_ts)] || [];
  const dist = lvs.length ? Math.min(...lvs.map(p => Math.abs(entry - p))) : null;
  const o = firstTick.get('NQ', open(s.signal_ts))?.price; const r = rng.get('NQ', open(s.signal_ts), s.signal_ts);
  const eff = (o != null && r && r.hi > r.lo) ? Math.abs(entry - o) / (r.hi - r.lo) : null;  // 0..1 trend efficiency
  rows.push({ aligned, dist, eff, pnl, win: pnl > 0 });
}

// seeded shuffle (reproducible)
let seed = 12345; const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const sh = rows.slice(); for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
const train = sh.slice(0, 100), test = sh.slice(100);
const stat = set => { const n = set.length, w = set.filter(r => r.win).length; return { n, wr: n ? 100 * w / n : 0, ev: n ? set.reduce((a, r) => a + r.pnl, 0) / n : 0 }; };
console.log(`resolved ${rows.length}; train 100 / test ${test.length}`);

function evalFeat(name, goodFn) {
  const tg = train.filter(r => goodFn(r) === true), tb = train.filter(r => goodFn(r) === false);
  const eg = test.filter(r => goodFn(r) === true),  eb = test.filter(r => goodFn(r) === false);
  const f = s => `WR ${s.wr.toFixed(0)}% EV ${s.ev.toFixed(1)} (n=${s.n})`;
  console.log(`\n${name}`);
  console.log(`  TRAIN good ${f(stat(tg))}  | bad ${f(stat(tb))}`);
  console.log(`  TEST  good ${f(stat(eg))}  | bad ${f(stat(eb))}  -> ${stat(eg).ev>stat(eb).ev?'holds OOS':'FAILS OOS'}`);
}
// thresholds from TRAIN only
const med = (set, k) => { const v = set.map(r => r[k]).filter(x => x != null).sort((a, b) => a - b); return v[Math.floor(v.length/2)]; };
const distMed = med(train, 'dist'), effMed = med(train, 'eff');
console.log(`(train medians: dist=${distMed?.toFixed(1)}  eff=${effMed?.toFixed(2)})`);
evalFeat('1) ALIGNMENT (prior-30min momentum agrees)', r => r.aligned);
evalFeat(`2) NEAR A LEVEL (dist < ${distMed?.toFixed(1)}pt)`, r => r.dist == null ? null : r.dist < distMed);
evalFeat(`3) TREND-EFFICIENCY (eff > ${effMed?.toFixed(2)})`, r => r.eff == null ? null : r.eff > effMed);
sig.close(); tk.close();
