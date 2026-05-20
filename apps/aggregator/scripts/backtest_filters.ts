/**
 * backtest_filters.ts
 *
 * Checks the three new quality gates against all 87 H/EXPL signals to find
 * any collateral damage (PASS signals that would be newly silenced).
 *
 * Gates:
 *   F1: EXPL long  — rangePct < 0.5  → silenced
 *   F2: H FLIP long — delta15 > 0    → silenced
 *   F3: regime gate — 2-of-3 bearish conditions (CVD slope + EXPL breach + afternoon distribution)
 *
 * Run: cd apps/aggregator && npx tsx scripts/backtest_filters.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../../data/trading.db');
const db = new Database(DB_PATH, { readonly: true });

interface Signal {
  id: number; ts: number; symbol: string; direction: string;
  strategy_version: string; score: number;
  pattern: string | null; delta15: number | null; delta5: number | null;
  rangePct: number | null;
}
interface Outcome {
  hit20: number; hit40: number; dd_at_20: number | null; dd_at_40: number | null; max_gain: number; max_dd: number;
}
interface Bar {
  ts: number; open: number; high: number; low: number; close: number;
  buyVolume: number; sellVolume: number;
}

const signals = db.prepare(`
  SELECT s.id, s.ts, s.symbol, s.direction, s.strategy_version, s.score,
    json_extract(s.payload,'$.pattern')  AS pattern,
    json_extract(s.payload,'$.delta15')  AS delta15,
    json_extract(s.payload,'$.delta5')   AS delta5,
    json_extract(s.payload,'$.rangePct') AS rangePct
  FROM signals s
  WHERE s.strategy_version IN ('H','EXPL')
  ORDER BY s.ts ASC
`).all() as Signal[];

const outcomes = new Map<number, Outcome>();
for (const row of db.prepare(`SELECT signal_id, hit20, hit40, dd_at_20, dd_at_40, max_gain, max_dd FROM h_expl_outcomes`).all() as (Outcome & { signal_id: number })[]) {
  outcomes.set(row.signal_id, row);
}

function isPass(o: Outcome | undefined): boolean {
  if (!o) return false;
  return o.hit20 === 1 && o.dd_at_20 !== null && o.dd_at_20 < 42;
}

// ── RTH open timestamp ────────────────────────────────────────────────────────
function getRthOpenTs(ts: number): number {
  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ts));
  const [mm, dd, yyyy] = datePart.split('/');
  const probeHour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false,
  }).format(new Date(ts)), 10);
  const utcHour = new Date(ts).getUTCHours();
  const offsetH = ((utcHour - probeHour) + 24) % 24;
  const offset = offsetH === 4 ? '-04:00' : '-05:00';
  return Date.parse(`${yyyy}-${mm}-${dd}T09:30:00${offset}`);
}

// ── Session bars ──────────────────────────────────────────────────────────────
function getSessionBars(symbol: string, rthOpen: number, upToTs: number): Bar[] {
  const rows = db.prepare(`
    SELECT payload FROM events
    WHERE source IN ('bookmap','bookmap-es') AND type='bar' AND symbol=? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(symbol, rthOpen, upToTs) as { payload: string }[];
  const byBucket = new Map<number, Bar>();
  for (const r of rows) {
    const b = JSON.parse(r.payload) as Bar;
    byBucket.set(b.ts, b);
  }
  return Array.from(byBucket.values()).sort((a, b) => a.ts - b.ts);
}

// ── EXPL signals in window ────────────────────────────────────────────────────
function explInWindow(symbol: string, fromTs: number, beforeTs: number): { ts: number; direction: string }[] {
  return db.prepare(`
    SELECT ts, direction FROM signals
    WHERE rule_id='expl' AND symbol=? AND ts>=? AND ts<?
    ORDER BY ts ASC
  `).all(symbol, fromTs, beforeTs) as { ts: number; direction: string }[];
}

// ── Regime context ─────────────────────────────────────────────────────────────
interface RegimeCtx {
  cvdLast30m: number; cvdPrev30m: number;
  sessionHigh: number; sessionOpen: number; currentPrice: number;
  failedSameDirExpls: number;
}

function buildRegime(sig: Signal, bars: Bar[]): RegimeCtx {
  const sessionOpen  = bars[0]?.open ?? 0;
  const sessionHigh  = Math.max(...bars.map(b => b.high));
  const sessionLow   = Math.min(...bars.map(b => b.low));
  const currentPrice = bars.at(-1)?.close ?? 0;

  const now = sig.ts;
  const cvdLast30m = bars
    .filter(b => b.ts >= now - 30 * 60_000 && b.ts <= now)
    .reduce((s, b) => s + (b.buyVolume ?? 0) - (b.sellVolume ?? 0), 0);
  const cvdPrev30m = bars
    .filter(b => b.ts >= now - 60 * 60_000 && b.ts < now - 30 * 60_000)
    .reduce((s, b) => s + (b.buyVolume ?? 0) - (b.sellVolume ?? 0), 0);

  const rthOpen = getRthOpenTs(sig.ts);
  const todayExpls = explInWindow(sig.symbol, rthOpen, sig.ts)
    .filter(e => e.direction === sig.direction && (sig.ts - e.ts) > 30 * 60_000);

  const failedSameDirExpls = todayExpls.filter(expl => {
    const nearest = bars.reduce(
      (best, b) => Math.abs(b.ts - expl.ts) < Math.abs(best.ts - expl.ts) ? b : best,
      bars[0]!
    );
    return currentPrice < nearest.close - 15;
  }).length;

  return { cvdLast30m, cvdPrev30m, sessionHigh, sessionLow, sessionOpen, currentPrice, failedSameDirExpls } as RegimeCtx & { sessionLow: number };
}

function isRegimeBearish(sig: Signal, ctx: RegimeCtx): { bearish: boolean; condA: boolean; condB: boolean; condC: boolean } {
  const condA = (ctx.cvdLast30m - ctx.cvdPrev30m) < -3000;
  const condB = ctx.failedSameDirExpls >= 1;
  const condC = (() => {
    const gain = ctx.sessionHigh - ctx.sessionOpen;
    if (gain < 100) return false;
    const giveback = (ctx.sessionHigh - ctx.currentPrice) / gain;
    if (giveback < 0.4) return false;
    const hour = parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hour12: false,
    }).format(new Date(sig.ts)), 10);
    return hour >= 13;
  })();
  const score = (condA ? 1 : 0) + (condB ? 1 : 0) + (condC ? 1 : 0);
  return { bearish: score >= 2, condA, condB, condC };
}

// ── Main analysis ─────────────────────────────────────────────────────────────
const fmt = (ts: number) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ts)).replace(',', '');

type FilterResult = 'F1' | 'F2' | 'F3' | 'pass';

interface Row {
  sig: Signal; outcome: Outcome | undefined;
  wasPass: boolean; filter: FilterResult; notes: string;
}

const rows: Row[] = [];

for (const sig of signals) {
  const outcome = outcomes.get(sig.id);
  const wasPass = isPass(outcome);

  // F1: EXPL long rangePct < 0.5
  if (sig.strategy_version === 'EXPL' && sig.direction === 'long') {
    const rp = sig.rangePct;
    if (rp !== null && rp < 0.5) {
      rows.push({ sig, outcome, wasPass, filter: 'F1', notes: `rangePct=${rp.toFixed(3)}` });
      continue;
    }
  }

  // F2: H FLIP long delta15 >= 500 (strong buyer dominance, not noise)
  if (sig.strategy_version === 'H' && sig.pattern === 'FLIP' && sig.direction === 'long') {
    const d15 = sig.delta15;
    if (d15 !== null && d15 >= 500) {
      rows.push({ sig, outcome, wasPass, filter: 'F2', notes: `delta15=+${d15}` });
      continue;
    }
  }

  // F3: regime gate — DISABLED pending CVD threshold calibration
  // condA never fires; condB+condC alone has 2 collateral vs 1 correct on 5/11 afternoon
  // and misses the 5/08 afternoon cluster entirely (no failed EXPLs that day).

  rows.push({ sig, outcome, wasPass, filter: 'pass', notes: '' });
}

// ── Print collateral damage ───────────────────────────────────────────────────
const damaged = rows.filter(r => r.filter !== 'pass' && r.wasPass);
const blocked  = rows.filter(r => r.filter !== 'pass' && !r.wasPass);
const through  = rows.filter(r => r.filter === 'pass');

console.log('\n══ COLLATERAL DAMAGE (good signals now blocked) ══════════════════════');
if (damaged.length === 0) {
  console.log('  None — zero collateral damage.');
} else {
  console.log('  date/time   strat  dir  sc  result  filter  notes');
  for (const r of damaged) {
    const o = r.outcome;
    console.log(
      '  ' + fmt(r.sig.ts).padEnd(14) +
      r.sig.strategy_version.padEnd(7) +
      r.sig.direction.padEnd(5) +
      String(r.sig.score).padStart(3) + '  ' +
      'PASS    ' +
      r.filter + '  ' +
      r.notes
    );
  }
}

console.log('\n══ CORRECTLY BLOCKED (bad signals that would now be silenced) ════════');
console.log('  date/time   strat  dir  sc  result  filter  notes');
for (const r of blocked) {
  const o = r.outcome;
  const mfe = o ? o.max_gain.toFixed(0) : '?';
  const mae = o ? o.max_dd.toFixed(0) : '?';
  console.log(
    '  ' + fmt(r.sig.ts).padEnd(14) +
    r.sig.strategy_version.padEnd(7) +
    r.sig.direction.padEnd(5) +
    String(r.sig.score).padStart(3) + '  ' +
    'FAIL    ' +
    r.filter + '  ' +
    r.notes
  );
}

console.log(`\n  Blocked: ${blocked.length} bad signals | Collateral: ${damaged.length} good signals | Through: ${through.length} signals`);

// ── Per-filter summary ────────────────────────────────────────────────────────
for (const f of ['F1', 'F2', 'F3'] as const) {
  const bk = rows.filter(r => r.filter === f);
  const coll = bk.filter(r => r.wasPass).length;
  const corr = bk.filter(r => !r.wasPass).length;
  console.log(`  Filter ${f}: blocks ${bk.length} signals (${corr} correct, ${coll} collateral)`);
}

db.close();
