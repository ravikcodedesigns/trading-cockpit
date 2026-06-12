// Compares 4 configurations over the full Variant A history:
//   1. clean-impulse only,                    no cap
//   2. clean-impulse only,                    $500 daily cap
//   3. clean-impulse + cont-reentry,          no cap
//   4. clean-impulse + cont-reentry,          $500 daily cap
//
// Logic = tick-accurate (TP/SL checked on every tick, not deferred until next
// opposite signal). Per-day RTH 15:54 ET close between days. MNQ = $2/pt.
//
// Daily cap: when a new signal arrives, if the day's running CLOSED P&L is
// already <= -$500, that signal is dropped (would not be taken by risk-guard).
// In-flight trades (already open) are NOT closed by the cap — matches
// risk-guard.ts:132 behavior (the cap blocks NEW entries only).

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb   = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const DOLLAR_PER_PT = 2;
const DAILY_CAP_USD = -500;

function tpsl(ruleId: string, direction: 'long' | 'short'): { tp: number; sl: number } {
  if (ruleId === 'clean-impulse') return { tp: 80, sl: direction === 'long' ? 55 : 105 };
  if (ruleId === 'cont-reentry')  return { tp: 80, sl: 70 };
  throw new Error(`No TP/SL for ${ruleId}`);
}
const fmtEtDate = (tsMs: number) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = p.split('/');
  return `${yyyy}-${mm}-${dd}`;
};
const rthCloseTs = (tsMs: number): number => Date.parse(`${fmtEtDate(tsMs)}T15:54:00-04:00`);

interface OpenSig { ts: number; symbol: string; rule_id: string; direction: 'long'|'short'; entry: number; }
const allSigsAll = tradingDb.prepare(`
  SELECT signal_ts AS ts, symbol, rule_id, direction, entry
  FROM tradable_signals
  WHERE action='OPEN' AND rule_id IN ('clean-impulse','cont-reentry') AND entry IS NOT NULL
  ORDER BY signal_ts ASC
`).all() as OpenSig[];

const tickQuery = ticksDb.prepare('SELECT ts, price FROM trades WHERE symbol = ? AND ts > ? AND ts <= ? ORDER BY ts ASC');
function walkForExit(symbol: string, openTs: number, exitTs: number, entry: number, dir: 'long'|'short', tp: number, sl: number) {
  const tpPx = dir === 'long' ? entry + tp : entry - tp;
  const slPx = dir === 'long' ? entry - sl : entry + sl;
  for (const r of tickQuery.iterate(symbol, openTs, exitTs) as IterableIterator<{ts:number; price:number}>) {
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
const lastTickStmt = ticksDb.prepare('SELECT price FROM trades WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1');

interface Trade {
  symbol: string; rule_id: string; direction: 'long'|'short';
  open_ts: number; entry: number; et_date: string;
  close_ts: number; close_price: number; close_reason: 'TP'|'SL'|'OPP'|'RTH';
  pnl_pts: number; running_before_pts: number;
}

function runScenario(enabledRules: Set<string>, applyCap: boolean): Trade[] {
  const sigs = allSigsAll.filter(s => enabledRules.has(s.rule_id));
  const completed: Trade[] = [];
  const open = new Map<string, Trade>();
  const dayRunningPts = new Map<string, number>();
  let prevDate: string | null = null;

  const credit = (t: Trade, ts: number, px: number, reason: Trade['close_reason']) => {
    t.close_ts = ts; t.close_price = px; t.close_reason = reason;
    t.pnl_pts = t.direction === 'long' ? px - t.entry : t.entry - px;
    completed.push(t);
    dayRunningPts.set(t.et_date, (dayRunningPts.get(t.et_date) ?? 0) + t.pnl_pts);
  };
  const closeByTick = (sym: string, untilTs: number) => {
    const t = open.get(sym); if (!t) return;
    const { tp, sl } = tpsl(t.rule_id, t.direction);
    const h = walkForExit(sym, t.open_ts, untilTs, t.entry, t.direction, tp, sl);
    if (h) { credit(t, h.ts, h.price, h.reason); open.delete(sym); }
  };
  const closeAllAtRth = (rthTs: number) => {
    for (const sym of [...open.keys()]) {
      closeByTick(sym, rthTs);
      if (!open.has(sym)) continue;
      const t = open.get(sym)!;
      const r = lastTickStmt.get(sym, rthTs) as { price: number } | undefined;
      credit(t, rthTs, r?.price ?? t.entry, 'RTH');
      open.delete(sym);
    }
  };

  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i]!;
    const etDate = fmtEtDate(s.ts);

    if (prevDate && etDate !== prevDate) {
      closeAllAtRth(rthCloseTs(sigs[i - 1]!.ts));
    }
    prevDate = etDate;

    closeByTick(s.symbol, s.ts);

    // Apply cap: drop new entries if running daily P&L (in $) ≤ cap.
    const runningDol = (dayRunningPts.get(etDate) ?? 0) * DOLLAR_PER_PT;
    if (applyCap && runningDol <= DAILY_CAP_USD) {
      // Cap is active. Don't open. Don't OPP-close either (in-flight trade
      // continues per risk-guard semantics — cap blocks ENTRIES only).
      continue;
    }

    const ex = open.get(s.symbol);
    if (ex) {
      if (ex.direction === s.direction) continue;
      credit(ex, s.ts, s.entry, 'OPP');
      open.delete(s.symbol);
    }
    open.set(s.symbol, {
      symbol: s.symbol, rule_id: s.rule_id, direction: s.direction,
      open_ts: s.ts, entry: s.entry, et_date: etDate,
      close_ts: 0, close_price: 0, close_reason: 'TP', pnl_pts: 0,
      running_before_pts: dayRunningPts.get(etDate) ?? 0,
    });
  }
  if (prevDate) closeAllAtRth(rthCloseTs(sigs[sigs.length - 1]!.ts));
  return completed;
}

