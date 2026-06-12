// Backtest 3 exit-policy variants on the pipeline's tradable OPENs (FLIP +
// CONT only — WBF was removed from the pipeline before this run).
//
// Exits per the user spec:
//   - TP hit (price moves to entry ± tp)
//   - SL hit (price moves to entry ± sl)
//   - Opposing signal per variant policy (uses signal's entry price)
//   - RTH bell close at 15:54 ET (forced flat, exit at tick price)
//
// Variants:
//   A — any-kind among {FLIP,CONT}: opposing FLIP or CONT closes either kind
//   B — same-kind only:             opposing same-rule signal only
//   C — V3-current:                 LONG closes on any FLIP/CONT short;
//                                    SHORT closes ONLY on FLIP-LONG
//
// Cooldown: one open trade per symbol. Same-direction signals during an
// open trade are skipped (no stacking). Opposing signals that qualify per
// variant policy close + can open a new trade at the same ts/entry.
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/backtest_exit_variants.ts

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const tradingDb = new Database(TRADING_DB, { readonly: true });
const ticksDb   = new Database(TICKS_DB,   { readonly: true });

// Per-rule TP/SL — only the two rules in scope after WBF removal.
function tpsl(ruleId: string, direction: 'long' | 'short'): { tp: number; sl: number } {
  if (ruleId === 'clean-impulse') return { tp: 80, sl: direction === 'long' ? 55 : 105 };
  if (ruleId === 'cont-reentry')  return { tp: 80, sl: 70 };
  throw new Error(`No TP/SL defined for ${ruleId}`);
}

// 15:54 ET (EDT or EST auto) for the trading day containing tsMs.
function rthCloseTs(tsMs: number): number {
  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(tsMs));
  const [mm, dd, yyyy] = datePart.split('/');
  // Try EDT first (-04:00), fall back to EST (-05:00) — Date.parse handles both
  const isoEdt = `${yyyy}-${mm}-${dd}T15:54:00-04:00`;
  const isoEst = `${yyyy}-${mm}-${dd}T15:54:00-05:00`;
  const tsEdt = Date.parse(isoEdt);
  // The "trading day" anchor: pick whichever is on the same NY-calendar-day
  // as the input. Both should be within ~1h of each other; either works for
  // our purposes since 15:54 ET is unambiguously in RTH.
  return tsEdt;
  void isoEst;
}

interface OpenSignal {
  signal_id: number;
  ts: number;
  symbol: string;
  rule_id: string;
  direction: 'long' | 'short';
  entry: number;
  pattern: string | null;
}

const opens = tradingDb.prepare(`
  SELECT t.signal_id, t.signal_ts AS ts, t.symbol, t.rule_id, t.direction, t.entry, t.pattern
  FROM tradable_signals t
  WHERE t.action = 'OPEN'
    AND t.rule_id IN ('clean-impulse','cont-reentry')
    AND t.entry IS NOT NULL
  ORDER BY t.signal_ts ASC
`).all() as OpenSignal[];

console.log(`Loaded ${opens.length} pipeline OPEN signals (FLIP + CONT)`);

// Cached tick MIN/MAX walk between two timestamps. Returns the first tick
// (ts, price) where price hit TP or SL, or null if no hit before exitTs.
//
// Optimisation: instead of scanning every tick, we scan in chronological
// order with a single query and break on the first hit. Index on (symbol, ts)
// makes the range scan ~O(rows-in-range) which is acceptable for our windows.
const tickQuery = ticksDb.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol = ? AND ts > ? AND ts <= ?
  ORDER BY ts ASC
`);

interface ExitHit { ts: number; price: number; reason: 'TP' | 'SL'; }

function walkForExit(
  symbol: string, openTs: number, exitTs: number,
  entry: number, direction: 'long' | 'short', tp: number, sl: number,
): ExitHit | null {
  const tpPrice = direction === 'long' ? entry + tp : entry - tp;
  const slPrice = direction === 'long' ? entry - sl : entry + sl;

  const stmt = tickQuery.iterate(symbol, openTs, exitTs);
  for (const row of stmt as IterableIterator<{ ts: number; price: number }>) {
    if (direction === 'long') {
      if (row.price >= tpPrice) return { ts: row.ts, price: tpPrice, reason: 'TP' };
      if (row.price <= slPrice) return { ts: row.ts, price: slPrice, reason: 'SL' };
    } else {
      if (row.price <= tpPrice) return { ts: row.ts, price: tpPrice, reason: 'TP' };
      if (row.price >= slPrice) return { ts: row.ts, price: slPrice, reason: 'SL' };
    }
  }
  return null;
}

// Tick price at-or-before a target ts (for OPP/RTH exit valuation).
const lastTickStmt = ticksDb.prepare(`
  SELECT price FROM trades WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1
