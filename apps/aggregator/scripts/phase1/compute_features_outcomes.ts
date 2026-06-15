// Phase 1B + 1C — Feature computation + outcome labeling.
//
// Reads phase1-touches-<set>.json from detect_touches.ts, enriches each
// event with:
//   • TICK-BASED FEATURES (Phase 1B):
//       - approach_velocity_{1,3,5,10}m  (signed pts/min into level)
//       - approach_cvd_{5,10,15}m        (raw cumulative delta in window)
//       - approach_cvd_ratio_{5,10,15}m  (delta/vol in same window)
//       - tick_density_{10,30,60}s       (trades/sec immediately before touch)
//       - volume_at_level_60m            (total volume traded within ±2pt of level in last 60min)
//       - absorption_score               (|delta_at_level| × vol_at_level / (1 + |price_excursion|))
//       - bucket                         (OPEN / MID / CLOSE)
//
//   • OUTCOMES (Phase 1C):
//       For each TP/SL combo in TP_SL_GRID:
//         For each direction in {FADE, BREAKOUT}:
//           Walk ticks forward 30 min; record TP / SL / TIMEOUT.
//           Apply 5pt slippage on exit per the agreed model.
//
// Output: phase1-events-<set>.json
//
// Usage:
//   tsx scripts/phase1/compute_features_outcomes.ts --set train
//   tsx scripts/phase1/compute_features_outcomes.ts --set test

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../../..');
const TICKS_DB = path.join(REPO, 'data/ticks.db');

const TIMEOUT_MIN = 30;
const SLIP_PT = 5;                  // 5pt slippage on exit (per agreed model)
const LEVEL_VOL_HALF_WIDTH_PT = 2;  // ±2pt window for "volume at level"
const VOL_PROFILE_WINDOW_MIN = 60;

// TP/SL grid — same nominal values for both FADE and BREAKOUT directions.
const TP_SL_GRID: Array<[number, number]> = [
  [15, 5], [20, 5], [30, 10], [40, 10], [50, 20], [80, 20],
];

// ── Helpers ──
function bucketForTs(tsMs: number): 'OPEN' | 'MID' | 'CLOSE' {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(tsMs));
  const hh = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const mm = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  const minutes = hh * 60 + mm;
  if (minutes < 10 * 60 + 30) return 'OPEN';
  if (minutes < 14 * 60 + 30) return 'MID';
  return 'CLOSE';
}

function etDate(tsMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(tsMs));
}

function rthCloseMs(tsMs: number): number {
  const day = etDate(tsMs);
  const [y, m, d] = day.split('-').map(Number);
  const noonUtc = Date.UTC(y!, m! - 1, d!, 12, 0, 0);
  const noonEtHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false })
      .format(new Date(noonUtc)),
    10,
  );
  // UTC = ET + offset
  const offsetHours = 12 - noonEtHour;
  return Date.UTC(y!, m! - 1, d!, 15 + offsetHours, 54);
}

// ── Tick-window aggregations ──
interface TickAgg {
  count: number;
  vol: number;
  delta: number;          // bid-aggressor vol − ask-aggressor vol
  netPriceMove: number;   // last_price − first_price
  firstPrice: number;
  lastPrice: number;
  volAtLevel: number;     // size within ±LEVEL_VOL_HALF_WIDTH_PT of the level (if specified)
  deltaAtLevel: number;
}

