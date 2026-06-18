// alignment_validate.cjs — is the "prior-30min momentum aligns" edge real?
// (1) chronological train/test (first 70% days train), (2) permutation test on the full set.
// WIN/LOSS via no-lookahead walk-forward to the fixed bracket. No MFE/MAE.
const D = require('better-sqlite3');
const path = require('path');
const sig = new D(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const tk  = new D(path.resolve(__dirname, '../../../data/ticks.db'),  { readonly: true });
const BR = { 'clean-impulse': { tp: 80, sl: { long: 55, short: 105 } }, 'cont-reentry': { tp: 80, sl: 70 } };
const tkMin = tk.prepare('SELECT MIN(ts) a FROM trades WHERE symbol=?').get('NQ').a;
const sigs = sig.prepare(
  `SELECT signal_ts, direction, rule_id, entry FROM tradable_signals
   WHERE qualified=1 AND symbol='NQ' AND rule_id IN ('clean-impulse','cont-reentry') AND signal_ts >= ? ORDER BY signal_ts`).all(tkMin);
const firstTick = tk.prepare('SELECT price FROM trades WHERE symbol=? AND ts >= ? ORDER BY ts LIMIT 1');
const lastTick  = tk.prepare('SELECT price FROM trades WHERE symbol=? AND ts <= ? ORDER BY ts DESC LIMIT 1');
const walkQ = tk.prepare('SELECT price FROM trades WHERE symbol=? AND ts BETWEEN ? AND ? ORDER BY ts');
const close = ts => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 15, 54, 0, 0).getTime(); };
const dstr = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

const rows = [];
for (const s of sigs) {
  const entry = s.entry != null ? s.entry : firstTick.get('NQ', s.signal_ts + 60000)?.price;
  if (entry == null) continue;
  const br = BR[s.rule_id], tp = br.tp, sl = typeof br.sl === 'object' ? br.sl[s.direction] : br.sl;
  const long = s.direction === 'long';
  let pnl = null;
  for (const t of walkQ.all('NQ', s.signal_ts + 60000, close(s.signal_ts))) {
    if (long ? t.price >= entry + tp : t.price <= entry - tp) { pnl = tp; break; }
    if (long ? t.price <= entry - sl : t.price >= entry + sl) { pnl = -sl; break; }
  }
  if (pnl == null) continue;
  const p30 = lastTick.get('NQ', s.signal_ts - 30 * 60000)?.price;
  if (p30 == null) continue;
  const aligned = long ? entry > p30 : entry < p30;
  rows.push({ date: dstr(s.signal_ts), aligned, win: pnl > 0, pnl });
}

const stat = set => { const n = set.length, w = set.filter(r => r.win).length; return { n, wr: n ? 100 * w / n : 0, ev: n ? set.reduce((a, r) => a + r.pnl, 0) / n : 0 }; };
const f = s => `WR ${s.wr.toFixed(0)}% EV ${s.ev.toFixed(1)} (n=${s.n})`;
console.log(`resolved w/ alignment: ${rows.length}`);

// (1) chronological split
const dates = [...new Set(rows.map(r => r.date))].sort();
const splitDate = dates[Math.floor(dates.length * 0.7) - 1];
const tr = rows.filter(r => r.date <= splitDate), te = rows.filter(r => r.date > splitDate);
console.log(`\n=== CHRONOLOGICAL (train <=${splitDate}: ${tr.length} / test: ${te.length}) ===`);
console.log(`  TRAIN aligned ${f(stat(tr.filter(r=>r.aligned)))} | countertrend ${f(stat(tr.filter(r=>!r.aligned)))}`);
console.log(`  TEST  aligned ${f(stat(te.filter(r=>r.aligned)))} | countertrend ${f(stat(te.filter(r=>!r.aligned)))}`);

// (2) permutation test on the full set — is WR(aligned) - WR(counter) beyond chance?
const A = rows.filter(r => r.aligned), C = rows.filter(r => !r.aligned);
const obs = stat(A).wr - stat(C).wr;
const wins = rows.map(r => r.win);                 // outcomes fixed
const nA = A.length, N = rows.length, PERM = 20000;
let ge = 0, geAbs = 0;
for (let p = 0; p < PERM; p++) {
  // randomly choose nA "aligned" indices, compute WR diff under the null
  const idx = wins.map((_, i) => i);
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  let wa = 0; for (let i = 0; i < nA; i++) if (wins[idx[i]]) wa++;
  let wc = 0; for (let i = nA; i < N; i++) if (wins[idx[i]]) wc++;
  const diff = (100 * wa / nA) - (100 * wc / (N - nA));
  if (diff >= obs) ge++;
  if (Math.abs(diff) >= Math.abs(obs)) geAbs++;
}
console.log(`\n=== PERMUTATION (full set, ${PERM} shuffles) ===`);
console.log(`  observed WR(aligned ${stat(A).wr.toFixed(0)}%) - WR(counter ${stat(C).wr.toFixed(0)}%) = ${obs.toFixed(1)}pp`);
console.log(`  p one-sided (aligned better) = ${(ge / PERM).toFixed(4)}   two-sided = ${(geAbs / PERM).toFixed(4)}`);
sig.close(); tk.close();
