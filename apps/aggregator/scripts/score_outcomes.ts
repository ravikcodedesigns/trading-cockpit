/**
 * Outcome Scorer
 *
 * Walks the signals table, computes price-movement outcomes for each signal
 * (peak gain, peak drawdown, close, net move at 5/15/30/60 minute windows), and writes to
 * two tables:
 *   - signal_outcomes_matured: finalized scores for signals 60+ min old
 *   - signal_outcomes_partial: in-progress scores for signals < 60 min old
 *
 * Idempotent: matured rows are never recomputed. Partial rows are recomputed
 * on each run. When a partial signal ages past 60 min, it gets promoted to
 * matured (deleted from partial, inserted into matured).
 *
 * peak_gain = max gain in signal direction during window
 * peak_drawdown = max drawdown against signal direction during window
 *
 * Run: pnpm --filter aggregator score
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Config ---

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Script lives in apps/aggregator/scripts/, db is at trading-cockpit/data/trading.db
const DB_PATH = path.resolve(__dirname, '../../../data/trading.db');

const WINDOWS_MIN = [5, 15, 30, 60] as const;
const MATURITY_MIN = 60;            // signal must be this old before "matured"
const GAIN_BANDS = [20, 30, 40] as const;  // NQ-point thresholds for "win"

type WindowMin = (typeof WINDOWS_MIN)[number];

// --- Types ---

interface SignalRow {
  id: number;
  ts: number;
  symbol: string;
  rule_id: string;
  score: number;
  direction: 'long' | 'short';
  payload: string;
}

interface SignalPayload {
  // Common
  ts: number;
  symbol: string;
  // Sweep payload (the original event referenced in confluence)
  // Confluence signal payloads embed the rationale + score; the source
  // event is logged separately. We'll use the bar at signal time as
  // signal-time price.
  [k: string]: unknown;
}

interface BarRow {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  payload: string;
}

interface WindowOutcome {
  windowMin: WindowMin;
  signalPrice: number;
  endPrice: number;
  maxGain: number;          // peak gain in the signal direction (positive = good)
  maxDrawdown: number;          // peak drawdown against signal direction (positive = pain)
  netMove: number;      // close - signalPrice, signed by direction
  hit20: boolean;
  hit30: boolean;
  hit40: boolean;
  cleanHit20: boolean;  // hit20 AND maxDrawdown < 5
  cleanHit30: boolean;
  cleanHit40: boolean;
  bars: number;         // how many bars contributed (for diagnostics)
}

// --- DB setup ---

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Schema for outcome tables. Same columns for both; the only difference is
// matured rows never re-score, partial rows re-score on every run.
const createTable = (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  signal_id     INTEGER PRIMARY KEY,
  signal_ts     INTEGER NOT NULL,
  symbol        TEXT NOT NULL,
  rule_id       TEXT NOT NULL,
  score         INTEGER NOT NULL,
  direction     TEXT NOT NULL,
  signal_price  REAL NOT NULL,
  -- 5min window
  w5_end        REAL, w5_max_gain REAL, w5_max_drawdown REAL, w5_net REAL,
  w5_hit20 INTEGER, w5_hit30 INTEGER, w5_hit40 INTEGER,
  w5_clean20 INTEGER, w5_clean30 INTEGER, w5_clean40 INTEGER,
  w5_bars  INTEGER,
  -- 15min window
  w15_end       REAL, w15_max_gain REAL, w15_max_drawdown REAL, w15_net REAL,
  w15_hit20 INTEGER, w15_hit30 INTEGER, w15_hit40 INTEGER,
  w15_clean20 INTEGER, w15_clean30 INTEGER, w15_clean40 INTEGER,
  w15_bars INTEGER,
  -- 30min window
  w30_end       REAL, w30_max_gain REAL, w30_max_drawdown REAL, w30_net REAL,
  w30_hit20 INTEGER, w30_hit30 INTEGER, w30_hit40 INTEGER,
  w30_clean20 INTEGER, w30_clean30 INTEGER, w30_clean40 INTEGER,
  w30_bars INTEGER,
  -- 60min window
  w60_end       REAL, w60_max_gain REAL, w60_max_drawdown REAL, w60_net REAL,
  w60_hit20 INTEGER, w60_hit30 INTEGER, w60_hit40 INTEGER,
  w60_clean20 INTEGER, w60_clean30 INTEGER, w60_clean40 INTEGER,
  w60_bars INTEGER,
  -- Metadata
  last_scored_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_${name}_ts        ON ${name}(signal_ts);
CREATE INDEX IF NOT EXISTS idx_${name}_rule      ON ${name}(rule_id, score);
CREATE INDEX IF NOT EXISTS idx_${name}_direction ON ${name}(direction);
`;

db.exec(createTable('signal_outcomes_matured'));
db.exec(createTable('signal_outcomes_partial'));

// --- Helpers ---

/** Find the bar that contains the given timestamp (1-min bucket). */
function getBarAtOrBefore(symbol: string, ts: number): BarRow | null {
  const row = db.prepare(`
    SELECT ts,
           json_extract(payload,'$.open')  AS open,
           json_extract(payload,'$.high')  AS high,
           json_extract(payload,'$.low')   AS low,
           json_extract(payload,'$.close') AS close,
           payload
    FROM events
    WHERE source = 'bookmap'
      AND type   = 'bar'
      AND symbol = ?
      AND ts <= ?
    ORDER BY ts DESC
    LIMIT 1
  `).get(symbol, ts) as BarRow | undefined;
  return row ?? null;
}

