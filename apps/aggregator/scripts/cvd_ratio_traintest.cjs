// cvd_ratio_traintest.cjs — does a long-side CVD-ratio floor hold OUT OF SAMPLE?
// Chronological day-split (first 70% of trading days = train, last 30% = test).
// Train: pick the ratio cut that maximizes KEPT EV while keeping >=50% of longs.
// Test: apply that exact cut; does it lift WR/EV on unseen days?  (WIN/LOSS only, no MFE/MAE)
const D = require('better-sqlite3');
const path = require('path');
const sig = new D(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const tk  = new D(path.resolve(__dirname, '../../../data/ticks.db'),  { readonly: true });
const BR = { 'clean-impulse': { tp: 80, sl: 55 }, 'cont-reentry': { tp: 80, sl: 70 } }; // LONG sl

const tkMin = tk.prepare('SELECT MIN(ts) a FROM trades WHERE symbol=?').get('NQ').a;
const sigs = sig.prepare(
  `SELECT signal_ts, rule_id, entry FROM tradable_signals
   WHERE qualified=1 AND symbol='NQ' AND direction='long'
     AND rule_id IN ('clean-impulse','cont-reentry') AND signal_ts >= ? ORDER BY signal_ts`).all(tkMin);
const cvdVolQ = tk.prepare('SELECT SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) cvd, SUM(size) v FROM trades WHERE symbol=? AND ts BETWEEN ? AND ?');
const entryQ  = tk.prepare('SELECT price FROM trades WHERE symbol=? AND ts >= ? ORDER BY ts LIMIT 1');
const walkQ   = tk.prepare('SELECT ts, price FROM trades WHERE symbol=? AND ts BETWEEN ? AND ? ORDER BY ts');
const open = ts => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 30, 0, 0).getTime(); };
const close = ts => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 15, 54, 0, 0).getTime(); };
const dstr = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

const rows = [];
for (const s of sigs) {
  const cv = cvdVolQ.get('NQ', open(s.signal_ts), s.signal_ts);
  if (!cv.v || cv.v <= 0 || cv.cvd == null) continue;
  const entry = s.entry != null ? s.entry : entryQ.get('NQ', s.signal_ts + 60000)?.price;
  if (entry == null) continue;
  const br = BR[s.rule_id], tp = br.tp, sl = br.sl;
  const ticks = walkQ.all('NQ', s.signal_ts + 60000, close(s.signal_ts));
  let pnl = null;
  for (const t of ticks) { if (t.price >= entry + tp) { pnl = tp; break; } if (t.price <= entry - sl) { pnl = -sl; break; } }
  if (pnl == null) continue; // OPEN — exclude
  rows.push({ ts: s.signal_ts, date: dstr(s.signal_ts), ratio: cv.cvd / cv.v, pnl });
}

const dates = [...new Set(rows.map(r => r.date))].sort();
const split = dates[Math.floor(dates.length * 0.7) - 1];
const train = rows.filter(r => r.date <= split), test = rows.filter(r => r.date > split);
const stat = set => { const n = set.length, w = set.filter(r => r.pnl > 0).length; const ev = n ? set.reduce((a, r) => a + r.pnl, 0) / n : 0; return { n, wr: n ? 100 * w / n : 0, ev }; };

console.log(`longs resolved ${rows.length} over ${dates.length} days; split <=${split} train / > test`);
console.log(`TRAIN ${train.length}  TEST ${test.length}`);

// Train: pick cut maximizing KEPT ev with >=50% kept
let best = null;
for (const cut of [...new Set(train.map(r => r.ratio))].sort((a,b)=>a-b)) {
  const kept = train.filter(r => r.ratio >= cut);
  if (kept.length < train.length * 0.5) break;
  const ev = stat(kept).ev;
  if (!best || ev > best.ev) best = { cut, ev, keptN: kept.length };
}
const cut = best.cut;
const tnK = stat(train.filter(r => r.ratio >= cut)), tnS = stat(train.filter(r => r.ratio < cut));
console.log(`\n[TRAIN] chosen ratio cut >= ${cut.toFixed(4)}`);
console.log(`  no-gate: n=${stat(train).n} WR ${stat(train).wr.toFixed(0)}% EV ${stat(train).ev.toFixed(1)}pt`);
console.log(`  kept:    n=${tnK.n} WR ${tnK.wr.toFixed(0)}% EV ${tnK.ev.toFixed(1)}pt   skipped: n=${tnS.n} WR ${tnS.wr.toFixed(0)}% EV ${tnS.ev.toFixed(1)}pt`);

const teAll = stat(test), teK = stat(test.filter(r => r.ratio >= cut)), teS = stat(test.filter(r => r.ratio < cut));
console.log(`\n[TEST] applying cut >= ${cut.toFixed(4)} to unseen days`);
console.log(`  no-gate: n=${teAll.n} WR ${teAll.wr.toFixed(0)}% EV ${teAll.ev.toFixed(1)}pt`);
console.log(`  kept:    n=${teK.n} WR ${teK.wr.toFixed(0)}% EV ${teK.ev.toFixed(1)}pt   skipped: n=${teS.n} WR ${teS.wr.toFixed(0)}% EV ${teS.ev.toFixed(1)}pt`);
console.log(`\n  GENERALIZES? kept EV ${teK.ev.toFixed(1)} vs no-gate ${teAll.ev.toFixed(1)}  → ${teK.ev>teAll.ev?'YES (gate improves OOS)':'NO (no OOS improvement)'}; skipped should be worst: ${teS.ev.toFixed(1)}pt`);
sig.close(); tk.close();
