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

const STRUCTURAL_LABELS = ['PDH', 'PDL', 'PDC', 'ONH', 'ONL', 'ONO', 'POC', 'VAH', 'VAL'] as const;
type StructuralLabel = typeof STRUCTURAL_LABELS[number];

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

function parseArgs(): { date?: string; dryRun: boolean; symbols: string[] } {
  const argv = process.argv.slice(2);
  let date: string | undefined;
  let dryRun = false;
  let symbols: string[] = ['NQ', 'ES'];   // default: process both
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date') date = argv[++i];
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--symbol') symbols = [argv[++i].toUpperCase()];
  }
  return { date, dryRun, symbols };
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

// ---- upsert ----

// Pulled from the shared LEVEL_STYLES palette (packages/contracts/src/level-styles.ts)
// — single source of truth for level colors/widths/styles across the app.
const STYLES: Record<StructuralLabel, { color: string; style: string; width: number }> = {
  PDH: LEVEL_STYLES['PDH']!,
  PDL: LEVEL_STYLES['PDL']!,
  PDC: LEVEL_STYLES['PDC']!,
  ONH: LEVEL_STYLES['ONH']!,
  ONL: LEVEL_STYLES['ONL']!,
  ONO: LEVEL_STYLES['ONO']!,
  POC: LEVEL_STYLES['POC']!,
  VAH: LEVEL_STYLES['VAH']!,
  VAL: LEVEL_STYLES['VAL']!,
};

function upsertLevels(
  file: FileShape,
  today: string,
  symbol: string,
  computed: Partial<Record<StructuralLabel, number>>,
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
  // Remove any prior structural labels
  level.additionalLevels = level.additionalLevels.filter(
    a => !(STRUCTURAL_LABELS as readonly string[]).includes(a.label),
  );
  // Add fresh ones
  for (const label of STRUCTURAL_LABELS) {
    const price = computed[label];
    if (price == null) continue;
    const sty = STYLES[label];
    level.additionalLevels.push({ price, label, ...sty });
  }
  level.additionalLevels.sort((a, b) => b.price - a.price);
  return level;
}

// ---- main ----

function processSymbol(symbol: string, today: string, dryRun: boolean): boolean {
  console.log(`\n── ${symbol} ──`);
  const db = new Database(TICKS_DB, { readonly: true });
  db.pragma('journal_mode = WAL');

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

  db.close();

  // 2026-06-04: relaxed null check — RTH+VP must succeed (those are the
  // critical prior-day levels), but overnight may be empty if this runs
  // right after the close (overnight session starts at 18:00 ET). When
  // overnight is missing, write partial data; re-running the script after
  // the overnight session has data will fill ONH/ONL/ONO in.
  if (!rth || !vp) {
    console.error(`  ${symbol}: critical computations returned null.`, { rth: !!rth, overnight: !!overnight, vp: !!vp });
    return false;
  }
  if (!overnight) {
    console.warn(`  ${symbol}: overnight session has no data yet — writing partial (ONH/ONL/ONO will be filled on re-run).`);
  }

  const computed: Partial<Record<StructuralLabel, number>> = {
    PDH: rth.pdh, PDL: rth.pdl, PDC: rth.pdc,
    ONH: overnight?.onh, ONL: overnight?.onl, ONO: overnight?.ono ?? undefined,
    POC: vp.poc, VAH: vp.vah, VAL: vp.val,
  };

  for (const k of STRUCTURAL_LABELS) {
    const v = computed[k];
    console.log(`    ${k.padEnd(4)} ${v ?? '(skip)'}`);
  }

  if (dryRun) {
    console.log(`  ${symbol}: --dry-run, not writing file.`);
    return true;
  }

  const file = loadFile(symbol);
  const level = upsertLevels(file, today, symbol, computed);
  if (!level) return false;
  saveFile(symbol, file);
  console.log(`  ${symbol}: wrote ${level.additionalLevels?.length ?? 0} additionalLevels to ${LEVELS_PATH_BY_SYMBOL[symbol]}`);
  return true;
}

function main() {
  const { date, dryRun, symbols } = parseArgs();
  const today = date ?? todayInET();
  console.log(`Computing structural levels for ${today}${dryRun ? ' (dry-run)' : ''}  symbols: ${symbols.join(', ')}`);

  let ok = true;
  for (const sym of symbols) {
    if (!LEVELS_PATH_BY_SYMBOL[sym]) {
      console.error(`Unknown symbol '${sym}' — no levels file configured.`);
      ok = false;
      continue;
    }
    const success = processSymbol(sym, today, dryRun);
    if (!success) ok = false;
  }

  if (!ok) process.exit(1);
}

main();