/** Get all bars with bucket-start in [tsStart, tsEnd]. Deduplicates partial vs final per bucket. */
function getBars(symbol: string, tsStart: number, tsEnd: number): BarRow[] {
  // Fetch all bar payloads in range; dedupe by bucket-start (ts), keeping latest insertion
  // (which is the most-complete partial or the final close-of-minute bar).
  const rows = db.prepare(`
    SELECT ts,
           json_extract(payload,'$.open')  AS open,
           json_extract(payload,'$.high')  AS high,
           json_extract(payload,'$.low')   AS low,
           json_extract(payload,'$.close') AS close,
           payload
    FROM events
    WHERE source = 'bookmap'
      AND type   = 'bar'
      AND symbol = ?
      AND ts BETWEEN ? AND ?
    ORDER BY ts ASC, id ASC
  `).all(symbol, tsStart, tsEnd) as BarRow[];

  // Dedupe by bucket-start; later inserts (more complete payloads) win
  const byBucket = new Map<number, BarRow>();
  for (const r of rows) byBucket.set(r.ts, r);
  return Array.from(byBucket.values()).sort((a, b) => a.ts - b.ts);
}

/** Compute peak gain/drawdown/close for a long signal across the given bars. */
function computeWindowLong(signalPrice: number, bars: BarRow[]): Omit<WindowOutcome, 'windowMin' | 'signalPrice' | 'hit20' | 'hit30' | 'hit40' | 'cleanHit20' | 'cleanHit30' | 'cleanHit40'> {
  if (bars.length === 0) {
    return { endPrice: signalPrice, maxGain: 0, maxDrawdown: 0, netMove: 0, bars: 0 };
  }
  let maxHigh = bars[0].high;
  let minLow = bars[0].low;
  for (const b of bars) {
    if (b.high > maxHigh) maxHigh = b.high;
    if (b.low < minLow) minLow = b.low;
  }
  const endPrice = bars[bars.length - 1].close;
  return {
    endPrice,
    maxGain: Math.max(0, maxHigh - signalPrice),
    maxDrawdown: Math.max(0, signalPrice - minLow),
    netMove: endPrice - signalPrice,
    bars: bars.length,
  };
}

