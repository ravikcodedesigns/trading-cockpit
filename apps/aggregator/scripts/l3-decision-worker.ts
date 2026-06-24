// l3-decision-worker — the DECIDER. Consumes touch events from the book builder
// (l3-book-worker), runs the framework engines → thesis → L3 confirmation, and writes
// l3_trade_decisions. This is the process you restart all day while iterating on the
// engines/confirm — the in-memory book lives in the OTHER process and is never rebuilt.
//
// Push-driven (no polling window): connects to the builder's UDS; on each nudge it
// drains all unprocessed touch rows. A durable `processed` flag means a restart resumes
// exactly where it left off (and catches up anything emitted while it was down). A slow
// 10s tick is only a safety net for a dropped nudge.
//   pnpm --filter @trading/aggregator l3:decider     (or tsx scripts/l3-decision-worker.ts)
import Database from 'better-sqlite3';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext, getContext } from '../src/rs-context.js';
import { deriveMarketState } from '../src/rules-v2/derive-market-state.js';
import { buildThesis, type Thesis } from '../src/l3/engine-thesis.js';
import { confirm, type L3Read, type CtxRead } from '../src/l3/decision-engine.js';
import type { DailyLevels } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const SHADOW_DB = path.join(ROOT, 'data', 'l3-shadow.db');
const SOCK_PATH = process.env.L3_TOUCH_SOCK || '/tmp/cockpit-l3-touch.sock';
const LEVEL_FILES: Record<string, string> = { NQ: path.join(ROOT, 'daily_levels.json'), ES: path.join(ROOT, 'daily_levels_es.json') };
const etTime = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
const log = (...a: unknown[]) => console.log(etTime() + ' ET', ...a);

function readDailyLevels(symbol: string, day: string): DailyLevels | undefined {
  try {
    const doc = JSON.parse(fs.readFileSync(LEVEL_FILES[symbol], 'utf8'));
    const lv = doc.days?.[day]?.levels?.find((x: { symbol: string }) => x.symbol === symbol);
    if (!lv) return undefined;
    return { ts: 0, source: 'levels', type: 'daily', tradingDay: day, ...lv } as DailyLevels;
  } catch { return undefined; }
}

