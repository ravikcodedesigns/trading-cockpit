/**
 * DD Upper Band — Passive Touch Logger
 *
 * Runs as a background process. Every 60 seconds scans ticks.db for new DD
 * upper band touches and writes all key metrics to the dd_touches table.
 *
 * Does NOT make trading decisions. Pure data collection.
 * After ~50 events, run dd_deep_analysis.ts to find real statistical edges.
 *
 * Usage:
 *   node apps/aggregator/node_modules/tsx/dist/cli.mjs apps/aggregator/scripts/dd_logger.ts
 * Or via pm2 (added to ecosystem.config.cjs as 'dd-logger')
 */
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const TICKS_PATH  = path.resolve(__dirname, "../../../data/ticks.db");
const DB_PATH     = path.resolve(__dirname, "../data/trading.db");
const LEVELS_PATH = path.resolve(__dirname, "../../../daily_levels.json");

const ticksDb = new Database(TICKS_PATH, { readonly: true });
const db      = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ─── SCHEMA ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS dd_touches (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    date                  TEXT    NOT NULL,
    touch_time            TEXT    NOT NULL,
    touch_ts              INTEGER NOT NULL,
    dd_upper              REAL    NOT NULL,
    touch_high            REAL    NOT NULL,
    in_time_gate          INTEGER NOT NULL DEFAULT 0,  -- 1 = 11:00-15:00 ET
    prev_day_above        INTEGER NOT NULL DEFAULT 0,  -- 1 = price was above DD upper yesterday

    -- Zone entry (first bar where price >= DD upper - 20)
    zone_time             TEXT,
    zone_ts               INTEGER,
    approach_bars         INTEGER,
    approach_delta        INTEGER,
    approach_vol          INTEGER,
    approach_delta_pct    REAL,

    -- Depth: A = snapshot at zone entry bar, B = snapshot at touch bar
    -- B - A positive = supply held/grew = reversal likely
    -- B - A negative = orders pulled = breakout risk
    ask_sz_a              INTEGER,
    ask_lvls_a            INTEGER,
    ask_sz_b              INTEGER,
    ask_lvls_b            INTEGER,
    ask_sz_change         INTEGER,
    ask_lvl_change        INTEGER,

    -- Touch bar OHLCV + delta
    touch_delta           INTEGER,
    touch_vol             INTEGER,
    touch_delta_pct       REAL,
    touch_close_pos       REAL,   -- 0 = close at high (full bull), 1 = close at low (full bear)
    touch_vol_vs_appr     REAL,   -- touch bar vol / avg approach bar vol

    -- Large-lot absorption at DD upper (size >= 5) during touch bar
    abs_count             INTEGER,
    abs_sell_vol          INTEGER,
    abs_buy_vol           INTEGER,
    abs_net_delta         INTEGER,
    abs_max_lot           INTEGER,

    -- CVD 15-bar divergence: price up but delta weak = buyers exhausted
    cvd_zone_price_delta  REAL,
    cvd_zone_cvd          INTEGER,
    cvd_zone_div          INTEGER,    -- 1 = diverging at zone entry
    cvd_touch_price_delta REAL,
    cvd_touch_cvd         INTEGER,
    cvd_touch_div         INTEGER,    -- 1 = diverging at touch

    -- Regime at zone entry
    h1_bull               INTEGER,   -- 1/0/null: last complete 1h bar close > prev 1h close
    h1_green              INTEGER,   -- 1/0/null: last complete 1h bar green (close > open)
    h4_bull               INTEGER,
    h4_green              INTEGER,
    sess_delta            INTEGER,   -- cumulative delta from 09:30 open to zone entry

    -- Post-touch N1/N2 (bars 1 and 2 after touch)
    n1_delta              INTEGER,
    n2_delta              INTEGER,

    -- Outcome (auto-computed from available bars at log time; more accurate the later it's logged)
    max_retrace           REAL,
    tp30_bars             INTEGER,
    tp50_bars             INTEGER,
    tp100_bars            INTEGER,
    tp150_bars            INTEGER,

    logged_at             TEXT    DEFAULT (datetime('now')),
    UNIQUE(date, touch_ts)
  );
  CREATE INDEX IF NOT EXISTS idx_dd_touches_date ON dd_touches(date);
  CREATE INDEX IF NOT EXISTS idx_dd_touches_ts   ON dd_touches(touch_ts);
`);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function msToET(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ms));
}

function etToday(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date()).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2");
}

function getRthBars(day: string) {
  return ticksDb.prepare(`
    SELECT ts/1000/60 as mb,
           MIN(price) as low, MAX(price) as high,
           SUM(size) as vol,
           SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) as delta,
           FIRST_VALUE(price) OVER (PARTITION BY ts/1000/60 ORDER BY ts
             ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as open,
           LAST_VALUE(price) OVER (PARTITION BY ts/1000/60 ORDER BY ts
             ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as close
    FROM trades WHERE symbol='NQ'
      AND date(ts/1000,'unixepoch','localtime')=?
      AND time(ts/1000,'unixepoch','localtime') BETWEEN '09:00:00' AND '16:05:00'
    GROUP BY ts/1000/60 ORDER BY mb
  `).all(day) as any[];
}

function findZoneEntry(bars: any[], touchIdx: number, ddUpper: number) {
  const threshold = ddUpper - 20;
  let j = touchIdx - 1;
  while (j >= 0 && bars[j].high >= threshold) j--;
  return Math.min(j + 1, touchIdx);
}

function depthSnapshot(barStartMs: number, ddUpper: number) {
  const row = ticksDb.prepare(`
    SELECT
      SUM(CASE WHEN side=1 AND price >= ? THEN size ELSE 0 END) as ask_sz,
      COUNT(DISTINCT CASE WHEN side=1 AND price >= ? THEN price END) as ask_levels
    FROM depth WHERE symbol='NQ' AND ts >= ? AND ts < ?
  `).get(ddUpper, ddUpper, barStartMs, barStartMs + 60_000) as any;
  return { askSz: row?.ask_sz || 0, askLevels: row?.ask_levels || 0 };
}

function approachLeg(zoneStartMs: number, touchStartMs: number) {
  if (zoneStartMs >= touchStartMs) return { delta: 0, vol: 0, deltaPct: 0 };
  const row = ticksDb.prepare(`
    SELECT SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) as delta,
           SUM(size) as vol
    FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?
  `).get(zoneStartMs, touchStartMs) as any;
  const delta = row?.delta || 0;
  const vol   = row?.vol   || 0;
  return { delta, vol, deltaPct: vol > 0 ? delta / vol * 100 : 0 };
}

function touchAbsorption(touchStartMs: number, ddUpper: number) {
  const row = ticksDb.prepare(`
    SELECT COUNT(*) as count,
      SUM(CASE WHEN is_bid_aggressor=0 THEN size ELSE 0 END) as sell_vol,
      SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE 0 END) as buy_vol,
      SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) as net_delta,
      MAX(size) as max_lot
    FROM trades WHERE symbol='NQ'
      AND ts >= ? AND ts < ? AND price >= ? AND size >= 5
  `).get(touchStartMs, touchStartMs + 60_000, ddUpper - 3) as any;
  return {
    count:    row?.count     || 0,
    sellVol:  row?.sell_vol  || 0,
    buyVol:   row?.buy_vol   || 0,
    netDelta: row?.net_delta || 0,
    maxLot:   row?.max_lot   || 0,
  };
}

function cvd15(bars: any[], refIdx: number) {
  const window = bars.slice(Math.max(0, refIdx - 14), refIdx + 1);
  if (window.length < 2) return { priceDelta: 0, cvd: 0, diverging: 0 };
  const priceDelta = window.at(-1)!.close - window[0].open;
  const cvd = window.reduce((s: number, b: any) => s + b.delta, 0);
  return {
    priceDelta,
    cvd,
    diverging: priceDelta > 5 && cvd < priceDelta * 0.3 ? 1 : 0,
  };
}

function calcTPs(bars: any[], touchIdx: number, touchHigh: number) {
  const post = bars.slice(touchIdx + 1, touchIdx + 121);
  let minLow = touchHigh;
  const tps: Record<number, number | null> = { 30: null, 50: null, 100: null, 150: null };
  for (let k = 0; k < post.length; k++) {
    minLow = Math.min(minLow, post[k].low);
    for (const tp of [30, 50, 100, 150]) {
      if (tps[tp] === null && post[k].low <= touchHigh - tp) tps[tp] = k + 1;
    }
  }
  return { maxRetrace: touchHigh - minLow, tps };
}

// ─── REGIME: 1h/4h BAR STRUCTURE ──────────────────────────────────────────────

function buildHourlyBuckets(bars: any[], intervalMins: number) {
  const buckets = new Map<number, { bucket: number; open: number; high: number; low: number; close: number }>();
  for (const b of bars) {
    const k = Math.floor(b.mb / intervalMins) * intervalMins;
    if (!buckets.has(k)) {
      buckets.set(k, { bucket: k, open: b.open, high: b.high, low: b.low, close: b.close });
    } else {
      const h = buckets.get(k)!;
      h.high  = Math.max(h.high, b.high);
      h.low   = Math.min(h.low, b.low);
      h.close = b.close;
    }
  }
  return [...buckets.values()].sort((a, b) => a.bucket - b.bucket);
}

function regimeAt(bars: any[], touchIdx: number) {
  const barsBeforeTouch = bars.slice(0, touchIdx);
  const h1 = buildHourlyBuckets(barsBeforeTouch, 60);
  const h4 = buildHourlyBuckets(barsBeforeTouch, 240);
  const last1h = h1.at(-1) ?? null;
  const prev1h = h1.at(-2) ?? null;
  const last4h = h4.at(-1) ?? null;
  const prev4h = h4.at(-2) ?? null;
  return {
    h1Bull:  last1h && prev1h ? (last1h.close > prev1h.close ? 1 : 0) : null,
    h1Green: last1h ? (last1h.close > last1h.open ? 1 : 0) : null,
    h4Bull:  last4h && prev4h ? (last4h.close > prev4h.close ? 1 : 0) : null,
    h4Green: last4h ? (last4h.close > last4h.open ? 1 : 0) : null,
  };
}

function sessionDelta(day: string, untilMs: number): number {
  const open930 = ticksDb.prepare(`
    SELECT MIN(ts) as ts FROM trades WHERE symbol='NQ'
      AND date(ts/1000,'unixepoch','localtime')=?
      AND time(ts/1000,'unixepoch','localtime') >= '09:30:00'
  `).get(day) as any;
  if (!open930?.ts) return 0;
  const row = ticksDb.prepare(`
    SELECT SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) as delta
    FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?
  `).get(open930.ts, untilMs) as any;
  return row?.delta || 0;
}

function prevDayAboveDDUpper(day: string, ddUpper: number): number {
  const prev = ticksDb.prepare(`
    SELECT DISTINCT date(ts/1000,'unixepoch','localtime') as d
    FROM trades WHERE symbol='NQ' AND date(ts/1000,'unixepoch','localtime') < ?
    ORDER BY d DESC LIMIT 1
  `).get(day) as any;
  if (!prev?.d) return 0;
  const row = ticksDb.prepare(`
    SELECT MAX(price) as mx FROM trades
    WHERE symbol='NQ' AND date(ts/1000,'unixepoch','localtime')=?
  `).get(prev.d) as any;
  return (row?.mx || 0) >= ddUpper ? 1 : 0;
}

// ─── INSERT ───────────────────────────────────────────────────────────────────

const insertRow = db.prepare(`
  INSERT OR IGNORE INTO dd_touches (
    date, touch_time, touch_ts, dd_upper, touch_high, in_time_gate, prev_day_above,
    zone_time, zone_ts, approach_bars, approach_delta, approach_vol, approach_delta_pct,
    ask_sz_a, ask_lvls_a, ask_sz_b, ask_lvls_b, ask_sz_change, ask_lvl_change,
    touch_delta, touch_vol, touch_delta_pct, touch_close_pos, touch_vol_vs_appr,
    abs_count, abs_sell_vol, abs_buy_vol, abs_net_delta, abs_max_lot,
    cvd_zone_price_delta, cvd_zone_cvd, cvd_zone_div,
    cvd_touch_price_delta, cvd_touch_cvd, cvd_touch_div,
    h1_bull, h1_green, h4_bull, h4_green, sess_delta,
    n1_delta, n2_delta,
    max_retrace, tp30_bars, tp50_bars, tp100_bars, tp150_bars
  ) VALUES (
    @date, @touch_time, @touch_ts, @dd_upper, @touch_high, @in_time_gate, @prev_day_above,
    @zone_time, @zone_ts, @approach_bars, @approach_delta, @approach_vol, @approach_delta_pct,
    @ask_sz_a, @ask_lvls_a, @ask_sz_b, @ask_lvls_b, @ask_sz_change, @ask_lvl_change,
    @touch_delta, @touch_vol, @touch_delta_pct, @touch_close_pos, @touch_vol_vs_appr,
    @abs_count, @abs_sell_vol, @abs_buy_vol, @abs_net_delta, @abs_max_lot,
    @cvd_zone_price_delta, @cvd_zone_cvd, @cvd_zone_div,
    @cvd_touch_price_delta, @cvd_touch_cvd, @cvd_touch_div,
    @h1_bull, @h1_green, @h4_bull, @h4_green, @sess_delta,
    @n1_delta, @n2_delta,
    @max_retrace, @tp30_bars, @tp50_bars, @tp100_bars, @tp150_bars
  )
