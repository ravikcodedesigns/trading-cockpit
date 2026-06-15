// Phase 1 — TICK-BY-TICK simulator. No bar-based gating, no look-ahead.
//
// CONTRACT:
//   • Signal fires on the EXACT tick where proximity is breached, fresh, with
//     approach distance met. No bar close required.
//   • Entry price = the signal tick's price.
//   • Outcome walk uses ONLY ticks with ts STRICTLY GREATER than signal_ts.
//   • ATR(5m) / ATR(10m) computed from PRIOR closed 1-min bars (bars whose
//     close timestamp ≤ signal_ts).
//   • Approach distance = (price 5 min ago) − (current price) × direction sign.
//     "5 min ago" is the closest tick at or before signal_ts − 5min.
//   • Slippage: 5pt exit slip applied to TP wins and SL losses.
//   • Per-level breach state and FRESH counter are updated AS WE WALK, never
//     looking at future ticks for past decisions.
//
// Outputs phase1-intratick-<set>.json with one entry per emitted signal.
//
// Usage:
//   tsx scripts/phase1/intratick_simulator.ts --set train
//   tsx scripts/phase1/intratick_simulator.ts --set test

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRAIN_DAYS, TEST_DAYS, RTH_START, RTH_END } from './days.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../../..');
const TICKS_DB = path.join(REPO, 'data/ticks.db');
const LEVELS_FILE = path.join(REPO, 'daily_levels.json');

// ── Strategy params ──
// Tier-1, prior-day-derived levels ONLY (no IB look-ahead, no RS).
const TIER1 = ['PDH', 'PDL', 'PDC', 'POC', 'VAH', 'VAL'] as const;
const TP_PT = 20;
const SL_PT = 5;
const SLIP_PT = 5;
const K_PROXIMITY = 1.0;
const M_APPROACH  = 1.5;
const BREACH_PT   = 5;
const MIN_ATR_PT  = 1.0;     // floor on ATR to avoid 0 in dead periods
const MAX_HOLD_MS = 30 * 60_000;  // force-close after 30min hold

// ── ET helpers ──
function etTimeAt(day: string, hour: number, minute: number): number {
  const [y, m, d] = day.split('-').map(Number);
  const noonUtc = Date.UTC(y!, m! - 1, d!, 12, 0, 0);
  const noonEtHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false })
      .format(new Date(noonUtc)),
    10,
  );
  const offsetHours = 12 - noonEtHour;
  return Date.UTC(y!, m! - 1, d!, hour + offsetHours, minute);
}
function fmtEt(tsMs: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
  }).format(new Date(tsMs));
}

// ── 1-min bar + ATR precomputation ──
interface Bar { ts: number; open: number; high: number; low: number; close: number; }

function buildBarsAndATR(ticksDb: Database.Database, symbol: string, fromMs: number, toMs: number):
  { barCloseTs: number[]; atr5: number[]; atr10: number[] }
{
  const stmt = ticksDb.prepare(`
    SELECT ts, price FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts ASC
  `);
  const bars = new Map<number, Bar>();
  for (const r of stmt.iterate(symbol, fromMs, toMs) as IterableIterator<{ts:number;price:number}>) {
    const bucket = Math.floor(r.ts / 60_000) * 60_000;
    let b = bars.get(bucket);
    if (!b) { b = { ts: bucket, open: r.price, high: r.price, low: r.price, close: r.price }; bars.set(bucket, b); }
    b.high = Math.max(b.high, r.price);
    b.low  = Math.min(b.low,  r.price);
    b.close = r.price;
  }
  const arr = [...bars.values()].sort((a,b)=>a.ts - b.ts);
  // ATR per bar — uses prior N bars (does NOT include current bar's range)
  const barCloseTs: number[] = [];   // close timestamp of each bar (= bar start + 60s)
  const atr5: number[]  = [];
  const atr10: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    barCloseTs.push(arr[i]!.ts + 60_000);
    const compute = (window: number) => {
      const start = Math.max(0, i - window);
      const count = i - start;
      if (count === 0) return MIN_ATR_PT;
      let sum = 0;
      for (let j = start; j < i; j++) {
        const b = arr[j]!;
        const prev = j > 0 ? arr[j-1]!.close : b.open;
        sum += Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
      }
      return Math.max(sum / count, MIN_ATR_PT);
    };
    atr5.push(compute(5));
    atr10.push(compute(10));
  }
  return { barCloseTs, atr5, atr10 };
}

