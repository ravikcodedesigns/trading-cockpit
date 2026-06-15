// Phase 1A — Touch event detector.
//
// For each train day × Tier-1 level (PDH/PDL/PDC/POC/VAH/VAL/IBH/IBL):
//   1. Build 1-min OHLC bars from ticks.db
//   2. Compute rolling ATR(5m) and ATR(10m)
//   3. Walk a state machine per level: INACTIVE → INSIDE_PROXIMITY → (possibly BREACHED) → back out
//   4. Emit a touch event each time price enters the proximity zone
//
// Proximity threshold is volatility-adjusted: proximity = K × ATR(5m)
// Approach distance threshold is also volatility-adjusted: M × ATR(10m)
//
// Each touch is classified into a touch_type:
//   FRESH         — first touch of the day, level intact
//   RETEST_CLOSE  — 2nd+ touch, prior excursion < 15pt, no breach
//   RETEST_FAR    — 2nd+ touch, prior excursion 15–30pt, no breach
//   POST_BREACH   — touch after level was breached by > BREACH_THRESHOLD pts
//
// Output: phase1-touches-<set>.json (one row per touch event)
//
// Usage:
//   tsx scripts/phase1/detect_touches.ts --set train
//   tsx scripts/phase1/detect_touches.ts --set test

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRAIN_DAYS, TEST_DAYS, TIER1_LEVELS, RTH_START, RTH_END } from './days.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../../..');
const TICKS_DB = path.join(REPO, 'data/ticks.db');
const LEVELS_FILE = path.join(REPO, 'daily_levels.json');

// ── Tunables (default; the train phase will sweep K & M to find the sweet spot) ──
const K_PROXIMITY = 1.0;       // proximity = K × ATR(5m)
const M_APPROACH  = 1.5;       // require approach distance ≥ M × ATR(10m)
const BREACH_THRESHOLD = 5.0;  // pts past level = "breached"
const RETEST_FAR_THRESHOLD = 15.0;  // pts excursion separating CLOSE vs FAR retest
const RETEST_MAX_EXCURSION = 30.0;  // beyond this = no longer "retest" territory
const COOLDOWN_MIN_MIN = 5;    // min minutes between consecutive touches on same level
const MIN_PROXIMITY_PT = 1.0;  // floor on proximity to avoid 0 on quiet bars

// Look-ahead guard: IBH/IBL are computed by the EVENING structural cron from
// today's 09:30–10:30 RTH range. In real-time they are NOT KNOWN before 10:30 ET.
// Suppress touch events on these levels until the IB-lock time.
const IB_LOCK_LEVELS = new Set(['IBH', 'IBL']);
const IB_LOCK_TIME = { hour: 10, minute: 30 };

// ── ET helpers (DST-safe) ──
function etDateOf(tsMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(tsMs));
}
function etTimeAt(day: string, hour: number, minute: number): number {
  const [y, m, d] = day.split('-').map(Number);
  // Probe at noon to determine offset, then anchor at hour/minute.
  const noonUtc = Date.UTC(y!, m! - 1, d!, 12, 0, 0);
  const noonEtHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false })
      .format(new Date(noonUtc)),
    10,
  );
  // UTC = ET + offset.  noonEtHour=8 during EDT → offset=4, so UTC = ET + 4.
  const offsetHours = 12 - noonEtHour;
  return Date.UTC(y!, m! - 1, d!, hour + offsetHours, minute);
}

// ── 1-min bar builder ──
interface Bar {
  ts: number;            // bar open ts in ms (minute boundary, UTC ms)
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
}

