// backtest_structural_tp.ts — vary ONE variable: TP placement.
// SL held at FIXED per-rule (80/55/70/105). Only TP changes per row.
//
// Variants:
//   FIXED  : TP = 80 (control — what we run today)
//   STRUCT : TP = nearest level from daily_levels.json in trade direction,
//            capped to [MIN_TP, MAX_TP] pt range. If no level in range,
//            falls back to FIXED 80.
//
// Levels considered (every label from daily_levels.json):
//   For LONG : levels above entry (TP overhead)
//   For SHORT: levels below entry (TP downside)
//
// Cohort: QUALIFIED FLIP+CONT, same 148 signals as previous tests.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb   = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const DOLLAR_PER_PT = 2;
const REPO_ROOT = path.resolve(__dirname, '../../..');

// ── Load all levels from both daily_levels files, keyed by ET date ──────────
interface LevelEntry { price: number; label: string; }
interface DayLevels { NQ: LevelEntry[]; ES: LevelEntry[]; }
const allDayLevels = new Map<string, DayLevels>();
function loadLevelsFile(file: string) {
  if (!fs.existsSync(file)) return;
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as any;
  for (const [date, day] of Object.entries(data.days ?? {})) {
    const d = day as any;
    const existing = allDayLevels.get(date) ?? { NQ: [], ES: [] };
    for (const block of d.levels ?? []) {
      const sym = block.symbol as 'NQ' | 'ES';
      const arr = existing[sym];
      // Top-level wide-band fields (bullZone, bearZone, ddBands, hedgePressure, mhp)
      if (block.hedgePressure) arr.push({ price: block.hedgePressure, label: 'HP' });
      if (block.mhp)           arr.push({ price: block.mhp, label: 'MHP' });
      if (block.ddBands?.upper) arr.push({ price: block.ddBands.upper, label: 'DD↑' });
      if (block.ddBands?.lower) arr.push({ price: block.ddBands.lower, label: 'DD↓' });
      if (block.bullZone?.low)  arr.push({ price: block.bullZone.low, label: 'BullL' });
      if (block.bullZone?.high) arr.push({ price: block.bullZone.high, label: 'BullH' });
      if (block.bearZone?.low)  arr.push({ price: block.bearZone.low, label: 'BearL' });
      if (block.bearZone?.high) arr.push({ price: block.bearZone.high, label: 'BearH' });
      // additionalLevels[]
      for (const lvl of block.additionalLevels ?? []) {
        if (typeof lvl.price === 'number') arr.push({ price: lvl.price, label: lvl.label });
      }
      existing[sym] = arr;
    }
    allDayLevels.set(date, existing);
  }
}
loadLevelsFile(path.join(REPO_ROOT, 'daily_levels.json'));
loadLevelsFile(path.join(REPO_ROOT, 'daily_levels_es.json'));
console.log(`Loaded levels for ${allDayLevels.size} days`);

// ── Level whitelist tiers ──────────────────────────────────────────────────
const STRONG_LABELS = new Set([
  'POC', 'PDH', 'PDL', 'HG', 'HP', 'MHP', 'VAH', 'VAL',
  'Bull Zone', 'Bear Zone', 'BullL', 'BullH', 'BearL', 'BearH',
  'QQQ Open', 'QQQ Close', 'SPY Open', 'SPY Close',
  'DD↑', 'DD↓', 'DD',
]);
const MEDIUM_LABELS = new Set(['ONH', 'ONL']);
const EXCLUDED_LABELS = new Set(['PDC', 'ONO', 'NQ Close', 'ES Close']);

