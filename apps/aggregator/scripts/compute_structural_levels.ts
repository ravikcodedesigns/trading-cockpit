#!/usr/bin/env node
/**
 * compute_structural_levels.ts
 *
 * Computes the 8 daily structural price levels from ticks.db and upserts them
 * into daily_levels.json's additionalLevels[] for today's trading day. Designed
 * to run before RTH open (~09:00 ET) every weekday.
 *
 * Levels:
 *   PDH/PDL/PDC : prior trading day RTH (09:30-16:00 ET) high / low / close
 *   ONH/ONL/ONO : Globex overnight (prior 18:00 ET → today 09:30 ET) high / low / open
 *   POC/VAH/VAL : prior day RTH volume profile (0.25-pt bins, 70% Value Area)
 *
 * Idempotent: re-running replaces existing PDH/PDL/PDC/ONH/ONL/ONO/POC/VAH/VAL
 * entries. Other additionalLevels (RS framework levels) are preserved.
 *
 * Usage:
 *   pnpm --filter aggregator structural-levels
 *   pnpm --filter aggregator structural-levels --date 2026-06-03
 *   pnpm --filter aggregator structural-levels --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVEL_STYLES } from '@trading/contracts';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKS_DB = path.resolve(__dirname, '../../../data/ticks.db');

// Per-symbol levels file mapping.
const LEVELS_PATH_BY_SYMBOL: Record<string, string> = {
  NQ: path.resolve(__dirname, '../../../daily_levels.json'),
  ES: path.resolve(__dirname, '../../../daily_levels_es.json'),
};

// Morning labels: derived from PRIOR day's RTH + overnight session + this morning's
// pre-market. Always written by the 09:23 cron; also re-written to TODAY's entry
// by --evening for completeness (idempotent). The pre-fill to tomorrow's entry
// uses the PD-subset (excludes ON*/PM* and time-of-cron-specific entries).
const MORNING_LABELS = [
  // Core: prior day RTH + overnight
  'PDH', 'PDL', 'PDC', 'ONH', 'ONL', 'ONO', 'POC', 'VAH', 'VAL',
  // RTH-context (added 2026-06-10): pre-market, overnight profile, pivots, halfback.
  // gnVWAP removed 2026-06-12 — single-snapshot overnight VWAP has no institutional
  // benchmark weight as a horizontal level; the live VWAP curve in Chart.tsx
  // covers the intraday reference.
  'PMH', 'PML',
  'onPOC', 'onVAH', 'onVAL',
  'Pivot', 'R1', 'S1',
  'Halfback',
] as const;
type MorningLabel = typeof MORNING_LABELS[number];

// Evening labels: derived from TODAY's completed RTH. Only emitted when
// running with --evening (after 16:00 ET). Backfill mode also uses --evening.
// VWAP removed 2026-06-12 — yesterday's full-session VWAP as a flat horizontal
// line has no edge per backtests (lookahead-excluded) and competes poorly with
// the live curve.
// RTHO removed 2026-06-12 — QQQ Open / SPY Open serve as the institutional
// cash-equity opening reference; futures-side RTHO duplicates the role.
const EVENING_LABELS = ['IBH', 'IBL', 'HVN1', 'HVN2', 'LVN↑', 'LVN↓', 'WkH', 'WkL', 'nPOC'] as const;
type EveningLabel = typeof EVENING_LABELS[number];

// Subset of MORNING_LABELS used for next-day pre-fill (excludes ON* — overnight
// data doesn't exist at 17:55 the night before).
const NEXT_DAY_PREFILL_LABELS = ['PDH', 'PDL', 'PDC', 'POC', 'VAH', 'VAL'] as const;

const ALL_MANAGED_LABELS = [...MORNING_LABELS, ...EVENING_LABELS] as const;
type ManagedLabel = MorningLabel | EveningLabel;

interface AdditionalLevel {
  price: number;
  label: string;
  color?: string;
  style?: string;
  width?: number;
}

interface RawLevel {
  symbol: string;
  bullZone: { low: number; high: number };
  bearZone: { low: number; high: number };
  ddBands: { upper: number; lower: number };
  hedgePressure: number;
  mhp?: number;
  openPrice?: number;
  lmCode?: string;
  additionalLevels?: AdditionalLevel[];
  notes?: string;
}

