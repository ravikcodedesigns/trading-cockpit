// Unit-check the FLIP/CONT signal-validation logic (decideSignal) + the INSERT schema,
// without touching the live workers. Two synthetic reads: a bid-defended long (→VALID) and
// a sell-sweep (→INVALID, SHORT stronger). Uses the REAL confirm().
import Database from 'better-sqlite3';
import { confirm, type L3Read, type CtxRead } from '../src/l3/decision-engine.js';
import type { Thesis } from '../src/l3/engine-thesis.js';

// (mirrors decideSignal helpers in l3-decision-worker.ts)
function l3ForDir(b: any, direction: 'long' | 'short'): L3Read {
  const defendSide: 'bid' | 'ask' = direction === 'long' ? 'bid' : 'ask';
  const s = b[defendSide];
  const sweepWith = b.sweep.swept && b.sweep.dir != null && ((direction === 'long') === (b.sweep.dir === 'buy'));
  const sweepAgainst = b.sweep.swept && b.sweep.dir != null && !sweepWith;
  return { defendSide, wall: s.wall, l3Size: s.l3, impliedGap: s.gap, nativeIce: s.ice, synthRefills: s.synth,
    executedNear: b.executedNear, cvd: b.cvd, cvd60: b.cvd60, aggrBuy: b.aggrBuy, aggrSell: b.aggrSell,
    pull: s.pull, adds: s.adds, sweepWith, sweepAgainst, clusterDominance: b.cluster.dominance };
}
const sigThesis = (direction: 'long' | 'short', level: number): Thesis => ({
  direction, bounceVsBreak: 'bounce', level, confluence: 1, engines: ['FLIP-' + direction], conflict: [],
  lmAgrees: null, sizeBase: 'M', baseProb: 0.5, entry: level, stop: 0, targets: [],
} as unknown as Thesis);
const ctx: CtxRead = { isRational: true, vxVolState: null, gateMode: 'normal', gateLongOnly: false, gateSizeDown: false, price: 0, ddUpper: null, ddLower: null };

function tagFor(b: any, dir: 'long' | 'short', pattern = 'FLIP') {
  const opp = dir === 'long' ? 'short' : 'long';
  const rDir = confirm(sigThesis(dir, 100), l3ForDir(b, dir), ctx);
  const rOpp = confirm(sigThesis(opp, 100), l3ForDir(b, opp), ctx);
  const valid = rDir.verdict === 'take';
  const opp_stronger = rOpp.confirmationScore > rDir.confirmationScore;
  return `${pattern} ${dir.toUpperCase()} ${valid ? 'VALID' : 'INVALID'} — ${opp.toUpperCase()} ${opp_stronger ? 'STRONGER' : 'weaker'} (${dir[0].toUpperCase()}=${rDir.confirmationScore}/${opp[0].toUpperCase()}=${rOpp.confirmationScore})`;
}

const bidDefended = { bid: { wall: 50, l3: 50, gap: 0, ice: 2, synth: 0, pull: 0, adds: 0 }, ask: { wall: 10, l3: 10, gap: 0, ice: 0, synth: 0, pull: 0, adds: 0 },
  cvd: 1000, cvd60: 200, aggrBuy: 100, aggrSell: 180, executedNear: 280, sweep: { swept: false, dir: null, levels: 0, size: 0 }, cluster: { dominance: 0.3 } };
const sellSweep = { bid: { wall: 5, l3: 5, gap: 0, ice: 0, synth: 0, pull: 30, adds: 0 }, ask: { wall: 40, l3: 40, gap: 0, ice: 0, synth: 0, pull: 0, adds: 0 },
  cvd: -800, cvd60: -200, aggrBuy: 20, aggrSell: 90, executedNear: 110, sweep: { swept: true, dir: 'sell', levels: 4, size: 60 }, cluster: { dominance: 0.6 } };

console.log('LOGIC:');
console.log('  bid-defended long :', tagFor(bidDefended, 'long'), '  (expect VALID)');
console.log('  sell-sweep long   :', tagFor(sellSweep, 'long'), '  (expect INVALID, SHORT stronger)');

// schema/INSERT column-match check against a temp DB
const db = new Database(':memory:');
db.exec(`CREATE TABLE l3_signal_validations (
  id INTEGER PRIMARY KEY, signal_id INTEGER UNIQUE, ts_ms INTEGER, ts_et TEXT, trading_day TEXT,
  symbol TEXT, pattern TEXT, direction TEXT, action TEXT, qualified INTEGER, entry REAL,
  tag TEXT, valid INTEGER, opp_stronger INTEGER, score_dir REAL, score_opp REAL,
  defend_side TEXT, wall INTEGER, l3_size INTEGER, implied_gap INTEGER, native_ice INTEGER, synth_refills INTEGER,
  executed_near INTEGER, cvd INTEGER, cvd60 INTEGER, aggr_buy INTEGER, aggr_sell INTEGER, pull INTEGER, adds INTEGER,
  sweep_with INTEGER, sweep_against INTEGER, cluster_dom REAL,
  confirms TEXT, vetoes TEXT, diagnostic TEXT, touch_ms INTEGER,
  outcome TEXT, pnl_pts REAL, resolved_at INTEGER)`);
const ins = db.prepare(`INSERT OR IGNORE INTO l3_signal_validations
  (signal_id,ts_ms,ts_et,trading_day,symbol,pattern,direction,action,qualified,entry,
   tag,valid,opp_stronger,score_dir,score_opp,defend_side,wall,l3_size,implied_gap,native_ice,synth_refills,
   executed_near,cvd,cvd60,aggr_buy,aggr_sell,pull,adds,sweep_with,sweep_against,cluster_dom,
   confirms,vetoes,diagnostic,touch_ms)
  VALUES (@signal_id,@ts_ms,@ts_et,@trading_day,@symbol,@pattern,@direction,@action,@qualified,@entry,
   @tag,@valid,@opp_stronger,@score_dir,@score_opp,@defend_side,@wall,@l3_size,@implied_gap,@native_ice,@synth_refills,
   @executed_near,@cvd,@cvd60,@aggr_buy,@aggr_sell,@pull,@adds,@sweep_with,@sweep_against,@cluster_dom,
   @confirms,@vetoes,@diagnostic,@touch_ms)`);
const row: any = { signal_id: 1, ts_ms: 1, ts_et: 'x', trading_day: 'd', symbol: 'NQ', pattern: 'FLIP', direction: 'long', action: 'OPEN', qualified: 1, entry: 100,
  tag: 'FLIP LONG VALID', valid: 1, opp_stronger: 0, score_dir: 5, score_opp: -1, defend_side: 'bid', wall: 50, l3_size: 50, implied_gap: 0, native_ice: 2, synth_refills: 0,
  executed_near: 280, cvd: 1000, cvd60: 200, aggr_buy: 100, aggr_sell: 180, pull: 0, adds: 0, sweep_with: 0, sweep_against: 0, cluster_dom: 0.3,
  confirms: '[]', vetoes: '[]', diagnostic: 'x', touch_ms: 1 };
ins.run(row);
console.log('\nINSERT schema check:', (db.prepare('SELECT COUNT(*) n FROM l3_signal_validations').get() as any).n === 1 ? 'OK (1 row)' : 'FAIL');