`);

// ─── SCAN ─────────────────────────────────────────────────────────────────────

function scan() {
  let levels: { ddUpper: number; ddLower: number } | null = null;
  try {
    const raw  = JSON.parse(fs.readFileSync(LEVELS_PATH, "utf-8"));
    const day  = etToday();
    // daily_levels.json: { days: { "YYYY-MM-DD": { levels: [{symbol, ddBands, ...}] } } }
    // Fall back to the most recent day if today isn't present yet
    const days = Object.keys(raw.days ?? {}).sort();
    const key  = raw.days?.[day] ? day : days.at(-1);
    if (!key) throw new Error("no days in levels file");
    const nq   = (raw.days[key].levels as any[]).find((l: any) => l.symbol === "NQ");
    if (!nq?.ddBands) throw new Error("NQ ddBands not found");
    levels = { ddUpper: nq.ddBands.upper, ddLower: nq.ddBands.lower };
  } catch (e) {
    console.log(`[${new Date().toISOString()}] Cannot read daily_levels.json — ${e}`);
    return;
  }

  const { ddUpper } = levels;
  const day  = etToday();
  const nowMs = Date.now();
  const bars  = getRthBars(day);
  if (!bars.length) return;

  const prevAbove = prevDayAboveDDUpper(day, ddUpper);

  let found = 0;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.high < ddUpper - 2) continue;   // not a touch

    // Only the FIRST bar of each touching cluster is a new event.
    // A cluster starts when the previous bar was NOT touching (high < ddUpper - 2).
    const prevBar = bars[i - 1] ?? null;
    if (prevBar && prevBar.high >= ddUpper - 2) continue;   // continuation of same cluster

    const touchTs = bar.mb * 60 * 1_000;    // ms timestamp of bar start

    // N1/N2 need 3 minutes to settle
    if (nowMs < touchTs + 3 * 60_000) continue;

    // Skip already logged (UNIQUE constraint is the hard guard; this avoids log spam)
    const exists = db.prepare(`SELECT 1 FROM dd_touches WHERE date=? AND touch_ts=?`).get(day, touchTs);
    if (exists) continue;

    // 20-minute cool-down: price can chop around DD upper with single-bar dips below,
    // creating false cluster starts. Ignore any touch within 20 min of the last logged one.
    const recentTouch = db.prepare(
      `SELECT 1 FROM dd_touches WHERE date=? AND touch_ts >= ? AND touch_ts < ?`
    ).get(day, touchTs - 20 * 60_000, touchTs);
    if (recentTouch) continue;

    const zoneIdx   = findZoneEntry(bars, i, ddUpper);
    const zoneTsMs  = bars[zoneIdx].mb * 60 * 1_000;

    const dsnA      = depthSnapshot(zoneTsMs, ddUpper);
    const dsnB      = depthSnapshot(touchTs,  ddUpper);
    const appr      = approachLeg(zoneTsMs, touchTs);
    const approachBars  = i - zoneIdx;
    const approachAvgVol = approachBars > 0 ? appr.vol / approachBars : 0;
    const abs       = touchAbsorption(touchTs, ddUpper);
    const cvdZone   = cvd15(bars, zoneIdx);
    const cvdTouch  = cvd15(bars, i);
    const reg       = regimeAt(bars, i);
    const sessDelta = sessionDelta(day, zoneTsMs);
    const { maxRetrace, tps } = calcTPs(bars, i, bar.high);

    const barRange    = bar.high - bar.low;
    const touchTime   = msToET(touchTs);
    const zoneTime    = msToET(zoneTsMs);
    const inTimeGate  = touchTime >= "11:00" && touchTime <= "15:00" ? 1 : 0;
    const touchDeltaPct  = bar.vol > 0 ? bar.delta / bar.vol * 100 : 0;
    const touchVolVsAppr = approachAvgVol > 0 ? bar.vol / approachAvgVol : 1;
    const closePos    = barRange > 0 ? (bar.high - bar.close) / barRange : 0;

    const n1 = bars[i + 1] ?? null;
    const n2 = bars[i + 2] ?? null;

    insertRow.run({
      date: day, touch_time: touchTime, touch_ts: touchTs,
      dd_upper: ddUpper, touch_high: bar.high,
      in_time_gate: inTimeGate, prev_day_above: prevAbove,
      zone_time: zoneTime, zone_ts: zoneTsMs,
      approach_bars: approachBars, approach_delta: appr.delta,
      approach_vol: appr.vol, approach_delta_pct: appr.deltaPct,
      ask_sz_a: dsnA.askSz, ask_lvls_a: dsnA.askLevels,
      ask_sz_b: dsnB.askSz, ask_lvls_b: dsnB.askLevels,
      ask_sz_change:  dsnB.askSz - dsnA.askSz,
      ask_lvl_change: dsnB.askLevels - dsnA.askLevels,
      touch_delta: bar.delta, touch_vol: bar.vol,
      touch_delta_pct: touchDeltaPct, touch_close_pos: closePos,
      touch_vol_vs_appr: touchVolVsAppr,
      abs_count: abs.count, abs_sell_vol: abs.sellVol,
      abs_buy_vol: abs.buyVol, abs_net_delta: abs.netDelta, abs_max_lot: abs.maxLot,
      cvd_zone_price_delta: cvdZone.priceDelta, cvd_zone_cvd: cvdZone.cvd, cvd_zone_div: cvdZone.diverging,
      cvd_touch_price_delta: cvdTouch.priceDelta, cvd_touch_cvd: cvdTouch.cvd, cvd_touch_div: cvdTouch.diverging,
      h1_bull: reg.h1Bull, h1_green: reg.h1Green,
      h4_bull: reg.h4Bull, h4_green: reg.h4Green,
      sess_delta: sessDelta,
      n1_delta: n1?.delta ?? null, n2_delta: n2?.delta ?? null,
      max_retrace: maxRetrace, tp30_bars: tps[30], tp50_bars: tps[50],
      tp100_bars: tps[100], tp150_bars: tps[150],
    });

    const sign = (n: number | null) => n == null ? "n/a" : (n >= 0 ? "+" : "") + n;
    console.log(
      `[${new Date().toISOString()}] LOGGED  ${day} ${touchTime}` +
      `  DD upper: ${ddUpper}  high: ${bar.high.toFixed(2)}` +
      `  gate: ${inTimeGate ? "YES" : "no"}` +
      `  apprΔ: ${sign(appr.delta)}` +
      `  askChg: ${sign(dsnB.askSz - dsnA.askSz)}` +
      `  touchΔ%: ${touchDeltaPct.toFixed(1)}%` +
      `  N1: ${sign(n1?.delta ?? null)}  N2: ${sign(n2?.delta ?? null)}`
    );
    found++;
  }

  if (found === 0) {
    // Quiet tick — only log once per hour to avoid flooding
    const min = new Date().getMinutes();
    if (min === 0) console.log(`[${new Date().toISOString()}] Watching — DD upper: ${ddUpper}  no new touches`);
  }
}

// ─── BACKFILL TODAY ───────────────────────────────────────────────────────────
// On startup, scan the full day so any touches that happened before the logger
// started are captured immediately (as long as N1/N2 bars are available).

console.log(`\n[DD Logger] starting  —  polling every 60s`);
console.log(`[DD Logger] writing to: ${DB_PATH}`);

try {
  const raw  = JSON.parse(fs.readFileSync(LEVELS_PATH, "utf-8"));
  const days = Object.keys(raw.days ?? {}).sort();
  const key  = raw.days?.[etToday()] ? etToday() : days.at(-1);
  const nq   = key ? (raw.days[key].levels as any[]).find((l: any) => l.symbol === "NQ") : null;
  const total = (db.prepare(`SELECT COUNT(*) as n FROM dd_touches`).get() as any).n;
  console.log(`[DD Logger] levels date: ${key}  DD upper: ${nq?.ddBands?.upper}  DD lower: ${nq?.ddBands?.lower}`);
  console.log(`[DD Logger] touches logged all-time: ${total}\n`);
} catch { /* levels may not exist on first run */ }

scan();
setInterval(scan, 60_000);

process.on("SIGTERM", () => { db.close(); ticksDb.close(); process.exit(0); });
process.on("SIGINT",  () => { db.close(); ticksDb.close(); process.exit(0); });