interface FileShape {
  days: Record<string, { levels: RawLevel[] }>;
}

// ---- ET/UTC helpers ----

function todayInET(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Returns the UTC offset hours for the given ET date (handles EST/EDT).
// EDT = -4, EST = -5.
function etOffsetHours(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d, 12, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(utcNoon);
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  return hour - 12;
}

function etDateTimeToMs(date: string, hh: number, mm: number): number {
  const offset = etOffsetHours(date);
  const [y, mo, d] = date.split('-').map(Number);
  return Date.UTC(y, mo - 1, d, hh - offset, mm);
}

// ---- args ----

function parseArgs(): { date?: string; dryRun: boolean; symbols: string[]; evening: boolean; prefillNextDay: boolean } {
  const argv = process.argv.slice(2);
  let date: string | undefined;
  let dryRun = false;
  let evening = false;
  let prefillNextDay = false;
  let symbols: string[] = ['NQ', 'ES'];   // default: process both
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date') date = argv[++i];
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--evening') evening = true;
    else if (argv[i] === '--prefill-next-day') prefillNextDay = true;
    else if (argv[i] === '--symbol') symbols = [argv[++i].toUpperCase()];
  }
  return { date, dryRun, symbols, evening, prefillNextDay };
}

// ---- file I/O (per-symbol) ----

function loadFile(symbol: string): FileShape {
  const p = LEVELS_PATH_BY_SYMBOL[symbol];
  if (!p) throw new Error(`No levels file configured for symbol '${symbol}'`);
  // Initialize an empty file if missing — allows ES to bootstrap cleanly.
  if (!fs.existsSync(p)) return { days: {} };
  const raw = fs.readFileSync(p, 'utf-8');
  return JSON.parse(raw) as FileShape;
}

