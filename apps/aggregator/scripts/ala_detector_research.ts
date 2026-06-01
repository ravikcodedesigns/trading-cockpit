/**
 * ala_detector_research.ts — Absorption at Level (ALA) detector research.
 *
 * The mechanic discovered in mhp_hp_touch_analysis.ts: when price touches
 * MHP / HP / ON_MHP / ON_HP with heavy NEGATIVE delta (sellers hitting the bid
 * aggressively) but the level holds, price tends to snap upward 40pt within
 * 30 min. Pattern is "failed selling at institutional level" — absorption.
 *
 * This script tests a precise detector with adjustable thresholds against the
 * labeled outcomes (40pt up / 10pt max DD / 30-min horizon).
 *
 * Conventions:
 *   is_bid_aggressor=1 → BUY aggressor (verified empirically)
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');
const LEVELS_JSON= path.resolve(__dirname, '../../../daily_levels.json');

const TARGET_PTS  = 40;
const MAX_DD_PTS  = 10;
const HORIZON_MS  = 30 * 60_000;

type Trade = { ts: number; price: number; size: number; isBidAgg: 0|1 };
type Bar = {
  minStartTs: number;
  open: number; high: number; low: number; close: number;
  vol: number; delta: number;
  numTrades: number;
  maxTradeSize: number;
  largePrints1: number;
  largePrints2: number;
};

type LevelName = 'MHP' | 'HP' | 'ON_MHP' | 'ON_HP';

function etMin(ts: number): number {
  const d = new Date(ts - 4 * 60 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function etHHMMSS(ts: number): string {
  const d = new Date(ts - 4 * 60 * 60_000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
}

function loadTrades(db: Database.Database, date: string): Trade[] {
  const startTs = Date.parse(`${date}T08:00:00-04:00`);
  const endTs   = Date.parse(`${date}T16:30:00-04:00`);
  return db.prepare(
    `SELECT ts, price, size, is_bid_aggressor AS isBidAgg
     FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?
     ORDER BY ts ASC, id ASC`
  ).all(startTs, endTs) as Trade[];
}

function buildBars(trades: Trade[]): Bar[] {
  const bars: Bar[] = [];
  let cur: Bar | null = null;
  for (const t of trades) {
    const bk = Math.floor(t.ts / 60_000) * 60_000;
    if (!cur || cur.minStartTs !== bk) {
      if (cur) bars.push(cur);
      cur = {
        minStartTs: bk, open: t.price, high: t.price, low: t.price, close: t.price,
        vol: 0, delta: 0, numTrades: 0, maxTradeSize: 0, largePrints1: 0, largePrints2: 0,
      };
    }
    if (t.price > cur.high) cur.high = t.price;
    if (t.price < cur.low)  cur.low  = t.price;
    cur.close = t.price;
    cur.vol += t.size;
    cur.numTrades++;
    if (t.size > cur.maxTradeSize) cur.maxTradeSize = t.size;
    if (t.size >= 10) cur.largePrints1++;
    if (t.size >= 25) cur.largePrints2++;
    if (t.isBidAgg === 1) cur.delta += t.size;
    else                  cur.delta -= t.size;
  }
  if (cur) bars.push(cur);
  return bars;
}

interface DayLevels { mhp: number | null; hp: number | null; on_mhp: number | null; on_hp: number | null; }
function loadLevels(): Record<string, DayLevels> {
  const raw = JSON.parse(fs.readFileSync(LEVELS_JSON, 'utf-8'));
  const days = raw.days ?? {};
  const out: Record<string, DayLevels> = {};
  for (const [date, entry] of Object.entries(days)) {
    const lv = (entry as any).levels?.[0] ?? {};
    const add = (lv.additionalLevels ?? []) as { price?: number; label?: string }[];
    const byLabel: Record<string, number> = {};
    for (const a of add) if (typeof a.price === 'number' && a.label) byLabel[a.label] = a.price;
    out[date] = {
      mhp:    typeof lv.mhp === 'number' ? lv.mhp : null,
      hp:     typeof lv.hedgePressure === 'number' ? lv.hedgePressure : null,
      on_mhp: byLabel['ON MHP'] ?? null,
      on_hp:  byLabel['ON HP']  ?? null,
    };
  }
  return out;
}

// ─── Forward outcome (40pt up, 10pt max DD, 30-min horizon) ─────────────────

interface Outcome {
  result: 'WIN_UP' | 'WIN_DOWN' | 'LOSS' | 'TIMEOUT';
  maxUp: number; maxDn: number; resolveMs: number;
}
function forwardOutcome(barCloseTs: number, barClose: number, trades: Trade[]): Outcome {
  let lo = 0, hi = trades.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (trades[m].ts <= barCloseTs) lo = m + 1; else hi = m; }
  const endTs = barCloseTs + HORIZON_MS;
  let maxUp = 0, maxDn = 0;
  for (let i = lo; i < trades.length && trades[i].ts <= endTs; i++) {
    const px = trades[i].price;
    const up = px - barClose, dn = barClose - px;
    if (up > maxUp) maxUp = up;
    if (dn > maxDn) maxDn = dn;
    if (maxUp >= TARGET_PTS && maxDn < MAX_DD_PTS) return { result: 'WIN_UP', maxUp, maxDn, resolveMs: trades[i].ts - barCloseTs };
    if (maxDn >= TARGET_PTS && maxUp < MAX_DD_PTS) return { result: 'WIN_DOWN', maxUp, maxDn, resolveMs: trades[i].ts - barCloseTs };
    if (maxUp >= MAX_DD_PTS && maxDn >= MAX_DD_PTS) return { result: 'LOSS', maxUp, maxDn, resolveMs: trades[i].ts - barCloseTs };
  }
  return { result: 'TIMEOUT', maxUp, maxDn, resolveMs: HORIZON_MS };
}

// ─── ALA detector ───────────────────────────────────────────────────────────

interface ALACfg {
  name: string;
  deltaMax:        number;   // bar delta must be ≤ this (more negative)
  rangeMin:        number;
  rangeMax:        number;
  bodyPctMin:      number;
  bodyPctMax:      number;
  closeInRangeMin: number;
  closeInRangeMax: number;
  volMin:          number;
  // New context filters
  prev15DeltaMin?: number;   // require prev-15-bar delta ≥ this
  prev15DeltaMax?: number;   // require prev-15-bar delta ≤ this
  cooldownMs:      number;
}

function detect(bars: Bar[], bi: number, level: number, cfg: ALACfg): boolean {
  if (bi < 15) return false;
  const b = bars[bi]!;
  // Touch
  if (b.low > level || b.high < level) return false;
  // Delta — sellers must be present
  if (b.delta > cfg.deltaMax) return false;
  // Volume floor
  if (b.vol < cfg.volMin) return false;
  // Range
  const range = b.high - b.low;
  if (range < cfg.rangeMin || range > cfg.rangeMax) return false;
  // Body — moderate
  const body = Math.abs(b.close - b.open);
  const bodyPct = range > 0 ? body / range : 0;
  if (bodyPct < cfg.bodyPctMin || bodyPct > cfg.bodyPctMax) return false;
  // Close position — not at extreme bottom (avoid pure breakdown)
  const closeIn = range > 0 ? (b.close - b.low) / range : 0.5;
  if (closeIn < cfg.closeInRangeMin || closeIn > cfg.closeInRangeMax) return false;
  // Prev-15 delta context
  if (cfg.prev15DeltaMin != null || cfg.prev15DeltaMax != null) {
    let prev15Delta = 0;
    for (let k = bi - 15; k < bi; k++) prev15Delta += bars[k]!.delta;
    if (cfg.prev15DeltaMin != null && prev15Delta < cfg.prev15DeltaMin) return false;
    if (cfg.prev15DeltaMax != null && prev15Delta > cfg.prev15DeltaMax) return false;
  }
  return true;
}

interface Trigger {
  date: string; barTs: number;
  level: LevelName; levelPrice: number;
  open: number; high: number; low: number; close: number;
  range: number; bodyPct: number; closeInRange: number;
  vol: number; delta: number;
  outcome: Outcome['result'];
  maxUp: number; maxDn: number;
}

function runVariant(cfg: ALACfg, allLevels: Record<string, DayLevels>, db: Database.Database): Trigger[] {
  const trigs: Trigger[] = [];
  const dates = Object.keys(allLevels).sort();
  // Per (date, level, direction) cooldown
  const lastSignalMs: Record<string, number> = {};
  for (const date of dates) {
    const lv = allLevels[date];
    if (!lv || (lv.mhp == null && lv.hp == null && lv.on_mhp == null && lv.on_hp == null)) continue;
    const trades = loadTrades(db, date);
    if (trades.length < 1000) continue;
    const bars = buildBars(trades);
    if (bars.length < 60) continue;
    const candidateLevels: [LevelName, number|null][] = [
      ['MHP', lv.mhp], ['HP', lv.hp], ['ON_MHP', lv.on_mhp], ['ON_HP', lv.on_hp],
    ];
    for (const [lvName, lvPrice] of candidateLevels) {
      if (lvPrice == null) continue;
      for (let bi = 15; bi < bars.length; bi++) {
        const b = bars[bi]!;
        const m = etMin(b.minStartTs);
        if (m < 9*60+30 || m > 15*60+55) continue;
        if (!detect(bars, bi, lvPrice, cfg)) continue;
        // Cooldown per (date, level)
        const key = `${date}|${lvName}`;
        if (b.minStartTs - (lastSignalMs[key] ?? -Infinity) < cfg.cooldownMs) continue;
        lastSignalMs[key] = b.minStartTs;
        const out = forwardOutcome(b.minStartTs + 60_000, b.close, trades);
        const range = b.high - b.low;
        const body = Math.abs(b.close - b.open);
        const bodyPct = range > 0 ? body / range : 0;
        const closeIn = range > 0 ? (b.close - b.low) / range : 0.5;
        trigs.push({
          date, barTs: b.minStartTs,
          level: lvName, levelPrice: lvPrice,
          open: b.open, high: b.high, low: b.low, close: b.close,
          range, bodyPct, closeInRange: closeIn,
          vol: b.vol, delta: b.delta,
          outcome: out.result, maxUp: out.maxUp, maxDn: out.maxDn,
        });
      }
    }
  }
  return trigs;
}

function summarize(label: string, trigs: Trigger[]): void {
  const wu = trigs.filter(t => t.outcome === 'WIN_UP').length;
  const wd = trigs.filter(t => t.outcome === 'WIN_DOWN').length;
  const ls = trigs.filter(t => t.outcome === 'LOSS').length;
  const to = trigs.filter(t => t.outcome === 'TIMEOUT').length;
  const n = trigs.length;
  const wrUp = n ? (wu / n) * 100 : 0;
  const wrAny = n ? ((wu + wd) / n) * 100 : 0;
  console.log(
    `${label.padEnd(22)}  n=${String(n).padStart(3)}  WIN_UP=${String(wu).padStart(2)}  WIN_DOWN=${String(wd).padStart(2)}  ` +
    `LOSS=${String(ls).padStart(2)}  TO=${String(to).padStart(2)}  ` +
    `WR_UP=${wrUp.toFixed(1).padStart(5)}%  WR_ANY=${wrAny.toFixed(1).padStart(5)}%`
  );
}

async function main(): Promise<void> {
  console.log('ALA (Absorption at Level) detector research — target=40pt up, DD≤10pt, 30-min horizon\n');
  const allLevels = loadLevels();
  const db = new Database(TICKS_DB, { readonly: true });
  db.pragma('journal_mode = WAL');

  const variants: ALACfg[] = [
    {
      name: 'V1_loose',
      deltaMax: -100, rangeMin: 5, rangeMax: 80, bodyPctMin: 0.05, bodyPctMax: 0.95,
      closeInRangeMin: 0.00, closeInRangeMax: 1.00, volMin: 1000, cooldownMs: 5 * 60_000,
    },
    {
      name: 'V2_deltaTight',
      deltaMax: -300, rangeMin: 5, rangeMax: 80, bodyPctMin: 0.05, bodyPctMax: 0.95,
      closeInRangeMin: 0.00, closeInRangeMax: 1.00, volMin: 1000, cooldownMs: 5 * 60_000,
    },
    {
      name: 'V3_rangeCap',
      deltaMax: -300, rangeMin: 5, rangeMax: 40, bodyPctMin: 0.05, bodyPctMax: 0.95,
      closeInRangeMin: 0.00, closeInRangeMax: 1.00, volMin: 1000, cooldownMs: 5 * 60_000,
    },
    {
      name: 'V4_closeInLowerHalf',
      deltaMax: -300, rangeMin: 5, rangeMax: 40, bodyPctMin: 0.05, bodyPctMax: 0.85,
      closeInRangeMin: 0.00, closeInRangeMax: 0.50, volMin: 1000, cooldownMs: 5 * 60_000,
    },
    {
      name: 'V5_closeMidish',
      deltaMax: -300, rangeMin: 5, rangeMax: 40, bodyPctMin: 0.10, bodyPctMax: 0.80,
      closeInRangeMin: 0.00, closeInRangeMax: 0.50, volMin: 1500, cooldownMs: 5 * 60_000,
    },
    {
      name: 'V6_strict',
      deltaMax: -400, rangeMin: 8, rangeMax: 40, bodyPctMin: 0.20, bodyPctMax: 0.80,
      closeInRangeMin: 0.00, closeInRangeMax: 0.50, volMin: 2000, cooldownMs: 5 * 60_000,
    },
    {
      name: 'V7_widerRange',
      deltaMax: -400, rangeMin: 8, rangeMax: 60, bodyPctMin: 0.20, bodyPctMax: 0.95,
      closeInRangeMin: 0.00, closeInRangeMax: 0.50, volMin: 2000, cooldownMs: 5 * 60_000,
    },
    {
      name: 'V8_heavyDelta',
      deltaMax: -700, rangeMin: 5, rangeMax: 80, bodyPctMin: 0.05, bodyPctMax: 0.99,
      closeInRangeMin: 0.00, closeInRangeMax: 0.50, volMin: 2000, cooldownMs: 5 * 60_000,
    },
    {
      name: 'V9_deltaPlus',
      deltaMax: -500, rangeMin: 8, rangeMax: 60, bodyPctMin: 0.20, bodyPctMax: 0.95,
      closeInRangeMin: 0.00, closeInRangeMax: 0.40, volMin: 3000, cooldownMs: 5 * 60_000,
    },
    {
      name: 'V10_skipBreakdown',
      // Skip pure breakdown bars: body ≤ 75% (so wick is meaningful) AND
      // closeR ≥ 10% (close not at the very bottom).
      deltaMax: -300, rangeMin: 8, rangeMax: 60, bodyPctMin: 0.20, bodyPctMax: 0.75,
      closeInRangeMin: 0.10, closeInRangeMax: 0.50, volMin: 2000, cooldownMs: 5 * 60_000,
    },
    {
      name: 'V11_prevDeltaContext',
      // Same as V10 + require prev15 delta not in heavy-selling regime
      // (loss bars often cluster after sustained selling — let those slide).
      deltaMax: -300, rangeMin: 8, rangeMax: 60, bodyPctMin: 0.20, bodyPctMax: 0.75,
      closeInRangeMin: 0.10, closeInRangeMax: 0.50, volMin: 2000, cooldownMs: 5 * 60_000,
      prev15DeltaMin: -1500,
    },
    {
      name: 'V12_prevDeltaPositive',
      // Stricter — prior 15 bars net buying (recent absorption was preceded
      // by buyers stepping up — strongest mean-reversion setup).
      deltaMax: -300, rangeMin: 8, rangeMax: 60, bodyPctMin: 0.20, bodyPctMax: 0.75,
      closeInRangeMin: 0.10, closeInRangeMax: 0.50, volMin: 2000, cooldownMs: 5 * 60_000,
      prev15DeltaMin: 0,
    },
    {
      name: 'V13_tightCombined',
      // V10 body/closeR caps + V6 range cap. Sweet spot for absorption.
      deltaMax: -400, rangeMin: 10, rangeMax: 45, bodyPctMin: 0.25, bodyPctMax: 0.75,
      closeInRangeMin: 0.10, closeInRangeMax: 0.45, volMin: 3000, cooldownMs: 5 * 60_000,
    },
    {
      name: 'V14_dvOnly',
      // Drop body and closeR constraints; just heavy delta + level touch + no extreme bar.
      deltaMax: -700, rangeMin: 10, rangeMax: 50, bodyPctMin: 0.10, bodyPctMax: 0.85,
      closeInRangeMin: 0.05, closeInRangeMax: 0.55, volMin: 3000, cooldownMs: 5 * 60_000,
    },
  ];

  const detailedFor = 'V14_dvOnly';
  for (const cfg of variants) {
    const trigs = runVariant(cfg, allLevels, db);
    summarize(cfg.name, trigs);
    if (cfg.name === detailedFor) {
      console.log(`\n   ── Detail for ${cfg.name} ──`);
      for (const t of trigs) {
        console.log(
          `   ${t.date} ${etHHMMSS(t.barTs)}  ${t.level.padEnd(7)} lvl=${t.levelPrice.toFixed(2)}  ` +
          `bar=${t.open.toFixed(2)}/${t.high.toFixed(2)}/${t.low.toFixed(2)}/${t.close.toFixed(2)}  ` +
          `rng=${t.range.toFixed(1)} body=${(t.bodyPct*100).toFixed(0)}% closeR=${(t.closeInRange*100).toFixed(0)}% ` +
          `delta=${t.delta} vol=${t.vol}  outcome=${t.outcome.padEnd(8)} maxUp=${t.maxUp.toFixed(1)} maxDn=${t.maxDn.toFixed(1)}`
        );
      }
    }
  }

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
