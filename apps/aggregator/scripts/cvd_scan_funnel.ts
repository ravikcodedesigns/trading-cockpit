/**
 * cvd_scan_funnel.ts — raw → qualified → tradable funnel on ONE trade tape.
 *
 * SANDBOX. Reads trades from INPUT_DB (env), writes ONLY a JSON result file
 * (OUTPUT_JSON env). Touches no live DB. Mirrors live detection+gate logic:
 *   - FLIP detect  = strategy-h.ts detect() (exact thresholds, incl compPos>=-0.05)
 *   - CONT detect  = strategy-cont.ts detect() (note: delta = askVol-bidVol)
 *   - tod/cooldown = strategy-h.ts runStrategyH gates
 *   - quality      = quality.ts (FLIP long delta15<500; |delta5| wrong-dir>=1000)
 *   - actionability= config.ts cvdLongFloor -1000 / cvdShortFloor 3000
 *   - cvdSession   = cvd-session.ts (RTH-anchored SUM(is_bid_aggressor?+:-)size)
 *   - outcome      = walk-forward TP/SL on the same tape, 15:54 ET -> DRAW
 * Run twice (live ticks.db vs MBO-true) — identical code, only the tape differs.
 *
 * NOT applied (price-based, ~identical across tapes, cancels in the arm diff;
 * documented): ORM/regime isSignalAllowed. isShortHourlyAligned IS applied.
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'fs';

const INPUT_DB = process.env.INPUT_DB!;
const OUTPUT_JSON = process.env.OUTPUT_JSON!;
if (!INPUT_DB || !OUTPUT_JSON) { console.error('need INPUT_DB + OUTPUT_JSON'); process.exit(1); }

const MIN_1 = 60_000;
const MACRO_N = 30;
const COOLDOWN_MS = 15 * MIN_1;
const CROSS_COOLDOWN_MS = 45 * MIN_1;
// FLIP
const BODY_MIN = 5.0;
const FLIP_COMP_MIN_LONG = -0.05, FLIP_COMP_MAX_LONG = 0.30, FLIP_DELTA_T_LONG = 300, FLIP_PRIOR3_LONG = -100;
const FLIP_COMP_MIN_SHORT_HIGH = 0.50, FLIP_COMP_MAX_SHORT_HIGH = 1.00, FLIP_WICK_MIN_SHORT = 15.0;
const FLIP_PRIOR_IMPULSE_SHORT = 1400, FLIP_DELTA_T_SHORT_MAX = 300, FLIP_BAR_RANGE_MIN_SHORT = 22.0;
// CONT
const CONT_COOLDOWN_MS = 30 * MIN_1, PARENT_WINDOW = 90 * MIN_1;
const MIN_EXTENSION = 60, RETRACE_MIN = 0.25, RETRACE_MAX = 0.48;
const DELTA_REALIGN = 600, DELTA_BAR_MIN = 100, OPEN_GATE_MIN = 600;
// quality + actionability
const Q_DELTA15_LONG_MAX = 500, Q_DELTA5_ABS = 1000;
const CVD_LONG_FLOOR = -1000, CVD_SHORT_FLOOR = 3000;
// TP/SL
const TPSL: Record<string, { tp: number; slLong: number; slShort: number }> = {
  'clean-impulse': { tp: 80, slLong: 55, slShort: 105 },
  'cont-reentry': { tp: 80, slLong: 70, slShort: 70 },
};

const DAYS = ['2026-06-02','2026-06-03','2026-06-04','2026-06-05','2026-06-08','2026-06-09','2026-06-10','2026-06-11','2026-06-12','2026-06-15','2026-06-16'];

interface Trade { ts: number; price: number; size: number; is_bid_aggressor: number; }
interface Bar { ts: number; open: number; high: number; low: number; close: number; vol: number; delta: number; }

function rth(day: string) {
  const [y, m, d] = day.split('-').map(Number);
  return { start: Date.UTC(y, m - 1, d, 13, 30), end: Date.UTC(y, m - 1, d, 20, 0), close: Date.UTC(y, m - 1, d, 19, 54) };
}
function etMin(tsMs: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(tsMs));
  return parseInt(p.find(x => x.type === 'hour')!.value, 10) * 60 + parseInt(p.find(x => x.type === 'minute')!.value, 10);
}
function isLongTimeAllowed(tsMs: number): boolean { const e = etMin(tsMs); if (e < 594) return false; if (e >= 870 && e < 960) return false; return true; }

function buildBars(trades: Trade[], sign: 'h' | 'cont'): Bar[] {
  const m = new Map<number, { open: number; close: number; high: number; low: number; bidVol: number; askVol: number }>();
  for (const t of trades) {
    const b = Math.floor(t.ts / MIN_1) * MIN_1;
    const bar = m.get(b);
    if (!bar) m.set(b, { open: t.price, close: t.price, high: t.price, low: t.price, bidVol: t.is_bid_aggressor === 1 ? t.size : 0, askVol: t.is_bid_aggressor === 0 ? t.size : 0 });
    else { bar.high = Math.max(bar.high, t.price); bar.low = Math.min(bar.low, t.price); bar.close = t.price; if (t.is_bid_aggressor === 1) bar.bidVol += t.size; else bar.askVol += t.size; }
  }
  return [...m.entries()].sort(([a], [b]) => a - b).map(([ts, b]) => ({ ts, open: b.open, high: b.high, low: b.low, close: b.close, vol: b.bidVol + b.askVol, delta: sign === 'h' ? b.bidVol - b.askVol : b.askVol - b.bidVol }));
}

interface Flip { dir: 'long' | 'short'; score: number; compPos: number; deltaT: number; delta5: number; delta15: number; deltaLast3: number; entry: number; barTs: number; }
function detectFlip(bars: Bar[], idx: number): Flip | null {
  if (idx < MACRO_N) return null;
  const cur = bars[idx]; if (!cur) return null;
  const macro = bars.slice(idx - MACRO_N, idx); if (macro.length < MACRO_N) return null;
  const hi = Math.max(...macro.map(b => b.high)), lo = Math.min(...macro.map(b => b.low)), range = hi - lo;
  const compPos = range > 0 ? (cur.low - lo) / range : 0.5;
  const compPosHigh = range > 0 ? (cur.high - lo) / range : 0.5;
  const delta15 = bars.slice(Math.max(0, idx - 15), idx).reduce((s, b) => s + b.delta, 0);
  const delta5 = bars.slice(Math.max(0, idx - 5), idx).reduce((s, b) => s + b.delta, 0);
  const deltaLast3 = bars.slice(Math.max(0, idx - 3), idx).reduce((s, b) => s + b.delta, 0);
  const deltaT = cur.delta;
  const priorImpulse = Math.max(bars[idx - 1]?.delta ?? 0, bars[idx - 2]?.delta ?? 0);
  const bodyLong = cur.close - cur.open, bodyShort = cur.open - cur.close, upperWick = cur.high - cur.close;
  if (bodyLong >= BODY_MIN && deltaT >= FLIP_DELTA_T_LONG && compPos >= FLIP_COMP_MIN_LONG && compPos <= FLIP_COMP_MAX_LONG && deltaLast3 <= FLIP_PRIOR3_LONG) {
    let s = 80; if (deltaT >= 500) s += 10; else if (deltaT >= 400) s += 5; if (bodyLong >= 15) s += 5; if (compPos <= 0.15) s += 5;
    return { dir: 'long', score: Math.min(100, s), compPos, deltaT, delta5, delta15, deltaLast3, entry: cur.close, barTs: cur.ts };
  }
  if (bodyShort >= BODY_MIN && upperWick >= FLIP_WICK_MIN_SHORT && compPosHigh >= FLIP_COMP_MIN_SHORT_HIGH && compPosHigh <= FLIP_COMP_MAX_SHORT_HIGH && priorImpulse >= FLIP_PRIOR_IMPULSE_SHORT && deltaT <= FLIP_DELTA_T_SHORT_MAX && (cur.high - cur.low) >= FLIP_BAR_RANGE_MIN_SHORT) {
    let s = 80; if (bodyShort >= 15) s += 5; if (upperWick >= 20) s += 5; if (compPosHigh >= 0.80) s += 5; if (priorImpulse >= 2000) s += 5;
    return { dir: 'short', score: Math.min(100, s), compPos: compPosHigh, deltaT, delta5, delta15, deltaLast3, entry: cur.close, barTs: cur.ts };
  }
  return null;
}
// quality gate for FLIP (returns true = gold/qualified)
function flipQualifies(f: Flip): boolean {
  if (f.dir === 'long' && f.delta15 >= Q_DELTA15_LONG_MAX) return false;
  const d5ok = f.dir === 'short' ? f.delta5 >= Q_DELTA5_ABS : f.delta5 <= -Q_DELTA5_ABS;
  return d5ok;
}
// short hourly alignment: last complete 1h bar red (close<open) on this tape
function shortHourlyAligned(trades: Trade[], tsMs: number): boolean {
  const HR = 60 * MIN_1; const barStart = Math.floor(tsMs / HR) * HR - HR;
  const seg = trades.filter(t => t.ts >= barStart && t.ts < barStart + HR);
  if (seg.length < 2) return true;
  return seg[seg.length - 1]!.price < seg[0]!.price;
}

function walkForward(trades: Trade[], entryTs: number, entry: number, dir: 'long' | 'short', tp: number, sl: number, closeMs: number): { o: string; pnl: number } {
  let tpHit = Infinity, slHit = Infinity, lastPx = entry;
  for (const t of trades) {
    if (t.ts < entryTs) continue;
    if (t.ts >= closeMs) break;
    lastPx = t.price;
    if (dir === 'long') { if (t.price >= entry + tp && tpHit === Infinity) tpHit = t.ts; if (t.price <= entry - sl && slHit === Infinity) slHit = t.ts; }
    else { if (t.price <= entry - tp && tpHit === Infinity) tpHit = t.ts; if (t.price >= entry + sl && slHit === Infinity) slHit = t.ts; }
    if (tpHit !== Infinity || slHit !== Infinity) break;
  }
  if (tpHit === Infinity && slHit === Infinity) { const pnl = dir === 'long' ? lastPx - entry : entry - lastPx; return { o: 'DRAW', pnl }; }
  if (tpHit <= slHit) return { o: 'WIN', pnl: tp };
  return { o: 'LOSS', pnl: -sl };
}

const db = new Database(INPUT_DB, { readonly: true });
const out: any[] = [];

for (const day of DAYS) {
  const { start, end, close } = rth(day);
  const pre = start - MACRO_N * MIN_1;
  const trades = db.prepare(`SELECT ts,price,size,is_bid_aggressor FROM trades WHERE symbol='NQ' AND ts>=? AND ts<? ORDER BY ts ASC`).all(pre, end) as Trade[];
  if (trades.length < 1000) { continue; }
  const rthTrades = trades.filter(t => t.ts >= start);
  // cumulative true/inferred cvd over RTH for the cvdSession lookup
  let cum = 0; const cumTs: number[] = []; const cumVal: number[] = [];
  for (const t of rthTrades) { cum += t.is_bid_aggressor === 1 ? t.size : -t.size; cumTs.push(t.ts); cumVal.push(cum); }
  const cvdAt = (ts: number): number => { let l = 0, r = cumTs.length - 1, ans = -1; while (l <= r) { const m = (l + r) >> 1; if (cumTs[m]! <= ts) { ans = m; l = m + 1; } else r = m - 1; } return ans < 0 ? 0 : cumVal[ans]!; };

  const hBars = buildBars(trades, 'h');
  const cBars = buildBars(trades, 'cont');
  const lastSig: Record<string, number> = { long: 0, short: 0 };

  // ── FLIP funnel ──
  const qualifiedFlips: { dir: 'long' | 'short'; entry: number; ts: number }[] = [];
  for (let i = MACRO_N; i < hBars.length; i++) {
    const bar = hBars[i]!; if (bar.ts < start || bar.ts >= end) continue;
    const f = detectFlip(hBars, i); if (!f) continue;
    const trigTs = bar.ts + MIN_1;
    const rec: any = { day, rule: 'clean-impulse', dir: f.dir, barTs: bar.ts, trigTs, entry: f.entry, score: f.score, deltaT: f.deltaT, delta5: f.delta5, delta15: f.delta15, deltaLast3: f.deltaLast3, stage: 'raw' };
    // tod gate
    if (f.dir === 'long' && !isLongTimeAllowed(trigTs)) { rec.stage = 'raw_tod_blocked'; out.push(rec); continue; }
    if (f.dir === 'short' && !shortHourlyAligned(trades, trigTs)) { rec.stage = 'raw_hourly_blocked'; out.push(rec); continue; }
    // cooldown
    if (bar.ts - (lastSig[f.dir] ?? 0) < COOLDOWN_MS) { rec.stage = 'raw_cooldown'; out.push(rec); continue; }
    if (f.dir === 'long' && bar.ts - (lastSig['short'] ?? 0) < CROSS_COOLDOWN_MS) { rec.stage = 'raw_cooldown'; out.push(rec); continue; }
    lastSig[f.dir] = bar.ts;
    rec.stage = 'detected';
    // quality
    if (!flipQualifies(f)) { rec.stage = 'silenced'; out.push(rec); continue; }
    rec.stage = 'qualified';
    // actionability (cvd)
    const cvd = cvdAt(trigTs); rec.cvdSession = cvd;
    if (f.dir === 'long' && cvd <= CVD_LONG_FLOOR) { rec.stage = 'skip_cvd'; out.push(rec); qualifiedFlips.push({ dir: f.dir, entry: f.entry, ts: trigTs }); continue; }
    if (f.dir === 'short' && cvd >= CVD_SHORT_FLOOR) { rec.stage = 'skip_cvd'; out.push(rec); qualifiedFlips.push({ dir: f.dir, entry: f.entry, ts: trigTs }); continue; }
    rec.stage = 'tradable';
    const ps = TPSL['clean-impulse']!; const wf = walkForward(rthTrades, trigTs, f.entry, f.dir, ps.tp, f.dir === 'long' ? ps.slLong : ps.slShort, close);
    rec.outcome = wf.o; rec.pnl = wf.pnl; out.push(rec);
    qualifiedFlips.push({ dir: f.dir, entry: f.entry, ts: trigTs });
  }

  // ── CONT funnel (parents = qualified FLIPs this arm) ──
  const lastCont: Record<string, number> = { long: 0, short: 0 };
  const usedParent: Record<string, number> = {};
  for (let i = MACRO_N; i < cBars.length; i++) {
    const bar = cBars[i]!; if (bar.ts < start || bar.ts >= end) continue;
    const trigTs = bar.ts + MIN_1;
    if (etMin(trigTs) < OPEN_GATE_MIN) continue;
    for (const dir of ['long', 'short'] as const) {
      const parent = [...qualifiedFlips].reverse().find(p => p.dir === dir && trigTs - p.ts <= PARENT_WINDOW && trigTs - p.ts >= 0);
      if (!parent) continue;
      if (usedParent[`${dir}`] === parent.ts) continue;
      const post = cBars.filter(b => b.ts >= Math.floor(parent.ts / MIN_1) * MIN_1 && b.ts <= bar.ts);
      if (post.length < 3) continue;
      const isLong = dir === 'long';
      const peak = isLong ? Math.max(...post.map(b => b.high)) - parent.entry : parent.entry - Math.min(...post.map(b => b.low));
      if (peak < MIN_EXTENSION) continue;
      const curGain = isLong ? bar.close - parent.entry : parent.entry - bar.close;
      if (curGain <= 0) continue;
      const retrace = (peak - curGain) / peak;
      if (retrace < RETRACE_MIN || retrace > RETRACE_MAX) continue;
      const d15 = cBars.slice(Math.max(0, i - 15), i).reduce((s, b) => s + b.delta, 0);
      const dBar = bar.delta;
      const ok = isLong ? d15 >= DELTA_REALIGN && dBar >= DELTA_BAR_MIN : d15 <= -DELTA_REALIGN && dBar <= -DELTA_BAR_MIN;
      const rec: any = { day, rule: 'cont-reentry', dir, barTs: bar.ts, trigTs, entry: bar.close, delta15: d15, deltaBar: dBar, extensionPts: peak, retracePct: retrace, stage: 'raw' };
      if (!ok) { rec.stage = 'cont_delta_blocked'; out.push(rec); continue; }
      if (bar.ts - (lastCont[dir] ?? 0) < CONT_COOLDOWN_MS) { rec.stage = 'raw_cooldown'; out.push(rec); continue; }
      lastCont[dir] = bar.ts; usedParent[`${dir}`] = parent.ts;
      rec.stage = 'qualified'; // CONT is gold by default
      const cvd = cvdAt(trigTs); rec.cvdSession = cvd;
      if (dir === 'long' && cvd <= CVD_LONG_FLOOR) { rec.stage = 'skip_cvd'; out.push(rec); continue; }
      if (dir === 'short' && cvd >= CVD_SHORT_FLOOR) { rec.stage = 'skip_cvd'; out.push(rec); continue; }
      rec.stage = 'tradable';
      const ps = TPSL['cont-reentry']!; const wf = walkForward(rthTrades, trigTs, bar.close, dir, ps.tp, ps.slLong, close);
      rec.outcome = wf.o; rec.pnl = wf.pnl; out.push(rec);
    }
  }
}
db.close();
writeFileSync(OUTPUT_JSON, JSON.stringify(out, null, 0));
// summary
const tr = out.filter(r => r.stage === 'tradable');
const w = (a: any[]) => a.filter(r => r.outcome === 'WIN').length;
console.log(`\n=== ${INPUT_DB.split('/').pop()} → ${out.length} records, ${tr.length} tradable ===`);
for (const rule of ['clean-impulse', 'cont-reentry']) for (const dir of ['long', 'short']) {
  const g = tr.filter(r => r.rule === rule && r.dir === dir);
  if (!g.length) continue;
  const res = g.filter(r => r.outcome !== 'DRAW');
  const pnl = g.reduce((s, r) => s + (r.pnl || 0), 0);
  console.log(`  ${rule} ${dir}: tradable=${g.length} W/L=${w(res)}/${res.length - w(res)} WR=${res.length ? Math.round(100 * w(res) / res.length) : 0}% pnl=${pnl.toFixed(0)}pt`);
}