function saveFile(symbol: string, data: FileShape) {
  const p = LEVELS_PATH_BY_SYMBOL[symbol];
  if (!p) throw new Error(`No levels file configured for symbol '${symbol}'`);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ---- prior trading day ----

function findPriorTradingDay(todayET: string, db: Database.Database, symbol: string): string | null {
  for (let i = 1; i <= 7; i++) {
    const candidate = addDays(todayET, -i);
    const dow = dayOfWeek(candidate);
    if (dow === 0 || dow === 6) continue; // skip weekend
    const rthStart = etDateTimeToMs(candidate, 9, 30);
    const rthEnd = etDateTimeToMs(candidate, 16, 0);
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM trades WHERE symbol=? AND ts >= ? AND ts < ?`
    ).get(symbol, rthStart, rthEnd) as { n: number };
    if (row.n >= 1000) return candidate;
  }
  return null;
}

// ---- level computations ----

function computePriorDayRTH(db: Database.Database, priorDay: string, symbol: string):
  { pdh: number; pdl: number; pdc: number } | null {
  const rthStart = etDateTimeToMs(priorDay, 9, 30);
  const rthEnd = etDateTimeToMs(priorDay, 16, 0);
  const hilo = db.prepare(
    `SELECT MAX(price) AS hi, MIN(price) AS lo FROM trades WHERE symbol=? AND ts >= ? AND ts < ?`
  ).get(symbol, rthStart, rthEnd) as { hi: number | null; lo: number | null };
  if (hilo.hi == null || hilo.lo == null) return null;
  const lastPrint = db.prepare(
    `SELECT price FROM trades WHERE symbol=? AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 1`
  ).get(symbol, rthStart, rthEnd) as { price: number } | undefined;
  if (!lastPrint) return null;
  return { pdh: hilo.hi, pdl: hilo.lo, pdc: lastPrint.price };
}

function computeOvernight(db: Database.Database, priorDay: string, todayDay: string, symbol: string):
  { onh: number; onl: number; ono: number | null } | null {
  const onStart = etDateTimeToMs(priorDay, 18, 0);
  const onEnd = etDateTimeToMs(todayDay, 9, 30);
  const hilo = db.prepare(
    `SELECT MAX(price) AS hi, MIN(price) AS lo FROM trades WHERE symbol=? AND ts >= ? AND ts < ?`
  ).get(symbol, onStart, onEnd) as { hi: number | null; lo: number | null };
  if (hilo.hi == null || hilo.lo == null) return null;
  const firstPrint = db.prepare(
    `SELECT price FROM trades WHERE symbol=? AND ts >= ? AND ts < ? ORDER BY ts ASC LIMIT 1`
  ).get(symbol, onStart, onEnd) as { price: number } | undefined;
  return { onh: hilo.hi, onl: hilo.lo, ono: firstPrint?.price ?? null };
}

function computeVolumeProfile(db: Database.Database, priorDay: string, symbol: string):
  { poc: number; vah: number; val: number } | null {
  const rthStart = etDateTimeToMs(priorDay, 9, 30);
  const rthEnd = etDateTimeToMs(priorDay, 16, 0);
  // 0.25-pt bins via ROUND(price*4)/4 — works for both NQ and ES (both tick 0.25)
  const rows = db.prepare(`
    SELECT ROUND(price * 4) / 4.0 AS bin, SUM(size) AS vol
    FROM trades
    WHERE symbol=? AND ts >= ? AND ts < ?
    GROUP BY bin
    ORDER BY bin ASC
  `).all(symbol, rthStart, rthEnd) as Array<{ bin: number; vol: number }>;
  if (rows.length === 0) return null;

  const totalVol = rows.reduce((s, r) => s + r.vol, 0);
  const targetVol = totalVol * 0.7;

  let pocIdx = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].vol > rows[pocIdx].vol) pocIdx = i;
  }

  let low = pocIdx;
  let high = pocIdx;
  let cumVol = rows[pocIdx].vol;
  while (cumVol < targetVol && (low > 0 || high < rows.length - 1)) {
    const upVol = high < rows.length - 1 ? rows[high + 1].vol : -1;
    const downVol = low > 0 ? rows[low - 1].vol : -1;
    if (upVol >= 0 && upVol >= downVol) {
      high++;
      cumVol += rows[high].vol;
    } else if (downVol >= 0) {
      low--;
      cumVol += rows[low].vol;
    } else {
      break;
    }
  }

  return { poc: rows[pocIdx].bin, val: rows[low].bin, vah: rows[high].bin };
}

// ---- RTH-context computations (prior session + overnight + pre-market) ----
// Added 2026-06-10. All written by the morning cron at 09:23 to today's entry.

// PMH/PML: pre-market high/low. Window = 06:00 → 09:30 ET on `today`.
// At 09:23 (when the morning cron fires), the window's last 7 min are still
// in progress — H/L will reflect 06:00-09:23 data. Backfill calls are exact.
function computePremarket(db: Database.Database, today: string, symbol: string):
  { pmh: number; pml: number } | null {
  const start = etDateTimeToMs(today, 6, 0);
  const end = etDateTimeToMs(today, 9, 30);
  const row = db.prepare(
    `SELECT MAX(price) AS hi, MIN(price) AS lo, COUNT(*) AS n FROM trades WHERE symbol=? AND ts >= ? AND ts < ?`
  ).get(symbol, start, end) as { hi: number | null; lo: number | null; n: number };
  if (row.n < 100 || row.hi == null || row.lo == null) return null;
  return { pmh: row.hi, pml: row.lo };
}

// gnVWAP: VWAP across the overnight Globex session (prior 18:00 → today 09:30).
function computeOvernightVWAP(db: Database.Database, priorDay: string, today: string, symbol: string): number | null {
  const start = etDateTimeToMs(priorDay, 18, 0);
  const end = etDateTimeToMs(today, 9, 30);
  const row = db.prepare(
    `SELECT SUM(price * size) AS pv, SUM(size) AS v FROM trades WHERE symbol=? AND ts >= ? AND ts < ?`
  ).get(symbol, start, end) as { pv: number | null; v: number | null };
  if (!row.pv || !row.v) return null;
  return row.pv / row.v;
}

// onPOC/onVAH/onVAL: volume profile across the overnight Globex session.
// Same algorithm as computeVolumeProfile but with the overnight window.
function computeOvernightProfile(db: Database.Database, priorDay: string, today: string, symbol: string):
  { onPoc: number; onVah: number; onVal: number } | null {
  const start = etDateTimeToMs(priorDay, 18, 0);
  const end = etDateTimeToMs(today, 9, 30);
  const rows = db.prepare(`
    SELECT ROUND(price * 4) / 4.0 AS bin, SUM(size) AS vol
    FROM trades WHERE symbol=? AND ts >= ? AND ts < ?
    GROUP BY bin ORDER BY bin ASC
  `).all(symbol, start, end) as Array<{ bin: number; vol: number }>;
  if (rows.length === 0) return null;
  const totalVol = rows.reduce((s, r) => s + r.vol, 0);
  const targetVol = totalVol * 0.7;
  let pocIdx = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i]!.vol > rows[pocIdx]!.vol) pocIdx = i;
  let low = pocIdx, high = pocIdx, cumVol = rows[pocIdx]!.vol;
  while (cumVol < targetVol && (low > 0 || high < rows.length - 1)) {
    const upVol = high < rows.length - 1 ? rows[high + 1]!.vol : -1;
    const downVol = low > 0 ? rows[low - 1]!.vol : -1;
    if (upVol >= 0 && upVol >= downVol) { high++; cumVol += rows[high]!.vol; }
    else if (downVol >= 0) { low--; cumVol += rows[low]!.vol; }
    else break;
  }
  return { onPoc: rows[pocIdx]!.bin, onVal: rows[low]!.bin, onVah: rows[high]!.bin };
}

// Classic floor pivots from prior day RTH:
//   Pivot = (PDH + PDL + PDC) / 3
//   R1 = 2*Pivot - PDL  (resistance 1)
//   S1 = 2*Pivot - PDH  (support 1)
function computePivots(rth: { pdh: number; pdl: number; pdc: number }):
  { pivot: number; r1: number; s1: number } {
  const pivot = (rth.pdh + rth.pdl + rth.pdc) / 3;
  return {
    pivot,
    r1: 2 * pivot - rth.pdl,
    s1: 2 * pivot - rth.pdh,
  };
}

// Halfback: midpoint of prior day's RTH range. Common mean-reversion target.
function computeHalfback(rth: { pdh: number; pdl: number }): number {
  return (rth.pdh + rth.pdl) / 2;
}

// ---- evening-mode computations (today's RTH session) ----

// IBH/IBL: high/low of first hour of RTH (09:30-10:30 ET).
function computeIB(db: Database.Database, day: string, symbol: string):
  { ibh: number; ibl: number } | null {
  const start = etDateTimeToMs(day, 9, 30);
  const end = etDateTimeToMs(day, 10, 30);
  const row = db.prepare(
    `SELECT MAX(price) AS hi, MIN(price) AS lo FROM trades WHERE symbol=? AND ts >= ? AND ts < ?`
  ).get(symbol, start, end) as { hi: number | null; lo: number | null };
  if (row.hi == null || row.lo == null) return null;
  return { ibh: row.hi, ibl: row.lo };
}

// computeRTHOpen removed 2026-06-12 — RTHO label retired; QQQ Open / SPY Open
// cover the institutional opening reference. If RTHO ever resurfaces, restore
// the original from git history.

// VWAP: volume-weighted average price across RTH session.
function computeVWAP(db: Database.Database, day: string, symbol: string): number | null {
  const start = etDateTimeToMs(day, 9, 30);
  const end = etDateTimeToMs(day, 16, 0);
  const row = db.prepare(
    `SELECT SUM(price * size) AS pv, SUM(size) AS v FROM trades WHERE symbol=? AND ts >= ? AND ts < ?`
  ).get(symbol, start, end) as { pv: number | null; v: number | null };
  if (!row.pv || !row.v) return null;
  return row.pv / row.v;
}

// HVN1/HVN2/LVN↑/LVN↓: from the same RTH volume profile used for POC/VAH/VAL.
// HVN = 2nd and 3rd highest-volume bins (skipping POC and its 2 immediate neighbors
// to avoid clustering). LVN↑ = lowest-volume bin between POC and VAH (or VAH+5pt
// if none). LVN↓ = lowest-volume bin between VAL and POC. Each must be ≥1pt away
// from POC to be meaningful; otherwise return null for that slot.
function computeHVNLVN(db: Database.Database, day: string, symbol: string, vp: { poc: number; vah: number; val: number }):
  { hvn1: number | null; hvn2: number | null; lvnUp: number | null; lvnDown: number | null } {
  const start = etDateTimeToMs(day, 9, 30);
  const end = etDateTimeToMs(day, 16, 0);
  const rows = db.prepare(`
    SELECT ROUND(price * 4) / 4.0 AS bin, SUM(size) AS vol
    FROM trades
    WHERE symbol=? AND ts >= ? AND ts < ?
    GROUP BY bin
    ORDER BY bin ASC
  `).all(symbol, start, end) as Array<{ bin: number; vol: number }>;

  if (rows.length === 0) return { hvn1: null, hvn2: null, lvnUp: null, lvnDown: null };

  // Sort by volume desc, exclude POC ±1pt, pick top 2 → HVN1/HVN2
  const ranked = [...rows]
    .filter(r => Math.abs(r.bin - vp.poc) >= 1.0)
    .sort((a, b) => b.vol - a.vol);
  const hvn1 = ranked[0]?.bin ?? null;
  // For HVN2, also exclude HVN1 ±1pt to spread the nodes
  const hvn2 = ranked.find(r => hvn1 == null || Math.abs(r.bin - hvn1) >= 1.0)?.bin ?? null;
  const hvn2Final = hvn2 === hvn1 ? null : hvn2;

  // LVN↑: between POC+0.5 and VAH+5pt, pick lowest-volume bin (must be ≥1pt above POC)
  const upRange = rows.filter(r => r.bin > vp.poc + 0.5 && r.bin <= vp.vah + 5);
  upRange.sort((a, b) => a.vol - b.vol);
  const lvnUp = upRange[0] && upRange[0].bin >= vp.poc + 1.0 ? upRange[0].bin : null;

  // LVN↓: between VAL-5pt and POC-0.5, pick lowest-volume bin (must be ≥1pt below POC)
  const downRange = rows.filter(r => r.bin < vp.poc - 0.5 && r.bin >= vp.val - 5);
  downRange.sort((a, b) => a.vol - b.vol);
  const lvnDown = downRange[0] && downRange[0].bin <= vp.poc - 1.0 ? downRange[0].bin : null;

  return { hvn1, hvn2: hvn2Final, lvnUp, lvnDown };
}

// WkH/WkL: highest high / lowest low across last 5 PRIOR completed RTH sessions
// (EXCLUDES `day` itself — i starts at 1). This makes WkH a clean prior-only
// reference level: useful as a forward-looking magnet for today's RTH without
// introducing look-ahead in backtests. Previously included today's RTH in the
// window which made WkH tautologically "touched" most days (its value
// incorporated today's high). Walks back day-by-day, skips weekends and
// sub-1000-tick days.
function computeWeekly(db: Database.Database, day: string, symbol: string):
  { wkh: number; wkl: number } | null {
  const sessions: { hi: number; lo: number }[] = [];
  for (let i = 1; sessions.length < 5 && i < 15; i++) {
    const d = addDays(day, -i);
    const dow = dayOfWeek(d);
    if (dow === 0 || dow === 6) continue;
    const start = etDateTimeToMs(d, 9, 30);
    const end = etDateTimeToMs(d, 16, 0);
    const row = db.prepare(
      `SELECT MAX(price) AS hi, MIN(price) AS lo, COUNT(*) AS n FROM trades WHERE symbol=? AND ts >= ? AND ts < ?`
    ).get(symbol, start, end) as { hi: number | null; lo: number | null; n: number };
    if (row.n < 1000 || row.hi == null || row.lo == null) continue;
    sessions.push({ hi: row.hi, lo: row.lo });
  }
  if (sessions.length === 0) return null;
  return {
    wkh: Math.max(...sessions.map(s => s.hi)),
    wkl: Math.min(...sessions.map(s => s.lo)),
  };
}

// nPOC: most recent "naked POC" — a POC from a past session whose price has
// NOT been touched since (price hasn't traded at POC ± 0.25 in any subsequent
// RTH or overnight). Scans back up to 10 trading days.
function computeNakedPOC(db: Database.Database, day: string, symbol: string): number | null {
  for (let i = 1; i <= 10; i++) {
    const candidate = addDays(day, -i);
    const dow = dayOfWeek(candidate);
    if (dow === 0 || dow === 6) continue;
    const start = etDateTimeToMs(candidate, 9, 30);
    const end = etDateTimeToMs(candidate, 16, 0);
    const rows = db.prepare(`
      SELECT ROUND(price * 4) / 4.0 AS bin, SUM(size) AS vol
      FROM trades WHERE symbol=? AND ts >= ? AND ts < ?
      GROUP BY bin
    `).all(symbol, start, end) as Array<{ bin: number; vol: number }>;
    if (rows.length === 0) continue;
    const pocBin = rows.reduce((a, b) => (b.vol > a.vol ? b : a)).bin;

    // Check if price has touched pocBin ± 0.25 in any session AFTER candidate's
    // RTH close (16:00 ET candidate → 16:00 ET day). If touched, POC is no longer naked.
    const checkStart = end; // candidate's RTH close
    const checkEnd = etDateTimeToMs(day, 16, 0);
    const touched = db.prepare(
      `SELECT 1 FROM trades WHERE symbol=? AND ts >= ? AND ts < ? AND price >= ? AND price <= ? LIMIT 1`
    ).get(symbol, checkStart, checkEnd, pocBin - 0.25, pocBin + 0.25);
    if (!touched) return pocBin;
  }
  return null;
}

// ---- upsert ----

// Pulled from the shared LEVEL_STYLES palette (packages/contracts/src/level-styles.ts)
// — single source of truth for level colors/widths/styles across the app.
function styleFor(label: ManagedLabel): { color: string; style: string; width: number } {
  const s = LEVEL_STYLES[label];
  if (!s) throw new Error(`No LEVEL_STYLES entry for label '${label}'`);
  return s;
}

function upsertLevels(
  file: FileShape,
  today: string,
  symbol: string,
  computed: Partial<Record<ManagedLabel, number>>,
  labelsToRefresh: readonly ManagedLabel[],
): RawLevel | null {
  // Auto-create the day entry if absent.
  // - ES: empty stub (no RS framework needed)
  // - NQ: carry forward bullZone/bearZone/ddBands/HP/MHP from the most recent
  //       prior day's entry, per the RS-Levels-Carry-Forward convention.
  //       User can update these manually in the morning if they've shifted.
  if (!file.days[today]) {
    if (symbol === 'ES') {
      file.days[today] = { levels: [{ symbol: 'ES', additionalLevels: [] }] };
    } else {
      // NQ — find most recent prior day with an NQ entry
      const prior = Object.keys(file.days).sort().filter(d => d < today).pop();
      if (!prior) {
        console.warn(`No prior NQ entry to carry forward from. Create RS levels first via 'levels:add new'.`);
        return null;
      }
      const priorEntry = file.days[prior]!.levels.find(l => l.symbol === 'NQ');
      if (!priorEntry) {
        console.warn(`Prior day ${prior} has no NQ entry. Cannot carry forward.`);
        return null;
      }
      const carried: RawLevel = {
        symbol: 'NQ',
        bullZone: priorEntry.bullZone,
        bearZone: priorEntry.bearZone,
        ddBands: priorEntry.ddBands,
        hedgePressure: priorEntry.hedgePressure,
        mhp: priorEntry.mhp,
        additionalLevels: [],
      };
      file.days[today] = { levels: [carried] };
      console.log(`  ${symbol}: auto-created entry for ${today} (carried bullZone/bearZone/ddBands/HP/MHP from ${prior})`);
    }
  }
  let level = file.days[today].levels.find(l => l.symbol === symbol);
  if (!level) {
    if (symbol === 'ES') {
      level = { symbol: 'ES', additionalLevels: [] };
      file.days[today].levels.push(level);
    } else {
      console.warn(`No ${symbol} entry for ${today}. Skipping.`);
      return null;
    }
  }
  level.additionalLevels = level.additionalLevels ?? [];
  // Remove any labels we are about to refresh — preserve everything else
  // (RS framework levels, QQQ/SPY/SPX opens, custom user levels, etc.).
  const refreshSet = new Set<string>(labelsToRefresh);
  level.additionalLevels = level.additionalLevels.filter(a => !refreshSet.has(a.label));
  // Add fresh ones
  for (const label of labelsToRefresh) {
    const price = computed[label];
    if (price == null) continue;
    const sty = styleFor(label);
    level.additionalLevels.push({ price, label, ...sty });
  }
  level.additionalLevels.sort((a, b) => b.price - a.price);
  return level;
}

// ---- main ----

// Find the NEXT trading day after `day` (skips Sat/Sun).
function findNextTradingDay(day: string): string {
  for (let i = 1; i <= 7; i++) {
    const candidate = addDays(day, i);
    const dow = dayOfWeek(candidate);
    if (dow !== 0 && dow !== 6) return candidate;
  }
  throw new Error(`No next trading day found within 7 days of ${day}`);
}

function processSymbol(symbol: string, today: string, dryRun: boolean, evening: boolean, prefillNextDay: boolean): boolean {
  console.log(`\n── ${symbol}${evening ? ' (evening)' : ''} ──`);
  const db = new Database(TICKS_DB, { readonly: true });
  db.pragma('journal_mode = WAL');

  // Morning mode: PDH/PDL/etc come from prior trading day, ON* from overnight.
  // Evening mode: same MORNING_LABELS still come from prior day (so today's entry
  // shows yesterday's reference levels as usual), PLUS evening labels from today's
  // RTH, PLUS optional next-day pre-fill with today's RTH as that day's PD-set.
  const priorDay = findPriorTradingDay(today, db, symbol);
  if (!priorDay) {
    console.error(`  ${symbol}: no prior trading day with RTH data before ${today}`);
    db.close();
    return false;
  }
  console.log(`  Prior trading day: ${priorDay}`);

  const rth = computePriorDayRTH(db, priorDay, symbol);
  const overnight = computeOvernight(db, priorDay, today, symbol);
  const vp = computeVolumeProfile(db, priorDay, symbol);

  if (!rth || !vp) {
    console.error(`  ${symbol}: critical computations returned null.`, { rth: !!rth, overnight: !!overnight, vp: !!vp });
    db.close();
    return false;
  }
  if (!overnight) {
    console.warn(`  ${symbol}: overnight session has no data yet — writing partial (ONH/ONL/ONO will be filled on re-run).`);
  }

  // ── RTH-context additions (2026-06-10) ────────────────────────────────
  const pm = computePremarket(db, today, symbol);
  const gnVwap = computeOvernightVWAP(db, priorDay, today, symbol);
  const onProf = computeOvernightProfile(db, priorDay, today, symbol);
  const pivots = computePivots(rth);
  const halfback = computeHalfback(rth);

  const morningComputed: Partial<Record<ManagedLabel, number>> = {
    PDH: rth.pdh, PDL: rth.pdl, PDC: rth.pdc,
    ONH: overnight?.onh, ONL: overnight?.onl, ONO: overnight?.ono ?? undefined,
    POC: vp.poc, VAH: vp.vah, VAL: vp.val,
    PMH: pm?.pmh, PML: pm?.pml,
    gnVWAP: gnVwap ?? undefined,
    onPOC: onProf?.onPoc, onVAH: onProf?.onVah, onVAL: onProf?.onVal,
    Pivot: pivots.pivot, R1: pivots.r1, S1: pivots.s1,
    Halfback: halfback,
  };

  for (const k of MORNING_LABELS) {
    const v = morningComputed[k];
    const vs = typeof v === 'number' ? v.toFixed(2) : '(skip)';
    console.log(`    ${k.padEnd(8)} ${vs}`);
  }

  // ─── Evening labels (computed from TODAY's RTH) ─────────────────────────
  let eveningComputed: Partial<Record<ManagedLabel, number>> = {};
  let todayVP: { poc: number; vah: number; val: number } | null = null;
  if (evening) {
    const ib = computeIB(db, today, symbol);
    const vwap = computeVWAP(db, today, symbol);
    todayVP = computeVolumeProfile(db, today, symbol);
    const hvnlvn = todayVP ? computeHVNLVN(db, today, symbol, todayVP) : { hvn1: null, hvn2: null, lvnUp: null, lvnDown: null };
    const weekly = computeWeekly(db, today, symbol);
    const nakedPOC = computeNakedPOC(db, today, symbol);
    eveningComputed = {
      IBH: ib?.ibh, IBL: ib?.ibl,
      VWAP: vwap ?? undefined,
      HVN1: hvnlvn.hvn1 ?? undefined,
      HVN2: hvnlvn.hvn2 ?? undefined,
      'LVN↑': hvnlvn.lvnUp ?? undefined,
      'LVN↓': hvnlvn.lvnDown ?? undefined,
      WkH: weekly?.wkh, WkL: weekly?.wkl,
      nPOC: nakedPOC ?? undefined,
    };
    console.log(`  ── evening (today=${today}) ──`);
    for (const k of EVENING_LABELS) {
      const v = eveningComputed[k];
      const vs = typeof v === 'number' ? v.toFixed(2) : '(skip)';
      console.log(`    ${k.padEnd(5)} ${vs}`);
    }
  }

  db.close();

  if (dryRun) {
    console.log(`  ${symbol}: --dry-run, not writing file.`);
    return true;
  }

  const file = loadFile(symbol);

  // 1. Today's entry: refresh MORNING_LABELS (+ EVENING_LABELS if evening mode)
  const todayRefresh: ManagedLabel[] = [...MORNING_LABELS];
  const todayComputed: Partial<Record<ManagedLabel, number>> = { ...morningComputed };
  if (evening) {
    todayRefresh.push(...EVENING_LABELS);
    Object.assign(todayComputed, eveningComputed);
  }
  const level = upsertLevels(file, today, symbol, todayComputed, todayRefresh);
  if (!level) return false;
  console.log(`  ${symbol}: wrote ${level.additionalLevels?.length ?? 0} additionalLevels for ${today}`);

  // 2. Next-day pre-fill: PDH/PDL/PDC/POC/VAH/VAL derived from TODAY's RTH
  if (evening && prefillNextDay && todayVP) {
    const todayRTH = computePriorDayRTH(new Database(TICKS_DB, { readonly: true }), today, symbol);
    if (todayRTH) {
      const nextDay = findNextTradingDay(today);
      const prefillComputed: Partial<Record<ManagedLabel, number>> = {
        PDH: todayRTH.pdh, PDL: todayRTH.pdl, PDC: todayRTH.pdc,
        POC: todayVP.poc, VAH: todayVP.vah, VAL: todayVP.val,
      };
      const nextLevel = upsertLevels(file, nextDay, symbol, prefillComputed, NEXT_DAY_PREFILL_LABELS);
      if (nextLevel) {
        console.log(`  ${symbol}: pre-filled ${NEXT_DAY_PREFILL_LABELS.length} labels for next day ${nextDay}`);
      }
    }
  }

  saveFile(symbol, file);
  return true;
}

function main() {
  const { date, dryRun, symbols, evening, prefillNextDay } = parseArgs();
  const today = date ?? todayInET();
  const flags = [evening ? 'evening' : 'morning', dryRun ? 'dry-run' : null, prefillNextDay ? 'prefill-next-day' : null]
    .filter(Boolean).join(', ');
  console.log(`Computing structural levels for ${today}  [${flags}]  symbols: ${symbols.join(', ')}`);

  let ok = true;
  for (const sym of symbols) {
    if (!LEVELS_PATH_BY_SYMBOL[sym]) {
      console.error(`Unknown symbol '${sym}' — no levels file configured.`);
      ok = false;
      continue;
    }
    const success = processSymbol(sym, today, dryRun, evening, prefillNextDay);
    if (!success) ok = false;
  }

  if (!ok) process.exit(1);
}

main();
