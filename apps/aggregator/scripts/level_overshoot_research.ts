/**
 * level_overshoot_research.ts
 *
 * Tests the "overshoot + reversal" mechanic on Tier-1 levels:
 *
 *   For each level (PDL, PDH, PML, PMH, ONL, ONH, PDC, RTH_Open), watch the
 *   tick stream. When price CROSSES through the level (direction A), continues
 *   past it (overshoot), reaches a local extreme, then REVERSES and crosses
 *   BACK through the level (direction -A) — all within SETUP_MAX_MS — emit a
 *   SETUP.
 *
 *   Up-overshoot then cross-back-down → SHORT setup (price tested level from
 *     below, failed to hold above)
 *   Down-overshoot then cross-back-up → LONG setup (price tested level from
 *     above, failed to hold below)
 *
 *   Entry: cross-back price (≈ level)
 *   Stop:  overshoot extreme ± 1pt
 *   Target: level ∓ 60pt
 *   Horizon: HORIZON_MS after entry — whichever (stop, target) hits first.
 *
 * Conventions:
 *   is_bid_aggressor=1 → BUY aggressor (verified empirically)
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const SETUP_MAX_MS = 30 * 60_000;
const HORIZON_MS   = 30 * 60_000;
const TARGET_PTS   = 60;
const STOP_BUFFER  = 1.0;
const COOLDOWN_MS  = 30 * 60_000;

const TRAIN_DATES = ['2026-05-05','2026-05-06','2026-05-08','2026-05-11','2026-05-12',
                     '2026-05-13','2026-05-14','2026-05-15','2026-05-18','2026-05-19'];
const TEST_DATES  = ['2026-05-20','2026-05-21','2026-05-22','2026-05-26','2026-05-27'];

// Entry must land in tradeable hours: 10:00 ≤ ET < 15:25, skip 11:50-13:15.
const ET_START       = 10*60;
const ET_END         = 15*60 + 25;
const ET_LUNCH_START = 11*60 + 50;
const ET_LUNCH_END   = 13*60 + 15;

type Trade = { ts: number; price: number; size: number; isBidAgg: 0|1 };
type LevelType = 'PDL'|'PDH'|'PML'|'PMH'|'ONL'|'ONH'|'PDC'|'RTHOpen';
type Direction = 'long' | 'short';   // long = down-overshoot+reclaim; short = up-overshoot+reject

interface Setup {
  date: string;
  level: LevelType;
  levelPrice: number;
  direction: Direction;
  // Geometry
  overshootStartTs: number;   // first cross through level
  overshootStartPx: number;
  extremePx: number;          // overshoot extreme (peak above or trough below)
  extremeTs: number;
  entryTs: number;            // cross back through level
  entryPx: number;
  overshootPts: number;       // |extreme - level|
  msToExtreme: number;        // overshootStart → extreme
  msToReturn: number;         // extreme → entry
  totalSetupMs: number;       // overshootStart → entry
  // Trade plan
  stopPx: number;
  targetPx: number;
  stopDist: number;
  // Outcome
  result?: 'W'|'L'|'T';
  maxGain?: number;
  maxDd?: number;
  resolveMs?: number;
}

function etMin(tsMs: number): number {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function etDate(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return d.toISOString().slice(0, 10);
}
function etHHMM(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}
function inTradeableET(tsMs: number): boolean {
  const m = etMin(tsMs);
  if (m < ET_START || m >= ET_END) return false;
  if (m >= ET_LUNCH_START && m <= ET_LUNCH_END) return false;
  return true;
}

function loadTrades(db: Database.Database, dateStr: string): Trade[] {
  const startTs = Date.parse(`${dateStr}T03:00:00-04:00`);
  const endTs   = Date.parse(`${dateStr}T16:30:00-04:00`);
  return db.prepare(
    `SELECT ts, price, size, is_bid_aggressor AS isBidAgg
     FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?
     ORDER BY ts ASC, id ASC`
  ).all(startTs, endTs) as Trade[];
}

// ─── Level computation ──────────────────────────────────────────────────────

function prevTradingDays(date: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${date}T12:00:00Z`);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function queryHighLow(db: Database.Database, date: string, from: string, to: string): { hi: number; lo: number } | null {
  const startTs = Date.parse(`${date}T${from}-04:00`);
  const endTs   = Date.parse(`${date}T${to}-04:00`);
  const row = db.prepare(
    `SELECT MAX(price) hi, MIN(price) lo FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?`
  ).get(startTs, endTs) as { hi: number; lo: number } | undefined;
  if (!row || row.hi == null || row.lo == null) return null;
  return row;
}
function queryClose(db: Database.Database, date: string, from: string, to: string): number | null {
  const startTs = Date.parse(`${date}T${from}-04:00`);
  const endTs   = Date.parse(`${date}T${to}-04:00`);
  const c = db.prepare(
    `SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1`
  ).get(startTs, endTs) as { price: number } | undefined;
  return c?.price ?? null;
}
function queryOpen(db: Database.Database, date: string, from: string, to: string): number | null {
  const startTs = Date.parse(`${date}T${from}-04:00`);
  const endTs   = Date.parse(`${date}T${to}-04:00`);
  const c = db.prepare(
    `SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ? ORDER BY ts ASC, id ASC LIMIT 1`
  ).get(startTs, endTs) as { price: number } | undefined;
  return c?.price ?? null;
}
function queryOvernightHL(db: Database.Database, prevDate: string, today: string): { hi: number; lo: number } | null {
  const startTs = Date.parse(`${prevDate}T16:00:00-04:00`);
  const endTs   = Date.parse(`${today}T09:30:00-04:00`);
  const row = db.prepare(
    `SELECT MAX(price) hi, MIN(price) lo FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?`
  ).get(startTs, endTs) as { hi: number; lo: number } | undefined;
  if (!row || row.hi == null || row.lo == null) return null;
  return row;
}

function computeLevels(db: Database.Database, dateStr: string): Partial<Record<LevelType, number>> {
  const out: Partial<Record<LevelType, number>> = {};
  const prev1 = prevTradingDays(dateStr, 1)[0]!;
  const pd = queryHighLow(db, prev1, '09:30', '16:00');
  if (pd) { out.PDL = pd.lo; out.PDH = pd.hi; }
  const pdc = queryClose(db, prev1, '09:30', '16:00');
  if (pdc != null) out.PDC = pdc;
  const pm = queryHighLow(db, dateStr, '04:00', '09:30');
  if (pm) { out.PML = pm.lo; out.PMH = pm.hi; }
  const on = queryOvernightHL(db, prev1, dateStr);
  if (on) { out.ONL = on.lo; out.ONH = on.hi; }
  const rthO = queryOpen(db, dateStr, '09:30', '16:00');
  if (rthO != null) out.RTHOpen = rthO;
  return out;
}

// ─── State machine per (level, direction) ───────────────────────────────────

type StateName = 'NEUTRAL' | 'OVERSHOOT';
interface MachineState {
  state: StateName;
  startTs: number;
  startPx: number;
  extremePx: number;
  extremeTs: number;
  cooldownUntilTs: number;
  prevPx: number;
}

function newState(initialPx: number): MachineState {
  return { state: 'NEUTRAL', startTs: 0, startPx: 0, extremePx: 0, extremeTs: 0, cooldownUntilTs: 0, prevPx: initialPx };
}

// Returns an emitted Setup OR null per tick.
function step(
  m: MachineState,
  dir: Direction,
  level: number,
  t: Trade,
  date: string,
  levelType: LevelType,
): Setup | null {
  let emitted: Setup | null = null;

  if (m.state === 'OVERSHOOT') {
    // Update extreme.
    if (dir === 'short') {
      if (t.price > m.extremePx) { m.extremePx = t.price; m.extremeTs = t.ts; }
    } else {
      if (t.price < m.extremePx) { m.extremePx = t.price; m.extremeTs = t.ts; }
    }
    // Abort if duration exceeded.
    if (t.ts - m.startTs > SETUP_MAX_MS) {
      m.state = 'NEUTRAL';
    } else {
      // Check for cross-back through level.
      const crossedBack =
        (dir === 'short' && m.prevPx > level && t.price <= level) ||   // came back down through
        (dir === 'long'  && m.prevPx < level && t.price >= level);     // came back up through
      if (crossedBack) {
        if (t.ts >= m.cooldownUntilTs && inTradeableET(t.ts)) {
          const overshootPts = dir === 'short' ? (m.extremePx - level) : (level - m.extremePx);
          const stopPx   = dir === 'short' ? m.extremePx + STOP_BUFFER : m.extremePx - STOP_BUFFER;
          const targetPx = dir === 'short' ? level - TARGET_PTS         : level + TARGET_PTS;
          const stopDist = Math.abs(stopPx - t.price);
          emitted = {
            date, level: levelType, levelPrice: level, direction: dir,
            overshootStartTs: m.startTs,
            overshootStartPx: m.startPx,
            extremePx: m.extremePx,
            extremeTs:  m.extremeTs,
            entryTs:    t.ts,
            entryPx:    t.price,
            overshootPts,
            msToExtreme:  m.extremeTs - m.startTs,
            msToReturn:   t.ts - m.extremeTs,
            totalSetupMs: t.ts - m.startTs,
            stopPx, targetPx, stopDist,
          };
          m.cooldownUntilTs = t.ts + COOLDOWN_MS;
        }
        m.state = 'NEUTRAL';
      }
    }
  }

  // Detect new overshoot start. NEUTRAL → OVERSHOOT on the SECOND-direction
  // cross (we use prevPx to detect the crossing).
  if (m.state === 'NEUTRAL') {
    const crossOut =
      (dir === 'short' && m.prevPx <= level && t.price > level) ||
      (dir === 'long'  && m.prevPx >= level && t.price < level);
    if (crossOut) {
      m.state = 'OVERSHOOT';
      m.startTs = t.ts;
      m.startPx = t.price;
      m.extremePx = t.price;
      m.extremeTs = t.ts;
    }
  }

  m.prevPx = t.price;
  return emitted;
}

// ─── Outcome scoring ────────────────────────────────────────────────────────

function scoreSetup(s: Setup, trades: Trade[]): void {
  let lo = 0, hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (trades[mid].ts <= s.entryTs) lo = mid + 1;
    else hi = mid;
  }
  const endTs = s.entryTs + HORIZON_MS;
  let maxGain = 0, maxDd = 0;
  for (let i = lo; i < trades.length && trades[i].ts <= endTs; i++) {
    const px = trades[i].price;
    if (s.direction === 'short') {
      const g = s.entryPx - px;
      const d = px - s.entryPx;
      if (g > maxGain) maxGain = g;
      if (d > maxDd)   maxDd   = d;
      if (px >= s.stopPx)   { s.result = 'L'; s.maxGain = maxGain; s.maxDd = maxDd; s.resolveMs = trades[i].ts - s.entryTs; return; }
      if (px <= s.targetPx) { s.result = 'W'; s.maxGain = maxGain; s.maxDd = maxDd; s.resolveMs = trades[i].ts - s.entryTs; return; }
    } else {
      const g = px - s.entryPx;
      const d = s.entryPx - px;
      if (g > maxGain) maxGain = g;
      if (d > maxDd)   maxDd   = d;
      if (px <= s.stopPx)   { s.result = 'L'; s.maxGain = maxGain; s.maxDd = maxDd; s.resolveMs = trades[i].ts - s.entryTs; return; }
      if (px >= s.targetPx) { s.result = 'W'; s.maxGain = maxGain; s.maxDd = maxDd; s.resolveMs = trades[i].ts - s.entryTs; return; }
    }
  }
  s.result = 'T';
  s.maxGain = maxGain;
  s.maxDd   = maxDd;
  s.resolveMs = HORIZON_MS;
}

// ─── Aggregation ────────────────────────────────────────────────────────────

function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)]!;
}

function summarize(label: string, ss: Setup[]) {
  if (!ss.length) { console.log(`${label.padEnd(28)}  n=0`); return; }
  const wins = ss.filter(s => s.result === 'W').length;
  const losses = ss.filter(s => s.result === 'L').length;
  const tos = ss.filter(s => s.result === 'T').length;
  const decided = wins + losses;
  const wr = decided ? (wins / decided) * 100 : 0;
  const totPnl = ss.reduce((a, s) => a + (s.result === 'W' ? TARGET_PTS : s.result === 'L' ? -s.stopDist : 0), 0);
  const ev = totPnl / ss.length;
  const overs = ss.map(s => s.overshootPts);
  const dursMin = ss.map(s => s.totalSetupMs / 60_000);
  console.log(
    `${label.padEnd(28)}  n=${String(ss.length).padStart(3)}  W=${String(wins).padStart(2)} L=${String(losses).padStart(2)} T=${String(tos).padStart(2)}  ` +
    `WR=${wr.toFixed(1).padStart(5)}%  EV=${ev.toFixed(1).padStart(5)}pt  ` +
    `osMin=${Math.min(...overs).toFixed(1).padStart(5)} osMax=${Math.max(...overs).toFixed(1).padStart(5)} osMed=${percentile(overs,0.5).toFixed(1).padStart(5)}  ` +
    `durMinMin=${Math.min(...dursMin).toFixed(1).padStart(5)} durMinMax=${Math.max(...dursMin).toFixed(1).padStart(5)}`
  );
}

async function main() {
  const arg = process.argv[2];
  let dates = TRAIN_DATES, mode = 'train';
  if (arg === 'test') { dates = TEST_DATES; mode = 'test'; }

  console.log(`Level-overshoot research — mode=${mode}  setup<=${SETUP_MAX_MS/60_000}min  horizon=${HORIZON_MS/60_000}min  target=${TARGET_PTS}pt  stop=overshoot+${STOP_BUFFER}pt`);
  const db = new Database(TICKS_DB, { readonly: true });
  db.pragma('journal_mode = WAL');

  const LEVELS: LevelType[] = ['PDL','PDH','PML','PMH','ONL','ONH','PDC','RTHOpen'];
  const all: Setup[] = [];
  for (const date of dates) {
    const trades = loadTrades(db, date);
    if (!trades.length) continue;
    const levels = computeLevels(db, date);
    // For each (level, direction) start a state machine; iterate trades once
    // and dispatch to every active machine.
    const machines: { lt: LevelType; dir: Direction; lvl: number; st: MachineState }[] = [];
    // Initialise prevPx using the price at the first tradeable boundary so the
    // first crossing is detected properly.
    const initialPx = trades[0]!.price;
    for (const lt of LEVELS) {
      const lvl = levels[lt];
      if (lvl == null) continue;
      machines.push({ lt, dir: 'short', lvl, st: newState(initialPx) });
      machines.push({ lt, dir: 'long',  lvl, st: newState(initialPx) });
    }
    for (const t of trades) {
      for (const m of machines) {
        const out = step(m.st, m.dir, m.lvl, t, date, m.lt);
        if (out) {
          scoreSetup(out, trades);
          all.push(out);
        }
      }
    }
  }
  db.close();

  console.log(`\nTotal setups: ${all.length}\n`);
  console.log(`label                          n    W  L  T   WR     EV     osMin osMax osMed   durMin  durMax`);
  for (const lt of ['PDL','PDH','PML','PMH','ONL','ONH','PDC','RTHOpen'] as LevelType[]) {
    for (const dir of ['short','long'] as Direction[]) {
      summarize(`${lt}-${dir}`, all.filter(s => s.level === lt && s.direction === dir));
    }
  }

  // Overall combined breakdown
  console.log('\nOverall by direction:');
  summarize('ALL-short', all.filter(s => s.direction === 'short'));
  summarize('ALL-long',  all.filter(s => s.direction === 'long'));
  summarize('ALL',       all);

  // Detail dump for winners only (so we can spot-check pattern)
  console.log('\nWinners detail (first 30):');
  const wins = all.filter(s => s.result === 'W').slice(0, 30);
  for (const s of wins) {
    console.log(
      `${s.date}  ${etHHMM(s.entryTs)}  ${s.level.padEnd(7)} ${s.direction.padEnd(5)} ` +
      `lvl=${s.levelPrice.toFixed(2)} entry=${s.entryPx.toFixed(2)} stop=${s.stopPx.toFixed(2)} tgt=${s.targetPx.toFixed(2)}  ` +
      `os=${s.overshootPts.toFixed(2)}pt  dur=${(s.totalSetupMs/60_000).toFixed(1)}m  res=${(s.resolveMs!/60_000).toFixed(1)}m`
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