/** Compute peak gain/drawdown/close for a short signal. */
function computeWindowShort(signalPrice: number, bars: BarRow[]): Omit<WindowOutcome, 'windowMin' | 'signalPrice' | 'hit20' | 'hit30' | 'hit40' | 'cleanHit20' | 'cleanHit30' | 'cleanHit40'> {
  if (bars.length === 0) {
    return { endPrice: signalPrice, maxGain: 0, maxDrawdown: 0, netMove: 0, bars: 0 };
  }
  let maxHigh = bars[0].high;
  let minLow = bars[0].low;
  for (const b of bars) {
    if (b.high > maxHigh) maxHigh = b.high;
    if (b.low < minLow) minLow = b.low;
  }
  const endPrice = bars[bars.length - 1].close;
  return {
    endPrice,
    // For shorts, favorable = price went DOWN (signalPrice - low)
    maxGain: Math.max(0, signalPrice - minLow),
    // Adverse = price went UP against us (high - signalPrice)
    maxDrawdown: Math.max(0, maxHigh - signalPrice),
    netMove: signalPrice - endPrice,  // positive = good for short
    bars: bars.length,
  };
}

/** Add hit/clean flags to a window result. */
function decorateWindow(windowMin: WindowMin, signalPrice: number, raw: ReturnType<typeof computeWindowLong>): WindowOutcome {
  const maxGain = raw.maxGain;
  const maxDrawdown = raw.maxDrawdown;
  return {
    ...raw,
    windowMin,
    signalPrice,
    hit20: maxGain >= 20,
    hit30: maxGain >= 30,
    hit40: maxGain >= 40,
    cleanHit20: maxGain >= 20 && maxDrawdown < 5,
    cleanHit30: maxGain >= 30 && maxDrawdown < 5,
    cleanHit40: maxGain >= 40 && maxDrawdown < 5,
  };
}

// --- Main scorer ---

const insertMatured = db.prepare(`
  INSERT OR REPLACE INTO signal_outcomes_matured (
    signal_id, signal_ts, symbol, rule_id, score, direction, signal_price,
    w5_end,  w5_max_gain,  w5_max_drawdown,  w5_net,  w5_hit20,  w5_hit30,  w5_hit40,  w5_clean20,  w5_clean30,  w5_clean40,  w5_bars,
    w15_end, w15_max_gain, w15_max_drawdown, w15_net, w15_hit20, w15_hit30, w15_hit40, w15_clean20, w15_clean30, w15_clean40, w15_bars,
    w30_end, w30_max_gain, w30_max_drawdown, w30_net, w30_hit20, w30_hit30, w30_hit40, w30_clean20, w30_clean30, w30_clean40, w30_bars,
    w60_end, w60_max_gain, w60_max_drawdown, w60_net, w60_hit20, w60_hit30, w60_hit40, w60_clean20, w60_clean30, w60_clean40, w60_bars,
    last_scored_at
  ) VALUES (
    ?,?,?,?,?,?,?,
    ?,?,?,?,?,?,?,?,?,?,?,
    ?,?,?,?,?,?,?,?,?,?,?,
    ?,?,?,?,?,?,?,?,?,?,?,
    ?,?,?,?,?,?,?,?,?,?,?,
    ?
  )
`);

const insertPartial = db.prepare(`
  INSERT OR REPLACE INTO signal_outcomes_partial (
    signal_id, signal_ts, symbol, rule_id, score, direction, signal_price,
    w5_end,  w5_max_gain,  w5_max_drawdown,  w5_net,  w5_hit20,  w5_hit30,  w5_hit40,  w5_clean20,  w5_clean30,  w5_clean40,  w5_bars,
    w15_end, w15_max_gain, w15_max_drawdown, w15_net, w15_hit20, w15_hit30, w15_hit40, w15_clean20, w15_clean30, w15_clean40, w15_bars,
    w30_end, w30_max_gain, w30_max_drawdown, w30_net, w30_hit20, w30_hit30, w30_hit40, w30_clean20, w30_clean30, w30_clean40, w30_bars,
    w60_end, w60_max_gain, w60_max_drawdown, w60_net, w60_hit20, w60_hit30, w60_hit40, w60_clean20, w60_clean30, w60_clean40, w60_bars,
    last_scored_at
  ) VALUES (
    ?,?,?,?,?,?,?,
    ?,?,?,?,?,?,?,?,?,?,?,
    ?,?,?,?,?,?,?,?,?,?,?,
    ?,?,?,?,?,?,?,?,?,?,?,
    ?,?,?,?,?,?,?,?,?,?,?,
    ?
  )
`);