// ── Find nearest structural level in trade direction (filtered by tier) ─────
function structuralTpRange(symbol: 'NQ'|'ES', etDate: string, entry: number, direction: 'long'|'short', minPt: number, maxPt: number, labelFilter?: Set<string>): number | null {
  const day = allDayLevels.get(etDate);
  if (!day) return null;
  const levels = day[symbol];
  if (!levels || levels.length === 0) return null;
  const candidates: number[] = [];
  for (const lvl of levels) {
    if (labelFilter && !labelFilter.has(lvl.label)) continue;
    const distPts = direction === 'long' ? lvl.price - entry : entry - lvl.price;
    if (distPts < minPt || distPts > maxPt) continue;
    candidates.push(distPts);
  }
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

// ── Standard simulation helpers (same as previous scripts) ──────────────────
function fixedSl(ruleId: string, direction: 'long'|'short'): number {
  if (ruleId === 'clean-impulse') return direction === 'long' ? 55 : 105;
  if (ruleId === 'cont-reentry')  return 70;
  throw new Error(`No SL for ${ruleId}`);
}
function fixedTp(_ruleId: string): number { return 80; }

const tickRangeStmt = ticksDb.prepare(`SELECT ts, price FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`);
function walkExit(symbol: string, openTs: number, untilTs: number, entry: number, dir: 'long'|'short', tp: number, sl: number) {
  const tpPx = dir === 'long' ? entry + tp : entry - tp;
  const slPx = dir === 'long' ? entry - sl : entry + sl;
  for (const r of tickRangeStmt.iterate(symbol, openTs, untilTs) as IterableIterator<{ ts: number; price: number }>) {
    if (dir === 'long') {
      if (r.price <= slPx) return { ts: r.ts, price: slPx, reason: 'SL' as const };
      if (r.price >= tpPx) return { ts: r.ts, price: tpPx, reason: 'TP' as const };
    } else {
      if (r.price >= slPx) return { ts: r.ts, price: slPx, reason: 'SL' as const };
      if (r.price <= tpPx) return { ts: r.ts, price: tpPx, reason: 'TP' as const };
    }
  }
  return null;
}
const lastTickStmt = ticksDb.prepare(`SELECT price FROM trades WHERE symbol=? AND ts <= ? ORDER BY ts DESC LIMIT 1`);

const fmtEtDate = (tsMs: number) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = p.split('/');
  return `${yyyy}-${mm}-${dd}`;
};
const rthCloseTsFor = (tsMs: number) => Date.parse(`${fmtEtDate(tsMs)}T15:54:00-04:00`);

interface Sig { signal_id: number; ts: number; symbol: 'NQ'|'ES'; rule_id: string; direction: 'long'|'short'; entry: number; }
const sigs = tradingDb.prepare(`
  SELECT s.id AS signal_id, s.ts, s.symbol, s.rule_id, s.direction,
         CAST(json_extract(s.payload, '$.entry') AS REAL) AS entry
  FROM signals s
  JOIN tradable_signals t ON t.signal_id = s.id
  WHERE s.rule_id IN ('clean-impulse','cont-reentry')
    AND s.symbol = 'NQ'
    AND t.qualified = 1
    AND CAST(json_extract(s.payload, '$.entry') AS REAL) IS NOT NULL
  ORDER BY s.ts ASC
`).all() as Sig[];

console.log(`\n══ Structure-anchored TP backtest — QUALIFIED ${sigs.length} signals ══`);
console.log(`   (only TP varies; SL held at fixed 55/70/105 per rule+direction)`);

interface Trade { pnl_pts: number; reason: 'TP'|'SL'|'OPP'|'RTH'; tp_pts: number; structural: boolean; }
type TpFn = (sig: Sig) => { tp: number; structural: boolean };
function simulate(tpFn: TpFn): Trade[] {
  const completed: Trade[] = [];
  let open: { sig: Sig; tp: number; sl: number; structural: boolean } | null = null;
  let prevDate: string | null = null;

  function closeAtRth(rthTs: number) {
    if (!open) return;
    const o = open;
    const hit = walkExit(o.sig.symbol, o.sig.ts, rthTs, o.sig.entry, o.sig.direction, o.tp, o.sl);
    if (hit) {
      const pnl = o.sig.direction === 'long' ? hit.price - o.sig.entry : o.sig.entry - hit.price;
      completed.push({ pnl_pts: pnl, reason: hit.reason, tp_pts: o.tp, structural: o.structural });
    } else {
      const r = lastTickStmt.get(o.sig.symbol, rthTs) as { price: number } | undefined;
      const px = r?.price ?? o.sig.entry;
      const pnl = o.sig.direction === 'long' ? px - o.sig.entry : o.sig.entry - px;
      completed.push({ pnl_pts: pnl, reason: 'RTH', tp_pts: o.tp, structural: o.structural });
    }
    open = null;
  }

  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i]!;
    const etDate = fmtEtDate(s.ts);
    if (prevDate && etDate !== prevDate) closeAtRth(rthCloseTsFor(sigs[i - 1]!.ts));
    prevDate = etDate;

    if (open) {
      const o = open;
      const hit = walkExit(o.sig.symbol, o.sig.ts, s.ts, o.sig.entry, o.sig.direction, o.tp, o.sl);
      if (hit) {
        const pnl = o.sig.direction === 'long' ? hit.price - o.sig.entry : o.sig.entry - hit.price;
        completed.push({ pnl_pts: pnl, reason: hit.reason, tp_pts: o.tp, structural: o.structural });
        open = null;
      }
    }
    if (open) {
      if (open.sig.direction === s.direction) continue;
      const o = open;
      const pnl = o.sig.direction === 'long' ? s.entry - o.sig.entry : o.sig.entry - s.entry;
      completed.push({ pnl_pts: pnl, reason: 'OPP', tp_pts: o.tp, structural: o.structural });
      open = null;
    }
    const { tp, structural } = tpFn(s);
    const sl = fixedSl(s.rule_id, s.direction);
    open = { sig: s, tp, sl, structural };
  }
  if (prevDate) closeAtRth(rthCloseTsFor(sigs[sigs.length - 1]!.ts));
  return completed;
}

