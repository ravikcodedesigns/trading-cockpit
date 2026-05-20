/**
 * backtest-expl.ts
 * Retroactively runs EXPL strategy logic across May 8–9 2026 RTH tick data
 * and populates signals into trading.db so they appear on the cockpit chart.
 *
 * Run with:
 *   cd ~/trading-cockpit/apps/aggregator
 *   npx tsx src/backtest-expl.ts
 */

import Database from 'better-sqlite3';
import path from 'path';

// ─── Config ───────────────────────────────────────────────────────────────────

const TICKS_DB_PATH   = path.join(process.env.HOME || '', 'trading-cockpit/data/ticks.db');
const TRADING_DB_PATH = path.join(process.env.HOME || '', 'trading-cockpit/data/trading.db');

const BACKTEST_WINDOWS = [
  {
    label:    'MAY05',
    rthStart: Date.UTC(2026, 4, 5,  13, 30, 0),  // 09:30 ET
    rthEnd:   Date.UTC(2026, 4, 5,  20,  0, 0),  // 16:00 ET
  },
  {
    label:    'MAY06',
    rthStart: Date.UTC(2026, 4, 6,  13, 30, 0),  // 09:30 ET
    rthEnd:   Date.UTC(2026, 4, 6,  20,  0, 0),  // 16:00 ET
  },
  {
    label:    'MAY07',
    rthStart: Date.UTC(2026, 4, 7,  13, 30, 0),  // 09:30 ET
    rthEnd:   Date.UTC(2026, 4, 7,  20,  0, 0),  // 16:00 ET
  },
  {
    label:    'MAY08',
    rthStart: Date.UTC(2026, 4, 8,  13, 30, 0),  // 09:30 ET
    rthEnd:   Date.UTC(2026, 4, 8,  20,  0, 0),  // 16:00 ET
  },
  {
    label:    'MAY09',
    rthStart: Date.UTC(2026, 4, 9,  13, 30, 0),  // 09:30 ET
    rthEnd:   Date.UTC(2026, 4, 9,  20,  0, 0),  // 16:00 ET
  },
];