function aggregateTicks(
  ticksDb: Database.Database,
  symbol: string,
  fromMs: number,
  toMs: number,
  levelPrice: number | null = null,
): TickAgg {
  const stmt = ticksDb.prepare(`
    SELECT ts, price, size, is_bid_aggressor
    FROM trades WHERE symbol = ? AND ts >= ? AND ts < ?
    ORDER BY ts ASC
  `);
  const agg: TickAgg = {
    count: 0, vol: 0, delta: 0, netPriceMove: 0,
    firstPrice: 0, lastPrice: 0,
    volAtLevel: 0, deltaAtLevel: 0,
  };
  let first = true;
  for (const r of stmt.iterate(symbol, fromMs, toMs) as IterableIterator<{ts:number;price:number;size:number;is_bid_aggressor:number}>) {
    if (first) { agg.firstPrice = r.price; first = false; }
    agg.lastPrice = r.price;
    agg.count++;
    agg.vol += r.size;
    const signed = r.is_bid_aggressor === 1 ? r.size : -r.size;
    agg.delta += signed;
    if (levelPrice !== null && Math.abs(r.price - levelPrice) <= LEVEL_VOL_HALF_WIDTH_PT) {
      agg.volAtLevel += r.size;
      agg.deltaAtLevel += signed;
    }
  }
  agg.netPriceMove = agg.lastPrice - agg.firstPrice;
  return agg;
}

// ── Outcome walker ──
interface OutcomeResult {
  result: 'TP' | 'SL' | 'TIMEOUT';
  exit_ts: number;
  exit_price: number;
  raw_pnl_pts: number;     // before slippage (nominal)
  slip_pnl_pts: number;    // after −5pt exit slippage
}

function walkOutcome(
  ticksDb: Database.Database,
  symbol: string,
  openTs: number,
  endTs: number,
  entryPrice: number,
  direction: 'long' | 'short',
  tp: number,
  sl: number,
): OutcomeResult {
  const tpPx = direction === 'long' ? entryPrice + tp : entryPrice - tp;
  const slPx = direction === 'long' ? entryPrice - sl : entryPrice + sl;
  const stmt = ticksDb.prepare(`
    SELECT ts, price FROM trades WHERE symbol = ? AND ts > ? AND ts <= ?
    ORDER BY ts ASC
  `);
  let lastPx = entryPrice, lastTs = openTs;
  for (const r of stmt.iterate(symbol, openTs, endTs) as IterableIterator<{ts:number;price:number}>) {
    lastPx = r.price; lastTs = r.ts;
    if (direction === 'long') {
      if (r.price <= slPx) {
        return {
          result: 'SL', exit_ts: r.ts, exit_price: slPx,
          raw_pnl_pts: -sl,
          slip_pnl_pts: -(sl + SLIP_PT),
        };
      }
      if (r.price >= tpPx) {
        return {
          result: 'TP', exit_ts: r.ts, exit_price: tpPx,
          raw_pnl_pts: tp,
          slip_pnl_pts: tp - SLIP_PT,
        };
      }
    } else {
      if (r.price >= slPx) {
        return {
          result: 'SL', exit_ts: r.ts, exit_price: slPx,
          raw_pnl_pts: -sl,
          slip_pnl_pts: -(sl + SLIP_PT),
        };
      }
      if (r.price <= tpPx) {
        return {
          result: 'TP', exit_ts: r.ts, exit_price: tpPx,
          raw_pnl_pts: tp,
          slip_pnl_pts: tp - SLIP_PT,
        };
      }
    }
  }
  // Timeout — mark-to-market with slippage on the assumed market-out
  const rawPnl = direction === 'long' ? (lastPx - entryPrice) : (entryPrice - lastPx);
  return {
    result: 'TIMEOUT', exit_ts: lastTs, exit_price: lastPx,
    raw_pnl_pts: +rawPnl.toFixed(2),
    slip_pnl_pts: +(rawPnl - SLIP_PT).toFixed(2),
  };
}