function buildMinuteBars(
  ticksDb: Database.Database,
  symbol: string,
  fromMs: number,
  toMs: number,
): Bar[] {
  const stmt = ticksDb.prepare(`
    SELECT ts, price, size FROM trades
    WHERE symbol = ? AND ts >= ? AND ts < ?
    ORDER BY ts ASC
  `);
  const bars = new Map<number, Bar>();
  for (const row of stmt.iterate(symbol, fromMs, toMs) as IterableIterator<{ts:number;price:number;size:number}>) {
    const bucket = Math.floor(row.ts / 60_000) * 60_000;
    let b = bars.get(bucket);
    if (!b) {
      b = { ts: bucket, open: row.price, high: row.price, low: row.price, close: row.price, vol: 0 };
      bars.set(bucket, b);
    }
    b.high = Math.max(b.high, row.price);
    b.low  = Math.min(b.low,  row.price);
    b.close = row.price;
    b.vol += row.size;
  }
  return [...bars.values()].sort((a, b) => a.ts - b.ts);
}

// ── ATR(N): mean true range over last N bars ──
// Returns same length as bars; index i is ATR computed over bars[i-N..i-1].
function computeATR(bars: Bar[], window: number): number[] {
  const out: number[] = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    if (i < window) { out[i] = bars[i]!.high - bars[i]!.low; continue; }
    let sum = 0;
    for (let j = i - window; j < i; j++) {
      const b = bars[j]!;
      const prev = j > 0 ? bars[j - 1]!.close : b.open;
      const tr = Math.max(
        b.high - b.low,
        Math.abs(b.high - prev),
        Math.abs(b.low - prev),
      );
      sum += tr;
    }
    out[i] = sum / window;
  }
  return out;
}

// ── Touch event ──
interface TouchEvent {
  day: string;
  level_label: string;
  level_price: number;
  touch_ts: number;
  touch_price: number;
  approach_dir: 'from_above' | 'from_below';
  approach_dist_5m_signed: number;    // signed pts: positive = moved into level direction
  approach_dist_10m_signed: number;
  atr_5m: number;
  atr_10m: number;
  proximity_used: number;
  n_touch: number;
  max_excursion_since_prev: number;   // 0 if first touch
  was_breached_before: boolean;
  touch_type: 'FRESH' | 'RETEST_CLOSE' | 'RETEST_FAR' | 'POST_BREACH';
}

// ── Per-level state machine ──
interface LevelState {
  label: string;
  price: number;
  initialSide: 'above' | 'below' | null;  // which side price opened on
  inProximity: boolean;       // currently within proximity
  hadBreach: boolean;         // price has crossed level AND traveled >BREACH_THRESHOLD on opposite side
  lastTouchTs: number;        // ts of last completed touch
  lastTouchIdx: number;       // bar idx of last touch
  nTouchEmitted: number;      // count of emitted touches
  maxExcursionSinceLast: number;  // |distance from level| since last touch
}

function classifyTouch(
  s: LevelState,
  wasBreachedBefore: boolean,
): TouchEvent['touch_type'] {
  if (s.nTouchEmitted === 0 && !wasBreachedBefore) return 'FRESH';
  if (wasBreachedBefore) return 'POST_BREACH';
  if (s.maxExcursionSinceLast < RETEST_FAR_THRESHOLD) return 'RETEST_CLOSE';
  if (s.maxExcursionSinceLast <= RETEST_MAX_EXCURSION) return 'RETEST_FAR';
  return 'POST_BREACH';  // > 30pt = treating as broken anyway
}