// Look up ATR effective at time T (ms). Returns the ATR computed from bars
// whose close <= T. binary search over barCloseTs.
function lookupATR(barCloseTs: number[], atr: number[], tsMs: number): number {
  // last index where barCloseTs[i] <= tsMs
  let lo = 0, hi = barCloseTs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (barCloseTs[mid]! <= tsMs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans < 0 ? MIN_ATR_PT : atr[ans]!;
}

// ── Level state ──
interface LevelState {
  label: string;
  price: number;
  initialSide: 'above' | 'below' | null;
  hadBreach: boolean;
  inProximity: boolean;
  nTouchesEmitted: number;
}

// ── Signal + outcome record ──
interface Outcome {
  result: 'TP' | 'SL' | 'TIMEOUT' | 'RTH_CLOSE';
  exit_ts: number;
  exit_et: string;
  exit_price: number;
  raw_pnl_pts: number;
  slip_pnl_pts: number;
  mfe_pts: number;
  mae_pts: number;
  duration_ms: number;
  ticks_walked: number;
}
interface Signal {
  day: string;
  level_label: string;
  level_price: number;
  signal_ts: number;
  signal_et: string;
  entry_price: number;
  direction: 'long' | 'short';
  approach_dir: 'from_above' | 'from_below';
  approach_dist_5m_pts: number;
  atr_5m: number;
  atr_10m: number;
  proximity_used: number;
  tp_price: number;
  sl_price: number;
  outcome: Outcome;
}

// ── Per-day simulation ──
function processDay(ticksDb: Database.Database, day: string, levelMap: Map<string, number>): Signal[] {
  const rthStart = etTimeAt(day, RTH_START.hour, RTH_START.minute);
  const rthEnd   = etTimeAt(day, RTH_END.hour,   RTH_END.minute);
  // We need ~15min of pre-RTH for ATR seeding.
  const preRthStart = rthStart - 15 * 60_000;

  // ── Precompute bars/ATR over the [preRth, rthEnd] span. ──
  const { barCloseTs, atr5, atr10 } = buildBarsAndATR(ticksDb, 'NQ', preRthStart, rthEnd);

  // ── Initialize level states ──
  const states = new Map<string, LevelState>();
  for (const [label, price] of levelMap) {
    states.set(label, {
      label, price,
      initialSide: null, hadBreach: false,
      inProximity: false, nTouchesEmitted: 0,
    });
  }

  // ── Single-pass tick walk over RTH ──
  const tickStmt = ticksDb.prepare(`
    SELECT ts, price FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts ASC
  `);

  // Open positions managed alongside (single pass for both detection + outcome)
  interface OpenPos {
    sig: Signal;             // mutable — outcome fields filled on close
    entryTs: number;
    entryPrice: number;
    direction: 'long' | 'short';
    tpPx: number;
    slPx: number;
    mfe: number;
    mae: number;
    ticksWalked: number;
  }
  const open: OpenPos[] = [];
  const completed: Signal[] = [];

  // 5-min rolling price buffer
  const priceBuf: Array<{ts:number; price:number}> = [];

  for (const r of tickStmt.iterate('NQ', rthStart, rthEnd) as IterableIterator<{ts:number;price:number}>) {
    const t = r;

    // ── (1) Update open positions: check TP/SL/MAX_HOLD ──
    for (let i = open.length - 1; i >= 0; i--) {
      const p = open[i]!;
      const mv = p.direction === 'long' ? (t.price - p.entryPrice) : (p.entryPrice - t.price);
      if (mv > p.mfe) p.mfe = mv;
      if (mv < p.mae) p.mae = mv;
      p.ticksWalked++;
      let hit: 'TP' | 'SL' | null = null;
      if (p.direction === 'long') {
        if (t.price <= p.slPx) hit = 'SL';
        else if (t.price >= p.tpPx) hit = 'TP';
      } else {
        if (t.price >= p.slPx) hit = 'SL';
        else if (t.price <= p.tpPx) hit = 'TP';
      }
      const aged = (t.ts - p.entryTs) >= MAX_HOLD_MS;
      if (hit || aged) {
        const exitPx = hit === 'TP' ? p.tpPx : hit === 'SL' ? p.slPx : t.price;
        const rawPnl = hit === 'TP' ? TP_PT : hit === 'SL' ? -SL_PT : (p.direction === 'long' ? (exitPx - p.entryPrice) : (p.entryPrice - exitPx));
        p.sig.outcome = {
          result: hit ?? 'TIMEOUT',
          exit_ts: t.ts,
          exit_et: fmtEt(t.ts),
          exit_price: exitPx,
          raw_pnl_pts: +rawPnl.toFixed(2),
          slip_pnl_pts: +(rawPnl - SLIP_PT).toFixed(2),
          mfe_pts: +p.mfe.toFixed(2),
          mae_pts: +p.mae.toFixed(2),
          duration_ms: t.ts - p.entryTs,
          ticks_walked: p.ticksWalked,
        };
        completed.push(p.sig);
        open.splice(i, 1);
      }
    }

    // ── (2) Update rolling 5min buffer ──
    while (priceBuf.length > 0 && t.ts - priceBuf[0]!.ts > 5 * 60_000) priceBuf.shift();
    const ref5m = priceBuf.length > 0 ? priceBuf[0]!.price : t.price;
    priceBuf.push({ ts: t.ts, price: t.price });

    // ── (3) For each level: update state, check signal trigger ──
    const a5  = lookupATR(barCloseTs, atr5, t.ts);
    const a10 = lookupATR(barCloseTs, atr10, t.ts);
    const proximity = Math.max(K_PROXIMITY * a5, MIN_ATR_PT);

    for (const s of states.values()) {
      // Initial side
      if (s.initialSide === null) s.initialSide = t.price >= s.price ? 'above' : 'below';
      // Breach update
      if (!s.hadBreach) {
        const currentSide = t.price >= s.price ? 'above' : 'below';
        if (currentSide !== s.initialSide && Math.abs(t.price - s.price) > BREACH_PT) {
          s.hadBreach = true;
        }
      }

      const dist = Math.abs(t.price - s.price);
      const wasIn = s.inProximity;
      const nowIn = dist <= proximity;

      // INACTIVE → INSIDE: candidate signal
      if (!wasIn && nowIn) {
        s.inProximity = true;
        // FRESH gate
        if (s.nTouchesEmitted > 0 || s.hadBreach) continue;
        // Approach direction
        const approachDir: 'from_above' | 'from_below' = ref5m > s.price ? 'from_above' : 'from_below';
        const sign = approachDir === 'from_above' ? 1 : -1;
        const signedApproach = (ref5m - t.price) * sign;
        if (signedApproach < M_APPROACH * a10) continue;
        // SIGNAL FIRES
        const direction: 'long' | 'short' = approachDir === 'from_above' ? 'long' : 'short';
        const entry = t.price;
        const tpPx = direction === 'long' ? entry + TP_PT : entry - TP_PT;
        const slPx = direction === 'long' ? entry - SL_PT : entry + SL_PT;
        const sig: Signal = {
          day,
          level_label: s.label,
          level_price: s.price,
          signal_ts: t.ts,
          signal_et: fmtEt(t.ts),
          entry_price: entry,
          direction,
          approach_dir: approachDir,
          approach_dist_5m_pts: +signedApproach.toFixed(2),
          atr_5m: +a5.toFixed(2),
          atr_10m: +a10.toFixed(2),
          proximity_used: +proximity.toFixed(2),
          tp_price: +tpPx.toFixed(2),
          sl_price: +slPx.toFixed(2),
          outcome: { result: 'TP', exit_ts: 0, exit_et: '', exit_price: 0, raw_pnl_pts: 0, slip_pnl_pts: 0, mfe_pts: 0, mae_pts: 0, duration_ms: 0, ticks_walked: 0 },
        };
        open.push({
          sig, entryTs: t.ts, entryPrice: entry, direction, tpPx, slPx, mfe: 0, mae: 0, ticksWalked: 0,
        });
        s.nTouchesEmitted++;
      }

      // INSIDE → INACTIVE
      if (wasIn && !nowIn) s.inProximity = false;
    }
  }

  // ── Force-close any positions still open at RTH end ──
  for (const p of open) {
    const lastTickStmt = ticksDb.prepare(`SELECT ts, price FROM trades WHERE symbol=? AND ts<? ORDER BY ts DESC LIMIT 1`);
    const last = lastTickStmt.get('NQ', rthEnd) as { ts: number; price: number } | undefined;
    if (!last) continue;
    const exitPx = last.price;
    const rawPnl = p.direction === 'long' ? (exitPx - p.entryPrice) : (p.entryPrice - exitPx);
    p.sig.outcome = {
      result: 'RTH_CLOSE',
      exit_ts: last.ts,
      exit_et: fmtEt(last.ts),
      exit_price: exitPx,
      raw_pnl_pts: +rawPnl.toFixed(2),
      slip_pnl_pts: +(rawPnl - SLIP_PT).toFixed(2),
      mfe_pts: +p.mfe.toFixed(2),
      mae_pts: +p.mae.toFixed(2),
      duration_ms: last.ts - p.entryTs,
      ticks_walked: p.ticksWalked,
    };
    completed.push(p.sig);
  }

  return completed;
}

// ── Main ──
function main() {
  const argv = process.argv.slice(2);
  const setArg = argv.includes('--set') ? argv[argv.indexOf('--set') + 1] : 'train';
  const days: readonly string[] =
    setArg === 'test' ? TEST_DAYS :
    setArg === 'train' ? TRAIN_DAYS :
    (() => { throw new Error(`Unknown --set ${setArg}`); })();

  const ticksDb = new Database(TICKS_DB, { readonly: true });
  const levelsJson = JSON.parse(fs.readFileSync(LEVELS_FILE, 'utf8'));

  const allSignals: Signal[] = [];

  for (const day of days) {
    const entry = levelsJson.days?.[day];
    if (!entry) { console.warn(`  ${day}: no levels — skip`); continue; }
    const levels = entry.levels?.[0]?.additionalLevels ?? [];
    const levelMap = new Map<string, number>();
    for (const lvl of levels) {
      if ((TIER1 as readonly string[]).includes(lvl.label)) levelMap.set(lvl.label, lvl.price);
    }
    if (levelMap.size === 0) { console.warn(`  ${day}: no Tier-1 levels — skip`); continue; }

    const sigs = processDay(ticksDb, day, levelMap);
    allSignals.push(...sigs);
    console.log(`  ${day}: ${sigs.length} signals`);
  }

  // ── Audit: print first 3 and last 3 with timestamps and tick-counts ──
  console.log('\n── Audit: first 3 signals ──');
  for (const s of allSignals.slice(0, 3)) {
    console.log(`  ${s.day}  ${s.signal_et}  ${s.level_label} ${s.direction}@${s.entry_price}  → ${s.outcome.result} ${s.outcome.exit_et} px=${s.outcome.exit_price} dt=${(s.outcome.duration_ms/1000).toFixed(1)}s ticks=${s.outcome.ticks_walked}  raw=${s.outcome.raw_pnl_pts} slip=${s.outcome.slip_pnl_pts}`);
  }
  console.log('\n── Audit: last 3 signals ──');
  for (const s of allSignals.slice(-3)) {
    console.log(`  ${s.day}  ${s.signal_et}  ${s.level_label} ${s.direction}@${s.entry_price}  → ${s.outcome.result} ${s.outcome.exit_et} px=${s.outcome.exit_price} dt=${(s.outcome.duration_ms/1000).toFixed(1)}s ticks=${s.outcome.ticks_walked}  raw=${s.outcome.raw_pnl_pts} slip=${s.outcome.slip_pnl_pts}`);
  }

  // ── Sanity check: any signal with ticks_walked == 0 OR exit_ts == signal_ts? ──
  const suspect = allSignals.filter(s => s.outcome.ticks_walked === 0 || s.outcome.exit_ts <= s.signal_ts);
  console.log(`\n── Sanity: ${suspect.length} signals with suspicious zero-walk (must be 0 for honest backtest)`);

  // Outcome summary
  const w = allSignals.filter(s => s.outcome.result === 'TP').length;
  const l = allSignals.filter(s => s.outcome.result === 'SL').length;
  const to = allSignals.filter(s => s.outcome.result === 'TIMEOUT').length;
  const rc = allSignals.filter(s => s.outcome.result === 'RTH_CLOSE').length;
  const netPts = allSignals.reduce((sum, s) => sum + s.outcome.slip_pnl_pts, 0);
  console.log(`\n── Summary (${setArg}): n=${allSignals.length}  TP=${w} SL=${l} TIMEOUT=${to} RTH=${rc}  WR=${w&&l?(w/(w+l)*100).toFixed(1)+'%':'n/a'}  Net=${netPts.toFixed(0)}pt = $${(netPts*2).toFixed(0)}`);

  const outFile = path.join(REPO, `phase1-intratick-${setArg}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    set: setArg,
    days_processed: days.length,
    config: { TIER1, TP_PT, SL_PT, SLIP_PT, K_PROXIMITY, M_APPROACH, BREACH_PT, MIN_ATR_PT, MAX_HOLD_MS },
    n_signals: allSignals.length,
    signals: allSignals,
  }, null, 2));
  console.log(`Wrote ${outFile}`);
}

main();
