/**
 * Regime backtest for CF long signals.
 *
 * For each chart-visible NQ CF long, reconstructs the regime label that was
 * active at signal time (using the same 4-checkpoint / multi-factor logic as
 * the cockpit's computeRegime()) and checks whether a regime-based filter
 * would have improved or hurt results.
 *
 * Key finding (May 5–22, 2026, n=26):
 *   BEAR STRONG regime → 4/4 wins (100% WR, but n too small to trust)
 *   Regime filter as BLOCKER (silence in bearish) → makes things worse
 *   Regime filter as CONFIRMATION (require bearish) → promising but n=4
 *   Status: DO NOT implement live yet. Re-run monthly to grow dataset.
 *
 * Run: cd apps/aggregator && node_modules/.bin/tsx scripts/regime_cf_backtest.ts
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trDb    = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const levelsFile = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../daily_levels.json'), 'utf8')
);
const allDays = levelsFile.days as Record<string, { levels: any[] }>;

function getLevels(dateStr: string) {
  const d = allDays[dateStr];
  if (!d) return null;
  return d.levels.find((x: any) => x.symbol === 'NQ') ?? d.levels[0] ?? null;
}

// ─── ET helpers ───────────────────────────────────────────────────────────────
function etFmt(ms: number) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
}
function etMin(ms: number): number {
  const p = etFmt(ms);
  return parseInt(p.find(x => x.type === 'hour')!.value) * 60 +
         parseInt(p.find(x => x.type === 'minute')!.value);
}
function etDate(ms: number): string {
  const p = etFmt(ms);
  return p.find(x => x.type === 'year')!.value + '-' +
         p.find(x => x.type === 'month')!.value + '-' +
         p.find(x => x.type === 'day')!.value;
}
function isRTH(ms: number): boolean {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
    .format(new Date(ms));
  const m = etMin(ms);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(wd) && m >= 570 && m < 960;
}
function rthOpenMs(ms: number): number {
  const p = etFmt(ms);
  const mm = p.find(x => x.type === 'month')!.value;
  const dd = p.find(x => x.type === 'day')!.value;
  const yy = p.find(x => x.type === 'year')!.value;
  const edt = Date.parse(`${yy}-${mm}-${dd}T09:30:00-04:00`);
  const est = Date.parse(`${yy}-${mm}-${dd}T09:30:00-05:00`);
  return Math.abs(edt - ms) < 12 * 3600 * 1000 ? edt : est;
}

// ─── Minute bar builder ───────────────────────────────────────────────────────
const minuteBarCache = new Map<string, Map<number, any>>();

function getMinuteBars(dateStr: string, fromMs: number, toMs: number) {
  if (!minuteBarCache.has(dateStr)) {
    const m = new Map<number, any>();
    const ticks = ticksDb.prepare(
      `SELECT ts, price, size, is_bid_aggressor FROM trades
       WHERE symbol='NQ' AND ts >= ? AND ts < ? ORDER BY ts ASC`
    ).all(fromMs, toMs) as any[];
    for (const t of ticks) {
      const bucket = Math.floor(t.ts / 60_000) * 60_000;
      let b = m.get(bucket);
      if (!b) {
        b = { open: t.price, high: t.price, low: t.price, close: t.price, buy: 0, sell: 0 };
        m.set(bucket, b);
      }
      if (t.price > b.high) b.high = t.price;
      if (t.price < b.low)  b.low  = t.price;
      b.close = t.price;
      if (t.is_bid_aggressor) b.buy += t.size; else b.sell += t.size;
    }
    minuteBarCache.set(dateStr, m);
  }
  return Array.from(minuteBarCache.get(dateStr)!.entries())
    .filter(([ts]) => ts >= fromMs && ts < toMs)
    .map(([ts, b]) => ({ ts, ...b }))
    .sort((a, b) => a.ts - b.ts);
}

// ─── Regime computation (matches cockpit computeRegime logic) ─────────────────
type FDir = 'bull' | 'bear' | null;

function structDir(sortedBars: any[], intervalMs: number, beforeMs: number): FDir {
  const done  = sortedBars.filter(b => b.ts + intervalMs <= beforeMs);
  const last  = done.at(-1) ?? null;
  const prior = done.at(-2) ?? null;
  if (!last) return null;
  const range = last.high - last.low;
  const pos   = range > 0 ? (last.close - last.low) / range : 0.5;
  const trend = prior === null ? 0
    : last.close > prior.close ?  1
    : last.close < prior.close ? -1 : 0;
  if (pos >= 0.5 && trend >= 0) return 'bull';
  if (pos <  0.5 && trend <= 0) return 'bear';
  return null;
}

function cmp(price: number | null, level: number | null): FDir {
  if (price === null || level === null) return null;
  return price > level ? 'bull' : price < level ? 'bear' : null;
}
function ddDir(price: number | null, lvl: any): FDir {
  if (!price || !lvl?.ddBands) return null;
  const { upper, lower } = lvl.ddBands;
  if (upper === lower) return null;
  return (price - lower) / (upper - lower) > 0.5 ? 'bull' : 'bear';
}
function greaterMkt(price: number | null, lvl: any): FDir {
  if (!price || !lvl) return null;
  if (price > lvl.bullZone?.high) return 'bull';
  if (price < lvl.bearZone?.low)  return 'bear';
  return null;
}
function getAL(lvl: any, part: string): number | null {
  return lvl?.additionalLevels?.find((x: any) =>
    x.label.toUpperCase().includes(part.toUpperCase())
  )?.price ?? null;
}
function deltaDir(d: number): FDir { return d > 0 ? 'bull' : d < 0 ? 'bear' : null; }

type RegimeLabel = 'BULL STRONG' | 'BULL WEAK' | 'NEUTRAL' | 'BEAR WEAK' | 'BEAR STRONG';

function toLabel(factors: { dir: FDir }[]): RegimeLabel | null {
  const nn = factors.filter(f => f.dir !== null);
  if (nn.length === 0) return null;
  const bulls = nn.filter(f => f.dir === 'bull').length;
  const r = bulls / nn.length;
  if (r >= 2 / 3) return 'BULL STRONG';
  if (r > 0.5)    return 'BULL WEAK';
  if (r <= 1 / 3) return 'BEAR STRONG';
  if (r < 0.5)    return 'BEAR WEAK';
  return 'NEUTRAL';
}

function computeRegimeAt(
  signalMs: number,
  cpEtMin: number,
): { label: RegimeLabel | null; factors: { name: string; dir: FDir }[] } {
  const rthOpen = rthOpenMs(signalMs);
  const dateStr = etDate(signalMs);
  const cpMs    = rthOpen + (cpEtMin - 570) * 60_000;

  const fetchFrom = rthOpen - 24 * 3600_000;
  const fetchTo   = rthOpen + 400 * 60_000;
  const mins = getMinuteBars(dateStr, fetchFrom, fetchTo);
  const rthBars = mins.filter(b => b.ts >= rthOpen && b.ts < rthOpen + 390 * 60_000);

  const H4_MS = 240 * 60_000;
  const h4Map = new Map<number, any>();
  for (const b of mins) {
    const bucket = Math.floor(b.ts / H4_MS) * H4_MS;
    let h = h4Map.get(bucket);
    if (!h) { h = { ts: bucket, open: b.open, high: b.high, low: b.low, close: b.close, buy: b.buy, sell: b.sell }; h4Map.set(bucket, h); }
    if (b.high > h.high) h.high = b.high;
    if (b.low  < h.low)  h.low  = b.low;
    h.close = b.close; h.buy += b.buy; h.sell += b.sell;
  }
  const h4Bars = Array.from(h4Map.values()).sort((a, b) => a.ts - b.ts);

  const H1_MS = 60 * 60_000;
  const h1Map = new Map<number, any>();
  for (const b of mins) {
    const bucket = Math.floor(b.ts / H1_MS) * H1_MS;
    let h = h1Map.get(bucket);
    if (!h) { h = { ts: bucket, open: b.open, high: b.high, low: b.low, close: b.close }; h1Map.set(bucket, h); }
    if (b.high > h.high) h.high = b.high;
    if (b.low  < h.low)  h.low  = b.low;
    h.close = b.close;
  }
  const h1Bars = Array.from(h1Map.values()).sort((a, b) => a.ts - b.ts);

  const D1_MS = 1440 * 60_000;
  const d1Map = new Map<number, any>();
  for (const b of mins) {
    const bucket = Math.floor(b.ts / D1_MS) * D1_MS;
    let h = d1Map.get(bucket);
    if (!h) { h = { ts: bucket, open: b.open, high: b.high, low: b.low, close: b.close }; d1Map.set(bucket, h); }
    if (b.high > h.high) h.high = b.high;
    if (b.low  < h.low)  h.low  = b.low;
    h.close = b.close;
  }
  const d1Bars = Array.from(d1Map.values()).sort((a, b) => a.ts - b.ts);

  const lvl = getLevels(dateStr);

  const closeOf = (etMinute: number): number | null => {
    const targetMs = rthOpen + (etMinute - 570) * 60_000;
    return rthBars.find(b => Math.floor(b.ts / 60_000) === Math.floor(targetMs / 60_000))?.close ?? null;
  };
  const vwapUpTo = (toEtMin: number): number | null => {
    const toMs = rthOpen + (toEtMin - 570) * 60_000;
    let sumPV = 0, sumV = 0;
    for (const b of rthBars) {
      if (b.ts >= toMs) break;
      const vol = b.buy + b.sell;
      sumPV += ((b.high + b.low + b.close) / 3) * vol;
      sumV  += vol;
    }
    return sumV > 0 ? sumPV / sumV : null;
  };
  const deltaRange = (fromEtMin: number, toEtMin: number): number => {
    const fMs = rthOpen + (fromEtMin - 570) * 60_000;
    const tMs = rthOpen + (toEtMin   - 570) * 60_000;
    return rthBars.filter(b => b.ts >= fMs && b.ts < tMs).reduce((s, b) => s + b.buy - b.sell, 0);
  };

  let factors: { name: string; dir: FDir }[] = [];

  if (cpEtMin === 571) {
    const p = closeOf(571);
    factors = [
      { name: 'Daily',       dir: structDir(d1Bars, D1_MS, cpMs) },
      { name: '4H',          dir: structDir(h4Bars, H4_MS, cpMs) },
      { name: 'Greater mkt', dir: greaterMkt(p, lvl) },
      { name: 'DD ratio',    dir: ddDir(p, lvl) },
      { name: 'HP',          dir: cmp(p, lvl?.hedgePressure) },
      { name: 'ON HP',       dir: cmp(p, getAL(lvl, 'ON HP')) },
      { name: 'ON MHP',      dir: cmp(p, getAL(lvl, 'ON MHP')) },
      { name: 'HG',          dir: cmp(p, getAL(lvl, 'HG')) },
    ];
  } else if (cpEtMin === 600) {
    const p      = closeOf(599);
    const vwap   = vwapUpTo(600);
    const d30    = deltaRange(570, 600);
    const orBars = rthBars.filter(b => b.ts >= rthOpen && b.ts < rthOpen + 15 * 60_000);
    const orH    = orBars.length ? orBars.reduce((m, b) => Math.max(m, b.high), -Infinity) : null;
    const orL    = orBars.length ? orBars.reduce((m, b) => Math.min(m, b.low),  +Infinity) : null;
    const orBreak: FDir = p === null ? null
      : orH !== null && p > orH ? 'bull'
      : orL !== null && p < orL ? 'bear' : null;
    factors = [
      { name: 'Daily',     dir: structDir(d1Bars, D1_MS, cpMs) },
      { name: '4H',        dir: structDir(h4Bars, H4_MS, cpMs) },
      { name: 'VWAP',      dir: cmp(p, vwap) },
      { name: 'OR break',  dir: orBreak },
      { name: '30m delta', dir: deltaDir(d30) },
    ];
  } else if (cpEtMin === 720) {
    const p    = closeOf(719);
    const vwap = vwapUpTo(720);
    factors = [
      { name: 'Daily',      dir: structDir(d1Bars, D1_MS, cpMs) },
      { name: '4H',         dir: structDir(h4Bars, H4_MS, cpMs) },
      { name: 'H1',         dir: structDir(h1Bars, H1_MS, cpMs) },
      { name: 'VWAP',       dir: cmp(p, vwap) },
      { name: 'Sess delta', dir: deltaDir(deltaRange(570, 720)) },
    ];
  } else if (cpEtMin === 810) {
    const p    = closeOf(809);
    const vwap = vwapUpTo(810);
    const mornBars = rthBars.filter(b => b.ts >= rthOpen && b.ts < rthOpen + 150 * 60_000);
    const mH   = mornBars.length ? mornBars.reduce((m, b) => Math.max(m, b.high), -Infinity) : null;
    const mL   = mornBars.length ? mornBars.reduce((m, b) => Math.min(m, b.low),  +Infinity) : null;
    const vsMorn: FDir = p === null ? null
      : mH !== null && p > mH ? 'bull'
      : mL !== null && p < mL ? 'bear' : null;
    factors = [
      { name: 'Daily',   dir: structDir(d1Bars, D1_MS, cpMs) },
      { name: '4H',      dir: structDir(h4Bars, H4_MS, cpMs) },
      { name: 'H1',      dir: structDir(h1Bars, H1_MS, cpMs) },
      { name: 'VWAP',    dir: cmp(p, vwap) },
      { name: 'vs morn', dir: vsMorn },
    ];
  }

  return { label: toLabel(factors), factors };
}

function activeCheckpoint(sigEtMin: number): number {
  return [...[571, 600, 720, 810]].filter(c => c <= sigEtMin).at(-1) ?? 571;
}

// ─── Win/loss evaluation ──────────────────────────────────────────────────────
const TP = 80, SL = 55;
const fwdQ   = ticksDb.prepare(
  `SELECT ts, price FROM trades WHERE symbol='NQ' AND ts > ? AND ts <= ? ORDER BY ts ASC`
);
const entryQ = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? ORDER BY ts ASC LIMIT 1`
);

function resolve(ts: number, payload: string): number {
  const p = JSON.parse(payload);
  if (p.entry && p.entry > 1000) return p.entry;
  return (entryQ.get(ts) as any)?.price ?? 0;
}
function outcome(ts: number, ep: number): 'win' | 'loss' | 'open' | 'no_entry' {
  if (ep <= 0) return 'no_entry';
  const rthEnd = rthOpenMs(ts) + 390 * 60_000;
  for (const t of fwdQ.all(ts, rthEnd) as any[]) {
    const pnl = t.price - ep;
    if (pnl >= TP)  return 'win';
    if (pnl <= -SL) return 'loss';
  }
  return 'open';
}

// ─── Load chart-visible CF long signals ───────────────────────────────────────
const rows = (trDb.prepare(`
  WITH expl_sig AS (
    SELECT ts AS expl_ts, direction AS expl_dir,
      CAST(json_extract(payload,'$.delta5') AS REAL) AS expl_d5,
      CAST(json_extract(payload,'$.deltaT') AS REAL) AS expl_dT
    FROM signals WHERE rule_id='expl' AND strategy_version='EXPL' AND symbol='NQ'
  ),
  cf AS (
    SELECT ts, payload, CAST(json_extract(payload,'$.delta5') AS REAL) AS delta5
    FROM signals
    WHERE rule_id='clean-impulse' AND direction='long' AND strategy_version='H' AND symbol='NQ'
      AND rs_hard_filtered IS NOT 1
      AND json_extract(meta,'$.filtered') IS NOT 1
      AND (json_extract(payload,'$.delta15') IS NULL OR
           CAST(json_extract(payload,'$.delta15') AS REAL) < 500)
      AND CAST(json_extract(payload,'$.delta5') AS REAL) <= -1000
  ),
  opp_expl AS (
    SELECT cf.ts AS cf_ts, e.expl_ts AS last_opp_ts, e.expl_d5 AS opp_d5, e.expl_dT AS opp_dT
    FROM cf JOIN expl_sig e ON e.expl_dir='short'
      AND e.expl_ts >= cf.ts - 3600000 AND e.expl_ts < cf.ts
      AND e.expl_ts = (
        SELECT MAX(e2.expl_ts) FROM expl_sig e2 WHERE e2.expl_dir='short'
          AND e2.expl_ts >= cf.ts - 3600000 AND e2.expl_ts < cf.ts
      )
  ),
  same_expl AS (
    SELECT cf.ts AS cf_ts, MAX(e.expl_ts) AS last_same_ts
    FROM cf JOIN expl_sig e ON e.expl_dir='long'
      AND e.expl_ts >= cf.ts - 3600000 AND e.expl_ts < cf.ts
    GROUP BY cf.ts
  ),
  conflict AS (
    SELECT cf.ts, cf.payload,
      CASE WHEN o.last_opp_ts IS NOT NULL
            AND (s.last_same_ts IS NULL OR o.last_opp_ts > s.last_same_ts)
           THEN 1 ELSE 0 END AS has_conflict,
      ABS(o.opp_dT) * 1.0 / MAX(ABS(o.opp_d5), 1) AS ratio
    FROM cf
    LEFT JOIN opp_expl o ON o.cf_ts = cf.ts
    LEFT JOIN same_expl s ON s.cf_ts = cf.ts
  )
  SELECT ts, payload FROM conflict WHERE NOT (has_conflict = 1 AND ratio > 0.25) ORDER BY ts
`).all() as any[]).filter(s => isRTH(s.ts));

// ─── Run backtest ─────────────────────────────────────────────────────────────
console.log(`\n=== REGIME BACKTEST — CF LONG (TP=${TP}, SL=${SL}) ===\n`);
console.log('ET               | Outcome | Active CP | Regime Label    | Silenced? | Factors');
console.log('-----------------|---------|-----------|-----------------|-----------|--------');

let winsKept = 0, winsBlocked = 0, lossesBlocked = 0, lossesKept = 0;
let opensKept = 0, opensBlocked = 0;

// Tally by regime for the summary table
const byRegime = new Map<string, { wins: number; losses: number }>();

for (const s of rows) {
  const ep  = resolve(s.ts, s.payload);
  const res = outcome(s.ts, ep);
  const em  = etMin(s.ts);
  const cp  = activeCheckpoint(em);
  const { label, factors } = computeRegimeAt(s.ts, cp);
  const silencedByBlock  = label === 'BEAR STRONG' || label === 'BEAR WEAK';
  // "Confirm" mode: only allowed if BEAR label (for tracking hypothesis)
  const et     = new Date(s.ts - 4 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
  const cpStr  = cp === 571 ? '09:31' : cp === 600 ? '10:00' : cp === 720 ? '12:00' : '13:30';
  const fStr   = factors.map(f => f.dir === 'bull' ? '▲' : f.dir === 'bear' ? '▼' : '·').join(' ');
  const lKey   = label ?? 'null';

  if (!byRegime.has(lKey)) byRegime.set(lKey, { wins: 0, losses: 0 });
  if (res === 'win')  byRegime.get(lKey)!.wins++;
  if (res === 'loss') byRegime.get(lKey)!.losses++;

  if (res === 'win')  { silencedByBlock ? winsBlocked++  : winsKept++;  }
  if (res === 'loss') { silencedByBlock ? lossesBlocked++ : lossesKept++; }
  if (res === 'open') { silencedByBlock ? opensBlocked++  : opensKept++; }

  const sTag = silencedByBlock ? '  BLOCKED' : '  ok';
  const rTag = res === 'win' ? 'WIN  ' : res === 'loss' ? 'LOSS ' : 'OPEN ';
  console.log(
    `${et} | ${rTag}   | ${cpStr}      | ${(label ?? '—').padEnd(15)} | ${sTag.padEnd(9)} | ${fStr}`
  );
}

// ─── Summary ──────────────────────────────────────────────────────────────────
const resolved      = winsKept + winsBlocked + lossesKept + lossesBlocked;
const resolvedAfter = winsKept + lossesKept;
const wrBefore  = (winsKept + winsBlocked) / resolved * 100;
const wrAfter   = resolvedAfter > 0 ? winsKept / resolvedAfter * 100 : 0;
const evBefore  = ((winsKept + winsBlocked) * TP - (lossesKept + lossesBlocked) * SL) / resolved;
const evAfter   = resolvedAfter > 0 ? (winsKept * TP - lossesKept * SL) / resolvedAfter : 0;

console.log('\n=== REGIME FILTER AS BLOCKER (silence CF long in bearish regime) ===');
console.log(`Winners kept:    ${winsKept}   Winners BLOCKED: ${winsBlocked} ← false positives`);
console.log(`Losses blocked:  ${lossesBlocked}   Losses kept:     ${lossesKept}`);
console.log(`Before: WR=${wrBefore.toFixed(1)}%  EV=+${evBefore.toFixed(1)}pts  PnL/100=+$${(evBefore*100*20).toFixed(0)}`);
console.log(`After:  WR=${wrAfter.toFixed(1)}%  EV=+${evAfter.toFixed(1)}pts  PnL/100=+$${(evAfter*100*20).toFixed(0)}`);
console.log(`Verdict: ${evAfter > evBefore ? '✅ improves' : '❌ hurts'} results`);

console.log('\n=== WR BY REGIME LABEL (tracking BEAR STRONG hypothesis) ===');
const order: RegimeLabel[] = ['BEAR STRONG', 'BEAR WEAK', 'NEUTRAL', 'BULL WEAK', 'BULL STRONG'];
console.log('Regime          | Wins | Losses | WR');
console.log('----------------|------|--------|----');
for (const lbl of order) {
  const r = byRegime.get(lbl);
  if (!r) { console.log(`${lbl.padEnd(16)}|    0 |      0 | —`); continue; }
  const wr = r.wins + r.losses > 0 ? (r.wins / (r.wins + r.losses) * 100).toFixed(0) + '%' : '—';
  console.log(`${lbl.padEnd(16)}| ${String(r.wins).padStart(4)} | ${String(r.losses).padStart(6)} | ${wr}`);
}
console.log(`\nBEAR STRONG hypothesis: need n≥30 before implementing as confirmation gate.`);
console.log(`Current BEAR STRONG n=${(byRegime.get('BEAR STRONG')?.wins ?? 0) + (byRegime.get('BEAR STRONG')?.losses ?? 0)}`);