interface Stats { n: number; w: number; l: number; wr: number; usd: number; ev: number; structFallback: number; tpAvg: number; tpHits: number; slHits: number; oppExits: number; rthExits: number; }
const statsOf = (trades: Trade[]): Stats => {
  const n = trades.length;
  const w = trades.filter(t => t.pnl_pts > 0).length;
  const l = trades.filter(t => t.pnl_pts < 0).length;
  const usd = trades.reduce((s, t) => s + t.pnl_pts, 0) * DOLLAR_PER_PT;
  const wr = (w + l) ? (w / (w + l)) * 100 : 0;
  return {
    n, w, l, wr, usd, ev: n ? usd / n : 0,
    structFallback: trades.filter(t => !t.structural).length,
    tpAvg: n ? trades.reduce((s, t) => s + t.tp_pts, 0) / n : 0,
    tpHits:   trades.filter(t => t.reason === 'TP').length,
    slHits:   trades.filter(t => t.reason === 'SL').length,
    oppExits: trades.filter(t => t.reason === 'OPP').length,
    rthExits: trades.filter(t => t.reason === 'RTH').length,
  };
};

interface Variant { label: string; fn: TpFn; }
const STRONG_PLUS_MEDIUM = new Set([...STRONG_LABELS, ...MEDIUM_LABELS]);
const variants: Variant[] = [
  { label: 'FIXED TP=80 (control)',                                  fn: (s) => ({ tp: 80, structural: false }) },
  { label: 'STRUCT 20-200pt  ALL levels   (today best)',             fn: (s) => { const tp = structuralTpRange(s.symbol, fmtEtDate(s.ts), s.entry, s.direction, 20, 200); return tp != null ? { tp, structural: true } : { tp: 80, structural: false }; } },
  { label: 'STRUCT 20-200pt  STRONG only',                           fn: (s) => { const tp = structuralTpRange(s.symbol, fmtEtDate(s.ts), s.entry, s.direction, 20, 200, STRONG_LABELS); return tp != null ? { tp, structural: true } : { tp: 80, structural: false }; } },
  { label: 'STRUCT 20-200pt  STRONG + MEDIUM (incl ONH/ONL)',        fn: (s) => { const tp = structuralTpRange(s.symbol, fmtEtDate(s.ts), s.entry, s.direction, 20, 200, STRONG_PLUS_MEDIUM); return tp != null ? { tp, structural: true } : { tp: 80, structural: false }; } },
];

const pad = (s: string, n: number, right = false): string => right ? s.padStart(n) : s.padEnd(n);
console.log(`\n┌──────────────────────────────────────────────────┬─────┬─────┬─────┬────────┬───────────┬──────────┬──────────┬──────────────────────┐`);
console.log(`│ Variant                                          │  n  │  W  │  L  │   WR   │  Total $  │ EV/trade │ avg TP   │ TP / SL / OPP / RTH  │`);
console.log(`├──────────────────────────────────────────────────┼─────┼─────┼─────┼────────┼───────────┼──────────┼──────────┼──────────────────────┤`);
for (const v of variants) {
  const trades = simulate(v.fn);
  const s = statsOf(trades);
  const wrStr = `${s.wr.toFixed(1)}%`;
  const usdStr = `${s.usd >= 0 ? '+$' : '-$'}${Math.abs(s.usd).toFixed(0)}`;
  const evStr  = `${s.ev >= 0 ? '+$' : '-$'}${Math.abs(s.ev).toFixed(1)}`;
  const exits = `${s.tpHits.toString().padStart(3)} / ${s.slHits.toString().padStart(3)} / ${s.oppExits.toString().padStart(3)} / ${s.rthExits.toString().padStart(3)}`;
  const tpAvg = `${s.tpAvg.toFixed(1)}pt`;
  console.log(`│ ${pad(v.label, 48)} │ ${pad(String(s.n),3,true)} │ ${pad(String(s.w),3,true)} │ ${pad(String(s.l),3,true)} │ ${pad(wrStr,6,true)} │ ${pad(usdStr,9,true)} │ ${pad(evStr,8,true)} │ ${pad(tpAvg,8,true)} │ ${exits.padEnd(20)} │`);
  if (v.label.startsWith('STRUCT')) console.log(`│   ↳ ${s.n - s.structFallback}/${s.n} used structural TP; ${s.structFallback} fell back to 80${' '.repeat(80)} │`);
}
console.log(`└──────────────────────────────────────────────────┴─────┴─────┴─────┴────────┴───────────┴──────────┴──────────┴──────────────────────┘\n`);