// EXPL thresholds
const LOOKBACK_MS                  = 60 * 60 * 1000;
const STACKED_BID_MIN_LEVELS       = 3;
const STACKED_BID_MIN_RATIO        = 3.0;
const STACKED_BID_MIN_CONTRACTS    = 10;
const STACKED_BID_ZONE_TOLERANCE   = 2.0;
const LARGE_LOT_MIN_SIZE           = 30;
const LARGE_LOT_MAX_ABOVE_LOW      = 5.0;
const COMPRESSION_BARS             = 5;
const COMPRESSION_MAX_RANGE        = 12.0;
const PROFILE_A_NEGATIVE_THRESHOLD = -500;
const PROFILE_A_RECOVERY_MIN       = 200;
const PROFILE_B_POSITIVE_MIN       = 1500;
const SHAKEOUT_SPIKE_MULTIPLIER    = 2.0;
const MIN_SCORE_TO_FIRE            = 3;
const COOLDOWN_MS                  = 15 * 60 * 1000;
const BAR_INTERVAL_MS              = 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toET(tsMs: number): string {
  const d  = new Date(tsMs - 4 * 60 * 60 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} ET`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Trade {
  ts:               number;
  price:            number;
  size:             number;
  is_bid_aggressor: number;  // 1 = buy, 0 = sell
}

interface MinuteBar {
  ts:       number;
  high:     number;
  low:      number;
  volume:   number;
  delta:    number;
  cumDelta: number;
}

interface FootprintLevel {
  periodStart: number;
  price:       number;
  bidVol:      number;
  askVol:      number;
  ratio:       number;
}

// ─── Data Loader ──────────────────────────────────────────────────────────────

function getSymbol(db: Database.Database): string {
  const row = db.prepare(`SELECT DISTINCT symbol FROM trades LIMIT 1`).get() as any;
  return row?.symbol ?? 'NQ';
}

function loadTrades(
  db: Database.Database,
  symbol: string,
  fromMs: number,
  toMs: number
): Trade[] {
  return db.prepare(`
    SELECT ts, price, size, is_bid_aggressor
    FROM trades
    WHERE symbol = ? AND ts >= ? AND ts < ?
    ORDER BY ts ASC
  `).all(symbol, fromMs, toMs) as Trade[];
}

// ─── Aggregators ──────────────────────────────────────────────────────────────

function buildMinuteBars(trades: Trade[]): MinuteBar[] {
  const barMap = new Map<number, { high: number; low: number; bidVol: number; askVol: number }>();

  for (const t of trades) {
    const barTs = Math.floor(t.ts / BAR_INTERVAL_MS) * BAR_INTERVAL_MS;
    const bar   = barMap.get(barTs) ?? { high: -Infinity, low: Infinity, bidVol: 0, askVol: 0 };
    bar.high = Math.max(bar.high, t.price);
    bar.low  = Math.min(bar.low,  t.price);
    if (t.is_bid_aggressor === 1) bar.bidVol += t.size;
    else                          bar.askVol += t.size;
    barMap.set(barTs, bar);
  }

  let cumDelta = 0;
  return Array.from(barMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([ts, bar]) => {
      const delta = bar.bidVol - bar.askVol;
      cumDelta   += delta;
      return {
        ts,
        high:     bar.high,
        low:      bar.low,
        volume:   bar.bidVol + bar.askVol,
        delta,
        cumDelta,
      };
    });
}

function buildFootprint(trades: Trade[]): FootprintLevel[] {
  const PERIOD = 5 * 60 * 1000;
  const map    = new Map<string, { bidVol: number; askVol: number }>();

  for (const t of trades) {
    const ps   = Math.floor(t.ts / PERIOD) * PERIOD;
    const key  = `${ps}:${t.price}`;
    const cell = map.get(key) ?? { bidVol: 0, askVol: 0 };
    if (t.is_bid_aggressor === 1) cell.bidVol += t.size;
    else                          cell.askVol += t.size;
    map.set(key, cell);
  }

  return Array.from(map.entries()).map(([key, cell]) => {
    const [ps, price] = key.split(':').map(Number);
    const ratio = cell.askVol === 0
      ? cell.bidVol * 1000
      : cell.bidVol / cell.askVol;
    return { periodStart: ps, price, bidVol: cell.bidVol, askVol: cell.askVol, ratio };
  });
}

// ─── Detectors ────────────────────────────────────────────────────────────────

function detectStackedBidZones(footprint: FootprintLevel[]): number[] {
  const periods = new Map<number, FootprintLevel[]>();
  for (const row of footprint) {
    if (!periods.has(row.periodStart)) periods.set(row.periodStart, []);
    periods.get(row.periodStart)!.push(row);
  }

  const allZones: { midpoint: number; periodStart: number }[] = [];

  for (const [periodStart, rows] of periods) {
    const sorted = [...rows].sort((a, b) => b.price - a.price);
    let streak = 0, streakHigh = 0, streakLow = 0;

    for (const r of sorted) {
      if (r.ratio >= STACKED_BID_MIN_RATIO && r.bidVol >= STACKED_BID_MIN_CONTRACTS) {
        if (streak === 0) streakHigh = r.price;
        streak++;
        streakLow = r.price;
      } else {
        if (streak >= STACKED_BID_MIN_LEVELS) {
          allZones.push({ midpoint: (streakHigh + streakLow) / 2, periodStart });
        }
        streak = 0;
      }
    }
    if (streak >= STACKED_BID_MIN_LEVELS) {
      allZones.push({ midpoint: (streakHigh + streakLow) / 2, periodStart });
    }
  }

  const confirmed: number[] = [];
  for (let i = 0; i < allZones.length; i++) {
    for (let j = i + 1; j < allZones.length; j++) {
      if (allZones[i].periodStart === allZones[j].periodStart) continue;
      if (Math.abs(allZones[i].midpoint - allZones[j].midpoint) <= STACKED_BID_ZONE_TOLERANCE) {
        const mid = allZones[i].midpoint;
        if (!confirmed.some(z => Math.abs(z - mid) <= STACKED_BID_ZONE_TOLERANCE)) {
          confirmed.push(mid);
        }
      }
    }
  }

  return confirmed;
}

function detectLargeLotAtLow(
  trades: Trade[],
  windowLow: number
): { price: number; size: number; ts: number } | null {
  const candidates = trades.filter(
    t => t.is_bid_aggressor === 1 &&
         t.size >= LARGE_LOT_MIN_SIZE &&
         t.price <= windowLow + LARGE_LOT_MAX_ABOVE_LOW
  );
  if (candidates.length === 0) return null;
  const best = candidates.reduce((b, c) => c.size > b.size ? c : b);
  return { price: best.price, size: best.size, ts: best.ts };
}

function classifyCumDelta(bars: MinuteBar[]): 'A' | 'B' | null {
  if (bars.length < 5) return null;
  const cds    = bars.map(b => b.cumDelta);
  const minCD  = Math.min(...cds);
  const lastCD = cds[cds.length - 1];
  const minIdx = cds.indexOf(minCD);

  if (
    minCD <= PROFILE_A_NEGATIVE_THRESHOLD &&
    minIdx < cds.length - 1 &&
    lastCD - minCD >= PROFILE_A_RECOVERY_MIN
  ) return 'A';

  const posCount = cds.filter(d => d >= PROFILE_B_POSITIVE_MIN).length;
  if (posCount >= cds.length * 0.6 && lastCD >= PROFILE_B_POSITIVE_MIN) return 'B';

  return null;
}

function detectCompression(bars: MinuteBar[]): number | null {
  if (bars.length < COMPRESSION_BARS) return null;
  const lastN = bars.slice(-COMPRESSION_BARS);
  const avg   = lastN.reduce((s, b) => s + (b.high - b.low), 0) / lastN.length;
  return avg < COMPRESSION_MAX_RANGE ? avg : null;
}

function detectShakeout(bars: MinuteBar[]): boolean {
  if (bars.length < 12) return false;
  for (let i = 10; i < bars.length; i++) {
    const avgVol = bars.slice(i - 10, i).reduce((s, b) => s + b.volume, 0) / 10;
    const bar    = bars[i];
    if (bar.volume >= avgVol * SHAKEOUT_SPIKE_MULTIPLIER && bar.delta < 0) {
      const held = bars.slice(i + 1).every(b => b.low >= bar.low - 1.0);
      if (held) return true;
    }
  }
  return false;
}

// ─── Signal Writer ────────────────────────────────────────────────────────────

function writeSignal(
  tradingDb: Database.Database,
  symbol:    string,
  ts:        number,
  score:     number,
  explData:  object
) {
  const existing = tradingDb.prepare(
    `SELECT id FROM signals WHERE ts = ? AND rule_id = 'expl'`
  ).get(ts);

  if (existing) {
    console.log(`  ⚠️  Signal at ${toET(ts)} already exists — skipping`);
    return;
  }

  // Payload must be a full ConfluenceSignal-compatible object so that
  // Chart.tsx can render it: needs ts, symbol, ruleId, direction, score,
  // strategyVersion. EXPL-specific data is merged in alongside.
  const payload = {
    // Core signal fields — required by Chart.tsx and quality gate
    ts,
    symbol,
    ruleId:          'expl',
    rule_id:         'expl',    // snake_case alias for DB signals
    score,
    direction:       'long',    // stored lowercase to match Chart.tsx check
    source:          'rules-v2',
    type:            'confluence',
    strategyVersion: 'EXPL',
    ruleVersion:     'expl-v1',
    observeOnly:     true,
    // EXPL-specific data
    ...explData,
  };

  tradingDb.prepare(`
    INSERT INTO signals (ts, symbol, rule_id, score, direction, payload, strategy_version, rule_version)
    VALUES (?, ?, 'expl', ?, 'long', ?, 'EXPL', 'expl-v1')
  `).run(ts, symbol, score, JSON.stringify(payload));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔍 EXPL Backtest — May 8–9 2026\n');

  const ticksDb   = new Database(TICKS_DB_PATH,   { readonly: true });
  const tradingDb = new Database(TRADING_DB_PATH);

  // Delete any previously inserted EXPL signals (old payloads missing core fields)
  const deleted = tradingDb.prepare(`DELETE FROM signals WHERE rule_id = 'expl'`).run();
  if (deleted.changes > 0) {
    console.log(`🗑  Cleared ${deleted.changes} old EXPL signal(s) with incomplete payloads\n`);
  }

  const symbol = getSymbol(ticksDb);
  console.log(`Symbol detected: ${symbol}\n`);

  let totalSignals = 0;

  for (const window of BACKTEST_WINDOWS) {
    console.log(`━━━ ${window.label} ━━━`);
    console.log(`RTH: ${toET(window.rthStart)} → ${toET(window.rthEnd)}`);

    // Load from 60 min before RTH so first bar has full lookback
    const preMarketStart = window.rthStart - LOOKBACK_MS;
    const allTrades      = loadTrades(ticksDb, symbol, preMarketStart, window.rthEnd);

    console.log(`  Loaded ${allTrades.length.toLocaleString()} trades`);

    if (allTrades.length === 0) {
      console.log('  ⚠️  No tick data found — skipping\n');
      continue;
    }

    let lastSignalTs = 0;

    for (let barTs = window.rthStart; barTs < window.rthEnd; barTs += BAR_INTERVAL_MS) {
      if (barTs - lastSignalTs < COOLDOWN_MS) continue;

      const fromMs       = barTs - LOOKBACK_MS;
      const windowTrades = allTrades.filter(t => t.ts >= fromMs && t.ts < barTs);
      if (windowTrades.length < 100) continue;

      const minuteBars = buildMinuteBars(windowTrades);
      const footprint  = buildFootprint(windowTrades);
      if (minuteBars.length < 10) continue;

      const windowHigh = Math.max(...minuteBars.map(b => b.high));
      const windowLow  = Math.min(...minuteBars.map(b => b.low));

      const stackedBidZones = detectStackedBidZones(footprint);
      const largeLot        = detectLargeLotAtLow(windowTrades, windowLow);
      const profile         = classifyCumDelta(minuteBars);
      const compressionAvg  = detectCompression(minuteBars);
      const shakeout        = detectShakeout(minuteBars);

      const conditions: string[] = [];
      let score = 0;

      if (stackedBidZones.length > 0) {
        score++;
        conditions.push(`Stacked BID zones @ ${stackedBidZones.map(z => z.toFixed(2)).join(', ')}`);
      }
      if (largeLot) {
        score++;
        conditions.push(`${largeLot.size}-lot BUY @ ${largeLot.price.toFixed(2)}`);
      }
      if (profile) {
        score++;
        conditions.push(`Cum delta Profile ${profile}`);
      }
      if (compressionAvg !== null) {
        score++;
        conditions.push(`Compression ${compressionAvg.toFixed(1)}pt avg range`);
      }
      if (shakeout) {
        score++;
        conditions.push(`Shakeout absorbed`);
      }

      if (score < MIN_SCORE_TO_FIRE) continue;

      // Disqualifier: new low after large lot print
      if (largeLot) {
        const afterPrint = minuteBars.filter(b => b.ts > largeLot.ts);
        const newLow     = afterPrint.some(b => b.low < largeLot.price - 2.0);
        if (newLow) continue;
      }

      lastSignalTs = barTs;
      totalSignals++;

      console.log(`\n  🚀 EXPL — ${toET(barTs)}`);
      console.log(`     Score:       ${score}/5`);
      console.log(`     Profile:     ${profile ?? 'none'}`);
      console.log(`     Range:       ${windowLow.toFixed(2)} — ${windowHigh.toFixed(2)}`);
      console.log(`     Compression: ${compressionAvg?.toFixed(1) ?? 'n/a'} pts`);
      conditions.forEach(c => console.log(`     ✅ ${c}`));

      writeSignal(tradingDb, symbol, barTs, score, {
        profile,
        rangeLow:        windowLow,
        rangeHigh:       windowHigh,
        compressionAvg,
        stackedBidZones,
        largeLotPrice:   largeLot?.price ?? null,
        largeLotSize:    largeLot?.size  ?? null,
        shakeout,
        conditions,
        rationale: `EXPL [RTH]: ${score}/5 confluences — ${conditions.join(' | ')}`,
      });
    }

    console.log('');
  }

  ticksDb.close();
  tradingDb.close();

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ Done — ${totalSignals} EXPL signal(s) written to trading.db`);
  console.log(`   Restart the aggregator and reload the cockpit to see them.\n`);
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