// ── Main ──
function main() {
  const argv = process.argv.slice(2);
  const setArg = argv.includes('--set') ? argv[argv.indexOf('--set') + 1] : 'train';
  const inFile = path.join(REPO, `phase1-touches-${setArg}.json`);
  const outFile = path.join(REPO, `phase1-events-${setArg}.json`);

  const ticksDb = new Database(TICKS_DB, { readonly: true });
  const input = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const touches = input.events as Array<Record<string, unknown>>;

  console.log(`Loaded ${touches.length} touches from ${inFile}`);

  const enriched = touches.map((e, idx) => {
    const ts = e.touch_ts as number;
    const levelPrice = e.level_price as number;
    const touchPrice = e.touch_price as number;
    const approachDir = e.approach_dir as 'from_above' | 'from_below';

    // ── FEATURES ──
    // Approach velocity across windows
    const velocities: Record<string, number> = {};
    for (const w of [1, 3, 5, 10]) {
      const winFrom = ts - w * 60_000;
      const agg = aggregateTicks(ticksDb, 'NQ', winFrom, ts);
      // Signed velocity: positive when price moved into the level in the expected direction.
      // from_above: price came DOWN to level → firstPrice > lastPrice → netPriceMove < 0 → velocity sign-flip negative
      // We want positive = moving toward level, so:
      const into = approachDir === 'from_above' ? -agg.netPriceMove : agg.netPriceMove;
      velocities[`velocity_${w}m_signed`] = +(into / w).toFixed(3);
    }

    // CVD ratios + absolute CVD across windows
    const cvds: Record<string, number> = {};
    for (const w of [5, 10, 15]) {
      const winFrom = ts - w * 60_000;
      const agg = aggregateTicks(ticksDb, 'NQ', winFrom, ts);
      cvds[`cvd_${w}m`] = agg.delta;
      cvds[`cvd_ratio_${w}m`] = agg.vol > 0 ? +(agg.delta / agg.vol).toFixed(4) : 0;
    }

    // Tick density (trades per second) — recent only
    const densities: Record<string, number> = {};
    for (const w of [10, 30, 60]) {
      const winFrom = ts - w * 1000;
      const agg = aggregateTicks(ticksDb, 'NQ', winFrom, ts);
      densities[`density_${w}s_tps`] = +(agg.count / w).toFixed(2);
    }

    // Volume at level (60min, ±2pt) + absorption score
    const lvlAgg = aggregateTicks(ticksDb, 'NQ', ts - VOL_PROFILE_WINDOW_MIN * 60_000, ts, levelPrice);
    const absorptionScore = lvlAgg.volAtLevel > 0
      ? +(Math.abs(lvlAgg.deltaAtLevel) * lvlAgg.volAtLevel / (1 + Math.abs(lvlAgg.netPriceMove))).toFixed(0)
      : 0;

    // Time-of-day bucket
    const bucket = bucketForTs(ts);

    // ── OUTCOMES ──
    // For each TP/SL × direction, walk ticks forward.
    const endTs = Math.min(ts + TIMEOUT_MIN * 60_000, rthCloseMs(ts));
    const outcomes: Record<string, { fade: OutcomeResult; breakout: OutcomeResult }> = {};
    for (const [tp, sl] of TP_SL_GRID) {
      const key = `${tp}/${sl}`;
      // FADE direction: long if from_above, short if from_below
      const fadeDir: 'long' | 'short' = approachDir === 'from_above' ? 'long' : 'short';
      // BREAKOUT direction: opposite of FADE
      const brkDir: 'long' | 'short' = fadeDir === 'long' ? 'short' : 'long';

      outcomes[key] = {
        fade: walkOutcome(ticksDb, 'NQ', ts, endTs, touchPrice, fadeDir, tp, sl),
        breakout: walkOutcome(ticksDb, 'NQ', ts, endTs, touchPrice, brkDir, tp, sl),
      };
    }

    if ((idx + 1) % 25 === 0) console.log(`  processed ${idx + 1}/${touches.length}`);

    return {
      ...e,
      features: {
        ...velocities,
        ...cvds,
        ...densities,
        volume_at_level_60m: lvlAgg.volAtLevel,
        delta_at_level_60m: lvlAgg.deltaAtLevel,
        absorption_score: absorptionScore,
        bucket,
      },
      outcomes,
    };
  });

  fs.writeFileSync(outFile, JSON.stringify({
    set: setArg,
    config: {
      TIMEOUT_MIN, SLIP_PT, LEVEL_VOL_HALF_WIDTH_PT, VOL_PROFILE_WINDOW_MIN,
      TP_SL_GRID,
    },
    n_events: enriched.length,
    events: enriched,
  }, null, 2));

  console.log(`\nWrote ${enriched.length} enriched events → ${outFile}`);
}

main();