// ── Day-level processor ──
function processDay(
  ticksDb: Database.Database,
  day: string,
  levelMap: Map<string, number>,  // label → price
): TouchEvent[] {
  const rthStart = etTimeAt(day, RTH_START.hour, RTH_START.minute);
  const rthEnd   = etTimeAt(day, RTH_END.hour,   RTH_END.minute);
  const ibLockTs = etTimeAt(day, IB_LOCK_TIME.hour, IB_LOCK_TIME.minute);
  // We need ~15min of pre-RTH for ATR seeding.
  const fromMs = rthStart - 30 * 60_000;
  const bars = buildMinuteBars(ticksDb, 'NQ', fromMs, rthEnd);

  if (bars.length < 20) {
    console.warn(`  ${day}: only ${bars.length} bars — skipping`);
    return [];
  }

  const atr5  = computeATR(bars, 5);
  const atr10 = computeATR(bars, 10);

  // Initialize per-level state
  const states = new Map<string, LevelState>();
  for (const [label, price] of levelMap) {
    states.set(label, {
      label, price,
      initialSide: null,
      inProximity: false,
      hadBreach: false,
      lastTouchTs: 0,
      lastTouchIdx: -1,
      nTouchEmitted: 0,
      maxExcursionSinceLast: 0,
    });
  }

  const events: TouchEvent[] = [];

  // Walk bars; only emit touches during RTH proper.
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.ts < rthStart) continue;
    if (b.ts > rthEnd)   break;

    const a5  = Math.max(atr5[i]  ?? 0, MIN_PROXIMITY_PT);
    const a10 = Math.max(atr10[i] ?? 0, MIN_PROXIMITY_PT);
    const proximity = Math.max(K_PROXIMITY * a5, MIN_PROXIMITY_PT);

    for (const s of states.values()) {
      const dist = b.close - s.price;          // signed
      const absDist = Math.abs(dist);
      const wasInProximity = s.inProximity;
      const isNowInProximity = absDist <= proximity;

      // Set initial side on first RTH bar (deciding whether opening "above" or "below" level)
      if (s.initialSide === null) {
        s.initialSide = dist >= 0 ? 'above' : 'below';
      }

      // Track max excursion since last touch
      if (s.nTouchEmitted > 0 && absDist > s.maxExcursionSinceLast) {
        s.maxExcursionSinceLast = absDist;
      }

      // Breach detection — only if price has CROSSED to the opposite side
      // AND traveled > BREACH_THRESHOLD past the level on that opposite side.
      // The initial-side check prevents flagging "level is far from open" as breached.
      if (!s.hadBreach) {
        const currentSide = dist >= 0 ? 'above' : 'below';
        if (currentSide !== s.initialSide && absDist > BREACH_THRESHOLD) {
          s.hadBreach = true;
        }
      }

      // Transition INACTIVE → INSIDE: emit touch event
      if (!wasInProximity && isNowInProximity) {
        s.inProximity = true;

        // Cooldown: don't emit if last touch was <COOLDOWN_MIN_MIN ago
        if (s.lastTouchTs > 0 && (b.ts - s.lastTouchTs) < COOLDOWN_MIN_MIN * 60_000) continue;

        // Approach direction: where was price 5 minutes ago relative to the level?
        const ref5  = i >= 5  ? bars[i - 5]!.close  : bars[0]!.close;
        const ref10 = i >= 10 ? bars[i - 10]!.close : bars[0]!.close;
        const approachDir: 'from_above' | 'from_below' = ref5 > s.price ? 'from_above' : 'from_below';

        // Approach distances (signed: positive = moved toward level in expected direction)
        const sign = approachDir === 'from_above' ? 1 : -1;
        const d5  = (ref5  - b.close) * sign;
        const d10 = (ref10 - b.close) * sign;

        // Gate: require meaningful approach
        const minApproach = M_APPROACH * a10;
        if (d5 < minApproach) continue;

        // Look-ahead gate: IBH/IBL are not real-time-known until 10:30 ET (see
        // IB_LOCK_LEVELS comment). Suppress any touch event on these levels
        // before the lock time.
        if (IB_LOCK_LEVELS.has(s.label) && b.ts < ibLockTs) continue;

        // Classify touch type
        const wasBreachedBefore = s.hadBreach;
        const touchType = classifyTouch(s, wasBreachedBefore);

        events.push({
          day,
          level_label: s.label,
          level_price: s.price,
          touch_ts: b.ts,
          touch_price: b.close,
          approach_dir: approachDir,
          approach_dist_5m_signed: +d5.toFixed(2),
          approach_dist_10m_signed: +d10.toFixed(2),
          atr_5m: +a5.toFixed(2),
          atr_10m: +a10.toFixed(2),
          proximity_used: +proximity.toFixed(2),
          n_touch: s.nTouchEmitted + 1,
          max_excursion_since_prev: s.nTouchEmitted === 0 ? 0 : +s.maxExcursionSinceLast.toFixed(2),
          was_breached_before: wasBreachedBefore,
          touch_type: touchType,
        });

        s.nTouchEmitted++;
        s.lastTouchTs = b.ts;
        s.lastTouchIdx = i;
        s.maxExcursionSinceLast = 0;
      }

      // Transition INSIDE → INACTIVE: leaving proximity zone
      if (wasInProximity && !isNowInProximity) {
        s.inProximity = false;
      }
    }
  }

  return events;
}