const deleteFromPartial = db.prepare('DELETE FROM signal_outcomes_partial WHERE signal_id = ?');
const checkMaturedExists = db.prepare('SELECT 1 FROM signal_outcomes_matured WHERE signal_id = ?');

function scoreSignal(sig: SignalRow): { status: 'matured' | 'partial' | 'skipped'; reason?: string } {
  // Already matured? Skip.
  if (checkMaturedExists.get(sig.id)) return { status: 'skipped', reason: 'already matured' };

  // Find signal-time price: the bar containing the signal timestamp
  const bar = getBarAtOrBefore(sig.symbol, sig.ts);
  if (!bar) return { status: 'skipped', reason: 'no bar at signal time' };

  // Use the close of the bar containing the signal as signal-time price.
  // This is approximately what was visible to a trader watching the chart
  // when the signal fired — within 1 minute of the actual event.
  const signalPrice = bar.close;
  const now = Date.now();
  const ageMin = (now - sig.ts) / 60_000;
  const isMatured = ageMin >= MATURITY_MIN;

  // Compute outcomes for all four windows.
  const computeFor = sig.direction === 'long' ? computeWindowLong : computeWindowShort;
  const outcomes: Record<WindowMin, WindowOutcome> = {} as never;

  for (const wMin of WINDOWS_MIN) {
    const tsEnd = sig.ts + wMin * 60_000;
    // For partial signals, only compute window if data is available.
    if (tsEnd > now) {
      // Window not yet complete — fill with a stub (zeros + 0 bars)
      outcomes[wMin] = decorateWindow(wMin, signalPrice, {
        endPrice: signalPrice, maxGain: 0, maxDrawdown: 0, netMove: 0, bars: 0,
      });
      continue;
    }
    const bars = getBars(sig.symbol, sig.ts, tsEnd);
    const raw = computeFor(signalPrice, bars);
    outcomes[wMin] = decorateWindow(wMin, signalPrice, raw);
  }

  // Pack into the prepared-statement param order.
  const w = (m: WindowMin) => {
    const o = outcomes[m];
    return [o.endPrice, o.maxGain, o.maxDrawdown, o.netMove,
            o.hit20 ? 1 : 0, o.hit30 ? 1 : 0, o.hit40 ? 1 : 0,
            o.cleanHit20 ? 1 : 0, o.cleanHit30 ? 1 : 0, o.cleanHit40 ? 1 : 0,
            o.bars];
  };

  const params = [
    sig.id, sig.ts, sig.symbol, sig.rule_id, sig.score, sig.direction, signalPrice,
    ...w(5), ...w(15), ...w(30), ...w(60),
    now,
  ];

  if (isMatured) {
    insertMatured.run(...params);
    deleteFromPartial.run(sig.id);  // promote: remove from partial table if it was there
    return { status: 'matured' };
  } else {
    insertPartial.run(...params);
    return { status: 'partial' };
  }
}

function main() {
  console.log('Outcome scorer running...');
  console.log(`DB: ${DB_PATH}`);

  const signals = db.prepare(`
    SELECT id, ts, symbol, rule_id, score, direction, payload
    FROM signals
    ORDER BY ts ASC
  `).all() as SignalRow[];

  console.log(`Found ${signals.length} total signals`);

  let nMatured = 0;
  let nPartial = 0;
  let nSkipped = 0;

  for (const sig of signals) {
    const result = scoreSignal(sig);
    if (result.status === 'matured') nMatured++;
    else if (result.status === 'partial') nPartial++;
    else nSkipped++;
  }

  console.log(`Newly matured: ${nMatured}`);
  console.log(`Currently partial: ${nPartial}`);
  console.log(`Skipped (already matured): ${nSkipped}`);

  // Summary
  const totalMatured = (db.prepare('SELECT COUNT(*) AS c FROM signal_outcomes_matured').get() as { c: number }).c;
  const totalPartial = (db.prepare('SELECT COUNT(*) AS c FROM signal_outcomes_partial').get() as { c: number }).c;
  console.log(`\nTotal matured outcomes: ${totalMatured}`);
  console.log(`Total partial outcomes: ${totalPartial}`);
}

main();
db.close();
