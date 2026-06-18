// cvd_ratio_backtest.js — does a volume-scaled CVD imbalance ratio separate
// winners from losers better than the absolute floor (-1000 long / +3000 short)?
//
// For every qualified NQ FLIP/CONT signal in the ticks window:
//   ratio = cvd_session / cumVolume(09:30 ET -> signal)        [inferred tape]
//   outcome = no-lookahead walk-forward to the fixed bracket    [WIN/LOSS/OPEN]
// Then: WR by ratio bucket + WR of the current absolute floor, per direction.
const D = require('better-sqlite3');
const path = require('path');
const sig = new D(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const tk  = new D(path.resolve(__dirname, '../../../data/ticks.db'),  { readonly: true });

const BR = { 'clean-impulse': { tp: 80, sl: { long: 55, short: 105 } }, 'cont-reentry': { tp: 80, sl: 70 } };
const ABS_FLOOR = { long: -1000, short: 3000 };   // current hardcoded gate

const tkMin = tk.prepare('SELECT MIN(ts) a FROM trades WHERE symbol=?').get('NQ').a;
const sigs = sig.prepare(
  `SELECT signal_ts, direction, rule_id, entry, cvd_session
   FROM tradable_signals
   WHERE qualified=1 AND symbol='NQ' AND rule_id IN ('clean-impulse','cont-reentry')
     AND signal_ts >= ?
   ORDER BY signal_ts`).all(tkMin);

// CVD + volume backfilled from the tape (same as CvdSession.hydrate): 09:30 ET -> signal.
const cvdVolQ = tk.prepare('SELECT SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) cvd, SUM(size) v FROM trades WHERE symbol=? AND ts BETWEEN ? AND ?');
const entryQ  = tk.prepare('SELECT price FROM trades WHERE symbol=? AND ts >= ? ORDER BY ts LIMIT 1');
const walkQ   = tk.prepare('SELECT ts, price FROM trades WHERE symbol=? AND ts BETWEEN ? AND ? ORDER BY ts');

function sessionOpen(ts) { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 30, 0, 0).getTime(); }
function sessionClose(ts) { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 15, 54, 0, 0).getTime(); }

const rows = [];
let backfilled = 0;
for (const s of sigs) {
  const openMs = sessionOpen(s.signal_ts);
  const cv = cvdVolQ.get('NQ', openMs, s.signal_ts);   // backfill cvd + vol from the tape
  const vol = cv.v, cvd = cv.cvd;
  if (!vol || vol <= 0 || cvd == null) continue;
  if (s.cvd_session == null) backfilled++;
  const ratio = cvd / vol;                       // -1..+1 net imbalance
  const br = BR[s.rule_id]; const tp = br.tp; const sl = typeof br.sl === 'object' ? br.sl[s.direction] : br.sl;
  const long = s.direction === 'long';
  const entry = s.entry != null ? s.entry : entryQ.get('NQ', s.signal_ts + 60000)?.price;
  if (entry == null) continue;
  const tpPx = long ? entry + tp : entry - tp, slPx = long ? entry - sl : entry + sl;
  const ticks = walkQ.all('NQ', s.signal_ts + 60000, sessionClose(s.signal_ts));
  let out = 'OPEN';
  for (const t of ticks) {
    if (long) { if (t.price >= tpPx) { out = 'WIN'; break; } if (t.price <= slPx) { out = 'LOSS'; break; } }
    else      { if (t.price <= tpPx) { out = 'WIN'; break; } if (t.price >= slPx) { out = 'LOSS'; break; } }
  }
  if (out !== 'OPEN') rows.push({ dir: s.direction, ratio, cvd, out });
}

function wr(set) { const w = set.filter(r => r.out === 'WIN').length, l = set.length - w; return { n: set.length, w, l, wr: set.length ? (100 * w / set.length) : 0 }; }
function show(dir) {
  const set = rows.filter(r => r.dir === dir).sort((a, b) => a.ratio - b.ratio);
  if (!set.length) { console.log(`\n${dir.toUpperCase()}: none`); return; }
  const ov = wr(set);
  const be = dir === 'long' ? 'flip 40.7% / cont 46.7%' : 'flip 56.8% / cont 46.7%';
  console.log(`\n=== ${dir.toUpperCase()}  (n=${ov.n}, overall WR ${ov.wr.toFixed(1)}%)   breakeven WR≈ ${be} ===`);
  // ratio quintiles
  console.log('  ratio quintiles (low→high):');
  for (let i = 0; i < 5; i++) {
    const a = Math.floor(i * set.length / 5), b = Math.floor((i + 1) * set.length / 5);
    const bucket = set.slice(a, b); const s = wr(bucket);
    const lo = bucket[0].ratio, hi = bucket[bucket.length - 1].ratio;
    console.log(`    Q${i + 1} ratio ${lo.toFixed(4)}…${hi.toFixed(4)}  n=${s.n}  WR ${s.wr.toFixed(0)}% (${s.w}W/${s.l}L)`);
  }
  // current absolute floor
  const keep = dir === 'long' ? set.filter(r => r.cvd > ABS_FLOOR.long) : set.filter(r => r.cvd < ABS_FLOOR.short);
  const skip = dir === 'long' ? set.filter(r => r.cvd <= ABS_FLOOR.long) : set.filter(r => r.cvd >= ABS_FLOOR.short);
  console.log(`  ABSOLUTE floor (${dir==='long'?'cvd>-1000':'cvd<3000'}): kept ${wr(keep).wr.toFixed(0)}% (n=${keep.n})  vs skipped ${wr(skip).wr.toFixed(0)}% (n=${skip.n})`);
  // best ratio threshold by separation (in-sample) — skip the tail with low WR
  let best = null;
  for (const cut of set.map(r => r.ratio)) {
    const k = dir === 'long' ? set.filter(r => r.ratio >= cut) : set.filter(r => r.ratio <= cut);
    const sk = dir === 'long' ? set.filter(r => r.ratio < cut) : set.filter(r => r.ratio > cut);
    if (k.length < 15 || sk.length < 8) continue;
    const sep = wr(k).wr - wr(sk).wr;
    if (!best || sep > best.sep) best = { cut, sep, keep: wr(k), skip: wr(sk) };
  }
  if (best) console.log(`  BEST ratio cut ${dir==='long'?'≥':'≤'} ${best.cut.toFixed(4)}: keep ${best.keep.wr.toFixed(0)}% (n=${best.keep.n}) vs skip ${best.skip.wr.toFixed(0)}% (n=${best.skip.n})  sep ${best.sep.toFixed(0)}pp`);
}
console.log(`resolved ${rows.length}/${sigs.length} signals (${backfilled} cvd backfilled from tape; rest OPEN/no-data)`);
show('long'); show('short');
sig.close(); tk.close();