// ── Main ──
function main() {
  const argv = process.argv.slice(2);
  const setArg = argv.includes('--set') ? argv[argv.indexOf('--set') + 1] : 'train';
  const days: readonly string[] =
    setArg === 'test' ? TEST_DAYS :
    setArg === 'train' ? TRAIN_DAYS :
    (() => { throw new Error(`Unknown --set ${setArg}; use train or test`); })();

  const ticksDb = new Database(TICKS_DB, { readonly: true });
  const levelsJson = JSON.parse(fs.readFileSync(LEVELS_FILE, 'utf8'));

  const allEvents: TouchEvent[] = [];
  const perDayCounts: Record<string, number> = {};

  for (const day of days) {
    const entry = levelsJson.days?.[day];
    if (!entry) {
      console.warn(`  ${day}: no daily_levels entry — skip`);
      perDayCounts[day] = 0;
      continue;
    }
    const levelsArr = entry.levels?.[0]?.additionalLevels ?? [];
    const levelMap = new Map<string, number>();
    for (const lvl of levelsArr) {
      if (TIER1_LEVELS.includes(lvl.label)) {
        levelMap.set(lvl.label, lvl.price);
      }
    }
    if (levelMap.size === 0) {
      console.warn(`  ${day}: no Tier-1 levels — skip`);
      perDayCounts[day] = 0;
      continue;
    }

    const events = processDay(ticksDb, day, levelMap);
    allEvents.push(...events);
    perDayCounts[day] = events.length;
    console.log(`  ${day}: ${events.length} touches (${levelMap.size} levels watched)`);
  }

  const outFile = path.join(REPO, `phase1-touches-${setArg}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    set: setArg,
    days_processed: days.length,
    total_touches: allEvents.length,
    per_day_counts: perDayCounts,
    config: {
      K_PROXIMITY, M_APPROACH, BREACH_THRESHOLD,
      RETEST_FAR_THRESHOLD, RETEST_MAX_EXCURSION,
      COOLDOWN_MIN_MIN, MIN_PROXIMITY_PT,
    },
    events: allEvents,
  }, null, 2));
  console.log(`\nWrote ${allEvents.length} touches → ${outFile}`);

  // Quick per-level + per-type summary
  const byLevel = new Map<string, number>();
  const byType  = new Map<string, number>();
  const byDir   = new Map<string, number>();
  for (const e of allEvents) {
    byLevel.set(e.level_label, (byLevel.get(e.level_label) ?? 0) + 1);
    byType.set(e.touch_type, (byType.get(e.touch_type) ?? 0) + 1);
    byDir.set(e.approach_dir, (byDir.get(e.approach_dir) ?? 0) + 1);
  }
  console.log('\n-- By level --');
  for (const [k, v] of [...byLevel.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(8)} ${v}`);
  }
  console.log('\n-- By touch_type --');
  for (const [k, v] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(15)} ${v}`);
  }
  console.log('\n-- By approach_dir --');
  for (const [k, v] of byDir.entries()) {
    console.log(`  ${k.padEnd(12)} ${v}`);
  }
}

main();
