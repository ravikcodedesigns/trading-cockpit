/**
 * backfill_clean.ts
 * Retroactively runs Strategy H (CLEAN impulse — FLIP only) detection across
 * all RTH sessions with tick data and inserts qualifying signals into trading.db.
 *
 * SHORT FLIP uses the updated buyer-exhaustion logic:
 *   - priorImpulse >= 1400 (prior 1-2 bars had very strong push up)
 *   - upperWick >= 15pts   (strong rejection)
 *   - compPosHigh in [0.50, 1.00]  (bar HIGH in upper half, not a breakout)
 *   - deltaT <= 300  (reversal bar not aggressively bullish)
 *
 * CONT signals removed (removed from live strategy-h.ts).
 *
 * Run with:
 *   cd apps/aggregator && npx tsx scripts/backfill_clean.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKS_DB_PATH   = path.resolve(__dirname, '../../../data/ticks.db');
const TRADING_DB_PATH = path.resolve(__dirname, '../../../data/trading.db');

// RTH: 09:30–16:00 ET = 13:30–20:00 UTC
const RTH_WINDOWS = [
  { label: 'MAY05', start: Date.UTC(2026, 4, 5,  13, 30), end: Date.UTC(2026, 4, 5,  20, 0) },
  { label: 'MAY06', start: Date.UTC(2026, 4, 6,  13, 30), end: Date.UTC(2026, 4, 6,  20, 0) },
  { label: 'MAY08', start: Date.UTC(2026, 4, 8,  13, 30), end: Date.UTC(2026, 4, 8,  20, 0) },
  { label: 'MAY09', start: Date.UTC(2026, 4, 9,  13, 30), end: Date.UTC(2026, 4, 9,  20, 0) },
  { label: 'MAY11', start: Date.UTC(2026, 4, 11, 13, 30), end: Date.UTC(2026, 4, 11, 20, 0) },
  { label: 'MAY12', start: Date.UTC(2026, 4, 12, 13, 30), end: Date.UTC(2026, 4, 12, 20, 0) },
];

// ── Strategy H thresholds (must stay in sync with strategy-h.ts) ─────────────

const MIN_1             = 60_000;
const MACRO_N           = 30;
const COOLDOWN_MS       = 15 * 60 * 1000;
const CROSS_COOLDOWN_MS = 45 * 60 * 1000;

const BODY_MIN = 5.0;

// LONG FLIP
const FLIP_COMP_MAX_LONG  = 0.30;
const FLIP_DELTA_T_LONG   =  300;
const FLIP_PRIOR3_LONG    = -100;

// SHORT FLIP — buyer exhaustion, not seller aggression
const FLIP_COMP_MIN_SHORT_HIGH  = 0.50;
const FLIP_COMP_MAX_SHORT_HIGH  = 1.00;
const FLIP_WICK_MIN_SHORT       = 15.0;
const FLIP_PRIOR_IMPULSE_SHORT  = 1400;
const FLIP_DELTA_T_SHORT_MAX    =  300;
const FLIP_BAR_RANGE_MIN_SHORT  = 22.0;

// ── Types ─────────────────────────────────────────────────────────────────────

interface Trade {
  ts: number;
  price: number;
  size: number;
  is_bid_aggressor: number;
}

interface OHLCBar {
  ts: number;
  open: number; high: number; low: number; close: number;
  vol: number; delta: number;
}

interface DetectedSignal {
  direction: 'long' | 'short';
  pattern: 'FLIP';
  score: number;
  compPos: number;
  deltaT: number;
  delta5: number;
  delta15: number;
  deltaLast3: number;
  body: number;
  entry: number;
  stopLevel: number;
  barTs: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toET(tsMs: number): string {
  return new Date(tsMs).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
}

// ── Bar builder ───────────────────────────────────────────────────────────────

function buildMinuteBars(trades: Trade[]): OHLCBar[] {
  const barMap = new Map<number, {
    open: number; close: number;
    high: number; low: number;
    bidVol: number; askVol: number;
  }>();

  for (const t of trades) {
    const barTs = Math.floor(t.ts / MIN_1) * MIN_1;
    const bar = barMap.get(barTs);
    if (!bar) {
      barMap.set(barTs, {
        open: t.price, close: t.price,
        high: t.price, low: t.price,
        bidVol: t.is_bid_aggressor === 1 ? t.size : 0,
        askVol: t.is_bid_aggressor === 0 ? t.size : 0,
      });
    } else {
      bar.high  = Math.max(bar.high,  t.price);
      bar.low   = Math.min(bar.low,   t.price);
      bar.close = t.price;
      if (t.is_bid_aggressor === 1) bar.bidVol += t.size;
      else                          bar.askVol += t.size;
    }
  }

  return Array.from(barMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([ts, bar]) => ({
      ts,
      open:  bar.open,
      high:  bar.high,
      low:   bar.low,
      close: bar.close,
      vol:   bar.bidVol + bar.askVol,
      delta: bar.bidVol - bar.askVol,
    }));
}

// ── Detection (mirrors strategy-h.ts detect(), without staleness guard) ───────

function detect(bars: OHLCBar[], idx: number): DetectedSignal | null {
  if (idx < MACRO_N) return null;

  const cur = bars[idx];
  if (!cur) return null;

  const macroBars = bars.slice(idx - MACRO_N, idx);
  if (macroBars.length < MACRO_N) return null;

  const macroHigh  = Math.max(...macroBars.map(b => b.high));
  const macroLow   = Math.min(...macroBars.map(b => b.low));
  const macroRange = macroHigh - macroLow;

  const compPos     = macroRange > 0 ? (cur.low  - macroLow) / macroRange : 0.5;
  const compPosHigh = macroRange > 0 ? (cur.high - macroLow) / macroRange : 0.5;

  const delta15    = bars.slice(Math.max(0, idx - 15), idx).reduce((s, b) => s + b.delta, 0);
  const delta5     = bars.slice(Math.max(0, idx -  5), idx).reduce((s, b) => s + b.delta, 0);
  const deltaLast3 = bars.slice(Math.max(0, idx -  3), idx).reduce((s, b) => s + b.delta, 0);
  const deltaT     = cur.delta;

  const prevBar  = bars[idx - 1];
  const prev2Bar = bars[idx - 2];
  const priorImpulse = Math.max(prevBar?.delta ?? 0, prev2Bar?.delta ?? 0);

  const bodyLong  = cur.close - cur.open;
  const bodyShort = cur.open  - cur.close;
  const upperWick = cur.high  - cur.close;

  // ── LONG FLIP ──────────────────────────────────────────────────────────────
  if (
    bodyLong  >= BODY_MIN          &&
    deltaT    >= FLIP_DELTA_T_LONG &&
    compPos   <= FLIP_COMP_MAX_LONG &&
    deltaLast3 <= FLIP_PRIOR3_LONG
  ) {
    let score = 80;
    if (deltaT >= 500)    score += 10;
    else if (deltaT >= 400) score += 5;
    if (bodyLong >= 15)   score += 5;
    if (compPos  <= 0.15) score += 5;
    score = Math.min(100, score);
    return {
      direction: 'long', pattern: 'FLIP', score,
      compPos, deltaT, delta5, delta15, deltaLast3,
      body: bodyLong, entry: cur.close, stopLevel: cur.low, barTs: cur.ts,
    };
  }

  // ── SHORT FLIP — buyer exhaustion ─────────────────────────────────────────
  if (
    bodyShort       >= BODY_MIN                  &&
    upperWick       >= FLIP_WICK_MIN_SHORT       &&
    compPosHigh     >= FLIP_COMP_MIN_SHORT_HIGH  &&
    compPosHigh     <= FLIP_COMP_MAX_SHORT_HIGH  &&
    priorImpulse    >= FLIP_PRIOR_IMPULSE_SHORT  &&
    deltaT          <= FLIP_DELTA_T_SHORT_MAX    &&
    (cur.high - cur.low) >= FLIP_BAR_RANGE_MIN_SHORT
  ) {
    let score = 80;
    if (bodyShort >= 15)        score += 5;
    if (upperWick >= 20)        score += 5;
    if (compPosHigh >= 0.80)    score += 5;
    if (priorImpulse >= 2000)   score += 5;
    score = Math.min(100, score);
    return {
      direction: 'short', pattern: 'FLIP', score,
      compPos: compPosHigh,  // HIGH-based for shorts
      deltaT, delta5, delta15, deltaLast3,
      body: bodyShort, entry: cur.close, stopLevel: cur.high, barTs: cur.ts,
    };
  }

  return null;
}

// ── Signal writer ─────────────────────────────────────────────────────────────

function writeSignal(
  tradingDb: Database.Database,
  symbol: string,
  hit: DetectedSignal,
  isPositionFlip: boolean,
): void {
  const signalTs = hit.barTs + MIN_1;  // bar open + 1 min = bar close time

  const existing = tradingDb.prepare(
    `SELECT id FROM signals WHERE ts = ? AND rule_id = 'clean-impulse' AND direction = ?`
  ).get(signalTs, hit.direction);
  if (existing) {
    console.log(`  ⚠️  ${toET(signalTs)} ${hit.direction} already exists — skipping`);
    return;
  }

  const entry      = hit.entry;
  const stop       = hit.stopLevel;
  const stopDist   = Math.abs(entry - stop);
  const isLong     = hit.direction === 'long';
  const oppositeDir = isLong ? 'short' : 'long';

  const fmt     = (n: number) => (n > 0 ? '+' : '') + n;
  const targets = isLong
    ? `T1=${entry + 20} (+20) T2=${entry + 40} (+40) T3=${entry + 60} (+60)`
    : `T1=${entry - 20} (-20) T2=${entry - 40} (-40) T3=${entry - 60} (-60)`;

  const flipPrefix = isPositionFlip
    ? `⚡ FLIP — CLOSE ${oppositeDir.toUpperCase()} / ENTER ${hit.direction.toUpperCase()}: `
    : '';
  const rationale =
    flipPrefix +
    `CLEAN-${hit.pattern} ${hit.direction.toUpperCase()}: ` +
    `body=${hit.body.toFixed(1)}pts, deltaT=${fmt(hit.deltaT)}, ` +
    `delta_last3=${fmt(hit.deltaLast3)}, delta5=${fmt(hit.delta5)}, delta15=${fmt(hit.delta15)}, ` +
    `comp_pos=${hit.compPos.toFixed(2)}. ` +
    `Entry=${entry} Stop=${stop} (${stopDist.toFixed(1)}pts). ${targets}.`;

  const payload = {
    ts:              signalTs,
    symbol,
    ruleId:          'clean-impulse',
    rule_id:         'clean-impulse',
    score:           hit.score,
    direction:       hit.direction,
    source:          'rules-v2',
    type:            'confluence',
    strategyVersion: 'H',
    ruleVersion:     'clean-v1',
    pattern:         hit.pattern,
    entry,
    stopLevel:       stop,
    stopDist,
    compPos:         hit.compPos,
    deltaT:          hit.deltaT,
    delta5:          hit.delta5,
    delta15:         hit.delta15,
    deltaLast3:      hit.deltaLast3,
    isPositionFlip,
    rationale,
  };

  tradingDb.prepare(`
    INSERT INTO signals
      (ts, symbol, rule_id, score, direction, strategy_version, rule_version, payload)
    VALUES (?, ?, 'clean-impulse', ?, ?, 'H', 'clean-v1', ?)
  `).run(signalTs, symbol, hit.score, hit.direction, JSON.stringify(payload));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== CLEAN Backfill — Strategy H (FLIP only, updated SHORT logic) ===\n');

  const ticksDb   = new Database(TICKS_DB_PATH,   { readonly: true });
  const tradingDb = new Database(TRADING_DB_PATH);

  const deleted = tradingDb.prepare(`DELETE FROM signals WHERE rule_id = 'clean-impulse'`).run();
  if (deleted.changes > 0) console.log(`Cleared ${deleted.changes} existing CLEAN signal(s)\n`);

  const symbol = (ticksDb.prepare(`SELECT DISTINCT symbol FROM trades WHERE symbol = 'NQ' LIMIT 1`).get() as any)?.symbol ?? 'NQ';
  console.log(`Symbol: ${symbol}\n`);

  let totalSignals = 0;

  for (const w of RTH_WINDOWS) {
    console.log(`─── ${w.label} (${toET(w.start)} → ${toET(w.end)}) ───`);

    const preStart  = w.start - MACRO_N * MIN_1;
    const allTrades = ticksDb.prepare(`
      SELECT ts, price, size, is_bid_aggressor
      FROM trades
      WHERE symbol = ? AND ts >= ? AND ts < ?
      ORDER BY ts ASC
    `).all(symbol, preStart, w.end) as Trade[];

    console.log(`  Loaded ${allTrades.length.toLocaleString()} trades`);

    if (allTrades.length < 100) {
      console.log('  No usable tick data — skipping\n');
      continue;
    }

    const bars = buildMinuteBars(allTrades);
    console.log(`  Built ${bars.length} 1-min bars\n`);

    const lastSignalMs: Record<string, number> = { long: 0, short: 0 };
    let daySignals = 0;

    for (let i = MACRO_N; i < bars.length; i++) {
      const bar = bars[i];
      if (!bar) continue;
      if (bar.ts < w.start || bar.ts >= w.end) continue;

      const hit = detect(bars, i);
      if (!hit) continue;

      if (bar.ts - (lastSignalMs[hit.direction] ?? 0) < COOLDOWN_MS) continue;
      // SHORT suppresses LONG; LONG does NOT suppress SHORT
      if (hit.direction === 'long') {
        if (bar.ts - (lastSignalMs['short'] ?? 0) < CROSS_COOLDOWN_MS) continue;
      }

      // Flip detection: opposite direction fired within 15 min
      const oppositeDir = hit.direction === 'long' ? 'short' : 'long';
      const isPositionFlip = (bar.ts - (lastSignalMs[oppositeDir] ?? 0)) < COOLDOWN_MS;
      lastSignalMs[hit.direction] = bar.ts;

      const stopDist = Math.abs(hit.entry - hit.stopLevel);
      console.log(
        `  ${hit.direction === 'long' ? '↑' : '↓'} CLEAN-FLIP ${hit.direction.toUpperCase()}` +
        ` @ ${toET(bar.ts + MIN_1)}` +
        (isPositionFlip ? ' ⚡FLIP' : '') +
        ` | score=${hit.score}` +
        ` | entry=${hit.entry}` +
        ` | stop=${hit.stopLevel} (${stopDist.toFixed(1)}pts)` +
        ` | comp_pos=${hit.compPos.toFixed(2)}` +
        ` | deltaT=${hit.deltaT > 0 ? '+' : ''}${hit.deltaT}`
      );

      writeSignal(tradingDb, symbol, hit, isPositionFlip);
      daySignals++;
      totalSignals++;
    }

    console.log(`  → ${daySignals} signal(s) written\n`);
  }

  ticksDb.close();
  tradingDb.close();

  console.log(`=== Done — ${totalSignals} CLEAN signal(s) written to trading.db ===\n`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