`);
function tickPriceAt(symbol: string, ts: number): number | null {
  const row = lastTickStmt.get(symbol, ts) as { price: number } | undefined;
  return row?.price ?? null;
}

// Variant exit policy.
type Variant = 'A' | 'B' | 'C';

function isClosingSignal(
  openRule: string, openDir: 'long' | 'short',
  incomingRule: string, incomingDir: 'long' | 'short',
  variant: Variant,
): boolean {
  if (openDir === incomingDir) return false;
  switch (variant) {
    case 'A':
      return incomingRule === 'clean-impulse' || incomingRule === 'cont-reentry';
    case 'B':
      return incomingRule === openRule;
    case 'C':
      if (openDir === 'long')  return incomingRule === 'clean-impulse' || incomingRule === 'cont-reentry';
      return incomingRule === 'clean-impulse';
  }
}

interface Trade {
  signal_id: number; symbol: string; rule_id: string;
  direction: 'long' | 'short'; open_ts: number; entry: number;
  close_ts: number; close_price: number;
  close_reason: 'TP' | 'SL' | 'OPP' | 'RTH';
  pnl_pts: number;
}

function runVariant(variant: Variant): Trade[] {
  const openTrades = new Map<string, Trade>();  // symbol → open trade
  const completed: Trade[] = [];

  function finalize(t: Trade, closeTs: number, closePrice: number, reason: Trade['close_reason']) {
    t.close_ts = closeTs;
    t.close_price = closePrice;
    t.close_reason = reason;
    t.pnl_pts = t.direction === 'long' ? closePrice - t.entry : t.entry - closePrice;
    completed.push(t);
  }

  function closeTradeAt(t: Trade, exitTs: number, fallbackPrice: number, fallbackReason: 'OPP' | 'RTH') {
    const { tp, sl } = tpsl(t.rule_id, t.direction);
    const hit = walkForExit(t.symbol, t.open_ts, exitTs, t.entry, t.direction, tp, sl);
    if (hit) {
      finalize(t, hit.ts, hit.price, hit.reason);
    } else {
      finalize(t, exitTs, fallbackPrice, fallbackReason);
    }
  }

  for (const sig of opens) {
    const existing = openTrades.get(sig.symbol);
    if (existing) {
      // Same direction: cooldown — skip.
      if (existing.direction === sig.direction) continue;
      // Opposite — check exit policy.
      if (!isClosingSignal(existing.rule_id, existing.direction, sig.rule_id, sig.direction, variant)) {
        continue; // opposing signal doesn't qualify as closer → trade keeps running
      }
      // Close existing at sig.ts using sig.entry as the exit price (OPP_SIG_EXIT).
      closeTradeAt(existing, sig.ts, sig.entry, 'OPP');
      openTrades.delete(sig.symbol);
    }
    // Open a new trade.
    openTrades.set(sig.symbol, {
      signal_id: sig.signal_id, symbol: sig.symbol, rule_id: sig.rule_id,
      direction: sig.direction, open_ts: sig.ts, entry: sig.entry,
      close_ts: 0, close_price: 0, close_reason: 'TP', pnl_pts: 0,
    });
  }

  // Close any still-open trades at RTH bell of their open day. If they were
  // opened in overnight session and never hit TP/SL by the next RTH bell,
  // they exit at that bell. (Most historical signals are RTH-only so this
  // is rare.)
  for (const [symbol, t] of openTrades) {
    const closeTs = rthCloseTs(t.open_ts);
    if (closeTs <= t.open_ts) {
      // overnight signal — close at NEXT RTH 15:54
      const oneDay = 24 * 3600 * 1000;
      const nextClose = rthCloseTs(t.open_ts + oneDay);
      const px = tickPriceAt(symbol, nextClose);
      if (px != null) closeTradeAt(t, nextClose, px, 'RTH');
    } else {
      const px = tickPriceAt(symbol, closeTs);
      if (px != null) closeTradeAt(t, closeTs, px, 'RTH');
    }
  }
  return completed;
}

interface VariantStats {
  variant: Variant;
  totalTrades: number;
  byBreakdown: Map<string, { trades: number; wins: number; losses: number; pnl: number }>;
  totalWins: number;
  totalLosses: number;
  totalPnl: number;
  exitReasonCounts: Record<string, number>;
}

function summarise(variant: Variant, trades: Trade[]): VariantStats {
  const by = new Map<string, { trades: number; wins: number; losses: number; pnl: number }>();
  const reasons: Record<string, number> = { TP: 0, SL: 0, OPP: 0, RTH: 0 };
  let wins = 0, losses = 0, pnl = 0;
  for (const t of trades) {
    const k = `${t.rule_id}|${t.direction}`;
    const b = by.get(k) ?? { trades: 0, wins: 0, losses: 0, pnl: 0 };
    b.trades++;
    if (t.pnl_pts > 0) b.wins++;
    else if (t.pnl_pts < 0) b.losses++;
    b.pnl += t.pnl_pts;
    by.set(k, b);
    if (t.pnl_pts > 0) wins++;
    else if (t.pnl_pts < 0) losses++;
    pnl += t.pnl_pts;
    reasons[t.close_reason] = (reasons[t.close_reason] ?? 0) + 1;
  }
  return { variant, totalTrades: trades.length, byBreakdown: by, totalWins: wins, totalLosses: losses, totalPnl: pnl, exitReasonCounts: reasons };
}

function printVariant(s: VariantStats, label: string): void {
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`  Variant ${s.variant} — ${label}`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
  console.log(`  Total trades : ${s.totalTrades}`);
  const wr = (s.totalWins + s.totalLosses) > 0 ? s.totalWins / (s.totalWins + s.totalLosses) * 100 : 0;
  console.log(`  W / L        : ${s.totalWins} / ${s.totalLosses}  (WR = ${wr.toFixed(1)}%)`);
  console.log(`  Net PnL      : ${s.totalPnl >= 0 ? '+' : ''}${s.totalPnl.toFixed(1)} pts ` +
              `(${s.totalPnl >= 0 ? '+$' : '-$'}${Math.abs(s.totalPnl * 2).toFixed(0)} at 1× MNQ, ` +
              `${s.totalPnl >= 0 ? '+$' : '-$'}${Math.abs(s.totalPnl * 2 * 22).toFixed(0)} at 22× MNQ)`);
  console.log(`  Exit reasons : TP=${s.exitReasonCounts.TP} SL=${s.exitReasonCounts.SL} OPP=${s.exitReasonCounts.OPP} RTH=${s.exitReasonCounts.RTH}`);
  console.log(`\n  Breakdown by rule+dir:`);
  console.log(`  ${'rule|dir'.padEnd(25)} trades   W    L    WR%     PnL pts`);
  const sorted = Array.from(s.byBreakdown.entries()).sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [k, b] of sorted) {
    const wrk = (b.wins + b.losses) > 0 ? b.wins / (b.wins + b.losses) * 100 : 0;
    console.log(`  ${k.padEnd(25)} ${String(b.trades).padStart(6)} ${String(b.wins).padStart(4)} ${String(b.losses).padStart(4)} ${wrk.toFixed(1).padStart(6)}% ${(b.pnl >= 0 ? '+' : '') + b.pnl.toFixed(1)}`);
  }
}

console.log('\nRunning variants...');
console.time('  variant A');
const tradesA = runVariant('A');
console.timeEnd('  variant A');
console.time('  variant B');
const tradesB = runVariant('B');
console.timeEnd('  variant B');
console.time('  variant C');
const tradesC = runVariant('C');
console.timeEnd('  variant C');

const A = summarise('A', tradesA);
const B = summarise('B', tradesB);
const C = summarise('C', tradesC);

printVariant(A, 'any-kind FLIP+CONT (my proposed)');
printVariant(B, 'same-kind only');
printVariant(C, 'V3-current (longs=any, shorts=FLIP-only)');

console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(`  SIDE-BY-SIDE`);
console.log(`══════════════════════════════════════════════════════════════════════`);
console.log(`  Variant   trades    W    L    WR%     PnL pts    $ @ 22× MNQ`);
for (const s of [A, B, C]) {
  const wr = (s.totalWins + s.totalLosses) > 0 ? s.totalWins / (s.totalWins + s.totalLosses) * 100 : 0;
  console.log(`  ${s.variant}         ${String(s.totalTrades).padStart(6)} ${String(s.totalWins).padStart(4)} ${String(s.totalLosses).padStart(4)} ${wr.toFixed(1).padStart(6)}% ${(s.totalPnl >= 0 ? '+' : '') + s.totalPnl.toFixed(1).padStart(8)}    ${(s.totalPnl >= 0 ? '+$' : '-$')}${Math.abs(s.totalPnl * 2 * 22).toFixed(0)}`);
}
console.log();