function summary(name: string, trades: Trade[]) {
  const n = trades.length;
  const w = trades.filter(t => t.pnl_pts > 0).length;
  const l = trades.filter(t => t.pnl_pts < 0).length;
  const totPts = trades.reduce((a, t) => a + t.pnl_pts, 0);
  const totDol = totPts * DOLLAR_PER_PT;
  const days = new Set(trades.map(t => t.et_date)).size;
  const wr = (w + l) ? ((w / (w + l)) * 100).toFixed(1) + '%' : '—';
  return {
    name,
    n, w, l, wr,
    totPts: totPts.toFixed(1),
    totDol,
    avg: n ? (totDol / n).toFixed(1) : '0',
    days,
    perDay: days ? (totDol / days).toFixed(1) : '0',
    trades,
  };
}

const flipOnly        = runScenario(new Set(['clean-impulse']),                 false);
const flipOnlyCap     = runScenario(new Set(['clean-impulse']),                 true);
const flipPlusCont    = runScenario(new Set(['clean-impulse', 'cont-reentry']), false);
const flipPlusContCap = runScenario(new Set(['clean-impulse', 'cont-reentry']), true);

const rows = [
  summary('FLIP only,         no cap', flipOnly),
  summary('FLIP only,        $500 cap', flipOnlyCap),
  summary('FLIP + CONT,       no cap', flipPlusCont),
  summary('FLIP + CONT,      $500 cap', flipPlusContCap),
];

console.log('\n════════════════════════════════════════════════════════════════════════════');
console.log('Variant A — 4-scenario comparison (tick-accurate, MNQ $2/pt, per-day RTH close)');
console.log('════════════════════════════════════════════════════════════════════════════');
console.log('Configuration                │  n  │  W   │  L   │   WR   │ TotPnL($) │ Avg/trade │ Days │ $/day');
console.log('─────────────────────────────┼─────┼──────┼──────┼────────┼───────────┼───────────┼──────┼──────');
for (const r of rows) {
  console.log(`${r.name.padEnd(28)} │ ${String(r.n).padStart(3)} │ ${String(r.w).padStart(4)} │ ${String(r.l).padStart(4)} │ ${r.wr.padStart(6)} │  ${('$' + r.totDol.toFixed(0)).padStart(8)} │  ${('$' + r.avg).padStart(8)} │ ${String(r.days).padStart(4)} │ ${('$' + r.perDay).padStart(5)}`);
}
console.log('════════════════════════════════════════════════════════════════════════════');

// Per-day P&L for the 4 scenarios, to see how the cap distorts each day.
console.log('\n──────── Per-day P&L ($) ────────');
const allDays = new Set<string>();
for (const r of rows) for (const t of r.trades) allDays.add(t.et_date);
const sortedDays = [...allDays].sort();
const dayPnl = (rs: ReturnType<typeof summary>) => {
  const m = new Map<string, number>();
  for (const t of rs.trades) m.set(t.et_date, (m.get(t.et_date) ?? 0) + t.pnl_pts * DOLLAR_PER_PT);
  return m;
};
const dpA = dayPnl(rows[0]!), dpB = dayPnl(rows[1]!), dpC = dayPnl(rows[2]!), dpD = dayPnl(rows[3]!);
console.log('Date         │ FLIP only │ FLIP+cap │ FLIP+CONT │ +CONT+cap │ Δ (cap cost) FLIP only │ Δ +CONT');
console.log('─────────────┼───────────┼──────────┼───────────┼───────────┼────────────────────────┼─────────');
for (const d of sortedDays) {
  const a = dpA.get(d) ?? 0;
  const b = dpB.get(d) ?? 0;
  const c = dpC.get(d) ?? 0;
  const e = dpD.get(d) ?? 0;
  const capCostFlip = a - b; // positive = cap cost you $
  const capCostFlipCont = c - e;
  if (capCostFlip === 0 && capCostFlipCont === 0 && a === 0 && c === 0) continue;
  console.log(`${d}   │  ${('$'+a.toFixed(0)).padStart(7)} │ ${('$'+b.toFixed(0)).padStart(7)} │  ${('$'+c.toFixed(0)).padStart(7)} │  ${('$'+e.toFixed(0)).padStart(7)} │ ${capCostFlip!==0?('$'+capCostFlip.toFixed(0)).padStart(20):'                    —'} │ ${capCostFlipCont!==0?('$'+capCostFlipCont.toFixed(0)).padStart(7):'      —'}`);
}

// Total cap costs
const capCostA = (rows[0]!.totDol) - (rows[1]!.totDol);
const capCostC = (rows[2]!.totDol) - (rows[3]!.totDol);
const contLift = (rows[2]!.totDol) - (rows[0]!.totDol);
const contLiftCap = (rows[3]!.totDol) - (rows[1]!.totDol);
console.log('\n──────── Headline numbers ────────');
console.log(`$500 cap cost — FLIP only:         $${capCostA.toFixed(0)} (over ${rows[0]!.days} trading days)`);
console.log(`$500 cap cost — FLIP + CONT:       $${capCostC.toFixed(0)}`);
console.log(`Adding CONT — no cap:              +$${contLift.toFixed(0)}`);
console.log(`Adding CONT — with $500 cap:       +$${contLiftCap.toFixed(0)}`);