// ── db ───────────────────────────────────────────────────────────────────────
const db = new Database(SHADOW_DB);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS l3_trade_decisions (
  id INTEGER PRIMARY KEY,
  ts_ms INTEGER, ts_et TEXT, trading_day TEXT,
  symbol TEXT, level_label TEXT, level_price REAL, price REAL, approach TEXT,
  direction TEXT, bounce_break TEXT, engines TEXT, confluence INTEGER, conflict TEXT,
  size_base TEXT, base_prob REAL, lm_agrees INTEGER, entry REAL, stop REAL, targets TEXT,
  defend_side TEXT, wall INTEGER, l3_size INTEGER, implied_gap INTEGER,
  native_ice INTEGER, synth_refills INTEGER, executed_near INTEGER, cvd INTEGER, cvd60 INTEGER,
  aggr_buy INTEGER, aggr_sell INTEGER, pull INTEGER, adds INTEGER,
  sweep_with INTEGER, sweep_against INTEGER, cluster_dom REAL,
  gm TEXT, gate_mode TEXT, is_rational INTEGER, vx_vol_state TEXT,
  verdict TEXT, size TEXT, confirm_score REAL, confirms TEXT, vetoes TEXT,
  break_forming TEXT, diagnostic TEXT, touch_ms INTEGER,
  engine_outcome TEXT, decision_outcome TEXT, engine_pnl_pts REAL, exit_ts_ms INTEGER, resolved_at INTEGER
)`);
// the table may pre-date the touch_ms column (CREATE IF NOT EXISTS won't add it)
try { db.exec('ALTER TABLE l3_trade_decisions ADD COLUMN touch_ms INTEGER'); } catch { /* exists */ }
// own the touch-event queue schema too, so the decider can start before the builder
db.exec(`CREATE TABLE IF NOT EXISTS l3_touch_events (
  id INTEGER PRIMARY KEY, ts_ms INTEGER, ts_et TEXT, trading_day TEXT,
  symbol TEXT, level_label TEXT, level_kind TEXT, level_price REAL,
  mid REAL, dist_ticks REAL, l3_json TEXT, processed INTEGER DEFAULT 0,
  source TEXT DEFAULT 'rs', sig_json TEXT
)`);
for (const col of ["source TEXT DEFAULT 'rs'", 'sig_json TEXT'])
  try { db.exec(`ALTER TABLE l3_touch_events ADD COLUMN ${col}`); } catch { /* exists */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_touch_unprocessed ON l3_touch_events(processed, id)');

// FLIP/CONT tradable validations (source='signal'). Shadow only — never read by the trader.
db.exec(`CREATE TABLE IF NOT EXISTS l3_signal_validations (
  id INTEGER PRIMARY KEY, signal_id INTEGER UNIQUE, ts_ms INTEGER, ts_et TEXT, trading_day TEXT,
  symbol TEXT, pattern TEXT, direction TEXT, action TEXT, qualified INTEGER, entry REAL,
  tag TEXT, valid INTEGER, opp_stronger INTEGER, score_dir REAL, score_opp REAL,
  defend_side TEXT, wall INTEGER, l3_size INTEGER, implied_gap INTEGER, native_ice INTEGER, synth_refills INTEGER,
  executed_near INTEGER, cvd INTEGER, cvd60 INTEGER, aggr_buy INTEGER, aggr_sell INTEGER, pull INTEGER, adds INTEGER,
  sweep_with INTEGER, sweep_against INTEGER, cluster_dom REAL,
  confirms TEXT, vetoes TEXT, diagnostic TEXT, touch_ms INTEGER,
  outcome TEXT, pnl_pts REAL, resolved_at INTEGER
)`);
const insTrade = db.prepare(`INSERT INTO l3_trade_decisions
  (ts_ms,ts_et,trading_day,symbol,level_label,level_price,price,approach,
   direction,bounce_break,engines,confluence,conflict,size_base,base_prob,lm_agrees,entry,stop,targets,
   defend_side,wall,l3_size,implied_gap,native_ice,synth_refills,executed_near,cvd,cvd60,
   aggr_buy,aggr_sell,pull,adds,sweep_with,sweep_against,cluster_dom,
   gm,gate_mode,is_rational,vx_vol_state,verdict,size,confirm_score,confirms,vetoes,break_forming,diagnostic,touch_ms)
  VALUES (@ts_ms,@ts_et,@trading_day,@symbol,@level_label,@level_price,@price,@approach,
   @direction,@bounce_break,@engines,@confluence,@conflict,@size_base,@base_prob,@lm_agrees,@entry,@stop,@targets,
   @defend_side,@wall,@l3_size,@implied_gap,@native_ice,@synth_refills,@executed_near,@cvd,@cvd60,
   @aggr_buy,@aggr_sell,@pull,@adds,@sweep_with,@sweep_against,@cluster_dom,
   @gm,@gate_mode,@is_rational,@vx_vol_state,@verdict,@size,@confirm_score,@confirms,@vetoes,@break_forming,@diagnostic,@touch_ms)`);
const selUnprocessed = db.prepare('SELECT * FROM l3_touch_events WHERE processed=0 ORDER BY id LIMIT 500');
const markDone = db.prepare('UPDATE l3_touch_events SET processed=1 WHERE id=?');
const insSignalVal = db.prepare(`INSERT OR IGNORE INTO l3_signal_validations
  (signal_id,ts_ms,ts_et,trading_day,symbol,pattern,direction,action,qualified,entry,
   tag,valid,opp_stronger,score_dir,score_opp,defend_side,wall,l3_size,implied_gap,native_ice,synth_refills,
   executed_near,cvd,cvd60,aggr_buy,aggr_sell,pull,adds,sweep_with,sweep_against,cluster_dom,
   confirms,vetoes,diagnostic,touch_ms)
  VALUES (@signal_id,@ts_ms,@ts_et,@trading_day,@symbol,@pattern,@direction,@action,@qualified,@entry,
   @tag,@valid,@opp_stronger,@score_dir,@score_opp,@defend_side,@wall,@l3_size,@implied_gap,@native_ice,@synth_refills,
   @executed_near,@cvd,@cvd60,@aggr_buy,@aggr_sell,@pull,@adds,@sweep_with,@sweep_against,@cluster_dom,
   @confirms,@vetoes,@diagnostic,@touch_ms)`);

// ── decide one touch ───────────────────────────────────────────────────────────
function decideOne(ev: any): void {
  if (ev.source === 'signal') { decideSignal(ev); return; }   // FLIP/CONT tradable — separate path, no RS engine
  loadContext();
  const rs = getContext(ev.symbol);
  const levels = readDailyLevels(ev.symbol, ev.trading_day);
  const ms = deriveMarketState({ symbol: ev.symbol, rs, levels, price: ev.mid });
  const thesis = buildThesis(ms, ev.level_price);
  if (!thesis) return;   // no engine setup at this level → not an RS-framework level → no decision

  const b = JSON.parse(ev.l3_json);
  const defendSide: 'bid' | 'ask' = thesis.direction === 'long' ? 'bid' : 'ask';
  const s = b[defendSide];
  const sweepWith = b.sweep.swept && b.sweep.dir != null && ((thesis.direction === 'long') === (b.sweep.dir === 'buy'));
  const sweepAgainst = b.sweep.swept && b.sweep.dir != null && !sweepWith;
  const l3: L3Read = {
    defendSide, wall: s.wall, l3Size: s.l3, impliedGap: s.gap, nativeIce: s.ice, synthRefills: s.synth,
    executedNear: b.executedNear, cvd: b.cvd, cvd60: b.cvd60, aggrBuy: b.aggrBuy, aggrSell: b.aggrSell,
    pull: s.pull, adds: s.adds, sweepWith, sweepAgainst, clusterDominance: b.cluster.dominance,
  };
  const cx: CtxRead = {
    isRational: ms.confluence.isRational, vxVolState: rs.vxVolState ?? null,
    gateMode: ms.gate.mode, gateLongOnly: ms.gate.longOnly, gateSizeDown: ms.gate.sizeDown,
    price: ev.mid, ddUpper: ms.levels.ddUpper ?? null, ddLower: ms.levels.ddLower ?? null,
  };
  const r = confirm(thesis, l3, cx);
  const now = Date.now();
  insTrade.run({
    ts_ms: now, ts_et: etTime(), trading_day: ev.trading_day,
    symbol: ev.symbol, level_label: ev.level_label, level_price: ev.level_price, price: ev.mid,
    approach: ev.dist_ticks >= 0 ? 'above' : 'below',
    direction: thesis.direction, bounce_break: thesis.bounceVsBreak, engines: thesis.engines.join('+'),
    confluence: thesis.confluence, conflict: thesis.conflict.join('+') || null, size_base: thesis.sizeBase,
    base_prob: thesis.baseProb, lm_agrees: thesis.lmAgrees == null ? null : (thesis.lmAgrees ? 1 : 0),
    entry: thesis.entry, stop: thesis.stop, targets: JSON.stringify(thesis.targets),
    defend_side: defendSide, wall: l3.wall, l3_size: l3.l3Size, implied_gap: l3.impliedGap,
    native_ice: l3.nativeIce, synth_refills: l3.synthRefills, executed_near: l3.executedNear,
    cvd: l3.cvd, cvd60: l3.cvd60, aggr_buy: b.aggrBuy, aggr_sell: b.aggrSell, pull: l3.pull, adds: l3.adds,
    sweep_with: sweepWith ? 1 : 0, sweep_against: sweepAgainst ? 1 : 0, cluster_dom: +b.cluster.dominance.toFixed(2),
    gm: ms.confluence.gm, gate_mode: ms.gate.mode, is_rational: ms.confluence.isRational ? 1 : 0,
    vx_vol_state: rs.vxVolState ?? null,
    verdict: r.verdict, size: r.size, confirm_score: r.confirmationScore,
    confirms: JSON.stringify(r.confirms), vetoes: JSON.stringify(r.invalidations),
    break_forming: r.breakForming ? JSON.stringify(r.breakForming) : null, diagnostic: r.diagnostic, touch_ms: ev.ts_ms,
  });
  log(`[${ev.symbol}] ${r.verdict.toUpperCase()} ${r.diagnostic}  (touch→decision ${now - ev.ts_ms}ms)`);
}

// ── signal validation (source='signal') — FLIP/CONT tradable. Direction comes from the
// signal (not the RS engine); we run the SAME confirm() for the signal direction AND the
// opposite, and tag VALID/INVALID + which side the order flow favors. Shadow only. ──
function l3ForDir(b: any, direction: 'long' | 'short'): L3Read {
  const defendSide: 'bid' | 'ask' = direction === 'long' ? 'bid' : 'ask';
  const s = b[defendSide];
  const sweepWith = b.sweep.swept && b.sweep.dir != null && ((direction === 'long') === (b.sweep.dir === 'buy'));
  const sweepAgainst = b.sweep.swept && b.sweep.dir != null && !sweepWith;
  return {
    defendSide, wall: s.wall, l3Size: s.l3, impliedGap: s.gap, nativeIce: s.ice, synthRefills: s.synth,
    executedNear: b.executedNear, cvd: b.cvd, cvd60: b.cvd60, aggrBuy: b.aggrBuy, aggrSell: b.aggrSell,
    pull: s.pull, adds: s.adds, sweepWith, sweepAgainst, clusterDominance: b.cluster.dominance,
  };
}
function sigThesis(direction: 'long' | 'short', bvb: 'bounce' | 'break', level: number, label: string): Thesis {
  return {
    direction, bounceVsBreak: bvb, level, confluence: 1, engines: [label], conflict: [],
    lmAgrees: null, sizeBase: 'M', baseProb: 0.5, entry: level,
    stop: direction === 'long' ? level - 40 : level + 40, targets: [direction === 'long' ? level + 40 : level - 40],
  } as unknown as Thesis;
}
function decideSignal(ev: any): void {
  const sig = JSON.parse(ev.sig_json);      // {signal_id, direction, pattern, action, qualified, entry}
  const b = JSON.parse(ev.l3_json);
  const dir: 'long' | 'short' = sig.direction;
  const opp: 'long' | 'short' = dir === 'long' ? 'short' : 'long';
  const bvb: 'bounce' | 'break' = sig.pattern === 'FLIP' ? 'bounce' : 'break';
  // neutral ctx — these are NOT RS-gated; isolate the L3 microstructure verdict
  const ctx: CtxRead = { isRational: true, vxVolState: null, gateMode: 'normal', gateLongOnly: false, gateSizeDown: false, price: sig.entry, ddUpper: null, ddLower: null };
  const rDir = confirm(sigThesis(dir, bvb, sig.entry, `${sig.pattern}-${dir}`), l3ForDir(b, dir), ctx);
  const rOpp = confirm(sigThesis(opp, bvb, sig.entry, `${sig.pattern}-${opp}`), l3ForDir(b, opp), ctx);
  const valid = rDir.verdict === 'take';
  const oppStronger = rOpp.confirmationScore > rDir.confirmationScore;
  const tag = `${sig.pattern} ${dir.toUpperCase()} ${valid ? 'VALID' : 'INVALID'}`;
  const l3 = l3ForDir(b, dir);
  const now = Date.now();
  insSignalVal.run({
    signal_id: sig.signal_id, ts_ms: now, ts_et: etTime(), trading_day: ev.trading_day,
    symbol: ev.symbol, pattern: sig.pattern, direction: dir, action: sig.action, qualified: sig.qualified ? 1 : 0, entry: sig.entry,
    tag, valid: valid ? 1 : 0, opp_stronger: oppStronger ? 1 : 0, score_dir: rDir.confirmationScore, score_opp: rOpp.confirmationScore,
    defend_side: l3.defendSide, wall: l3.wall, l3_size: l3.l3Size, implied_gap: l3.impliedGap, native_ice: l3.nativeIce, synth_refills: l3.synthRefills,
    executed_near: l3.executedNear, cvd: l3.cvd, cvd60: l3.cvd60, aggr_buy: b.aggrBuy, aggr_sell: b.aggrSell, pull: l3.pull, adds: l3.adds,
    sweep_with: l3.sweepWith ? 1 : 0, sweep_against: l3.sweepAgainst ? 1 : 0, cluster_dom: +b.cluster.dominance.toFixed(2),
    confirms: JSON.stringify(rDir.confirms), vetoes: JSON.stringify(rDir.invalidations), diagnostic: rDir.diagnostic, touch_ms: ev.ts_ms,
  });
  log(`[${ev.symbol}] ${tag} — ${opp.toUpperCase()} ${oppStronger ? 'STRONGER' : 'weaker'} (${dir[0].toUpperCase()}=${rDir.confirmationScore}/${opp[0].toUpperCase()}=${rOpp.confirmationScore}) | ${rDir.diagnostic}  [sig#${sig.signal_id} ${sig.action}/q${sig.qualified}]`);
}

let draining = false;
function drain(): void {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const rows = selUnprocessed.all() as any[];
      if (!rows.length) break;
      for (const ev of rows) {
        try { decideOne(ev); } catch (e) { console.error(`decide error id=${ev.id}:`, (e as Error).message); }
        markDone.run(ev.id);
      }
    }
  } finally { draining = false; }
}

// ── connect to the builder's push socket ──────────────────────────────────────
function connect(): void {
  const sock = net.connect(SOCK_PATH);
  sock.on('connect', () => { log(`connected to builder push ${SOCK_PATH}`); drain(); });   // catch up on (re)connect
  sock.on('data', () => drain());                                                            // nudge → process now
  sock.on('error', () => {});
  sock.on('close', () => setTimeout(connect, 1000));                                         // retry on builder restart
}

log('l3-decision-worker starting — engines + L3 confirmation (book lives in l3-book-worker)');
drain();                          // process anything already queued
connect();
setInterval(drain, 10_000);       // safety net only — the nudge is the real trigger
process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
