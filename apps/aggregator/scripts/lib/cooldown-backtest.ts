/**
 * cooldown-backtest.ts — generic cooldown-aware backtest engine.
 *
 * Trade model (applies to any signal type — absorption, FLIP, EXPL, etc.):
 *
 *   • An ENTRY signal opens a trade with a fixed TP and SL.
 *   • While the trade is open (cooldown active):
 *       - Same-direction same-rule signals are SKIPPED (no new trade, no exit).
 *       - Opposite-direction SAME-rule signal: CLOSES the trade at the
 *         signal's price, AND opens a NEW trade in the opposite direction.
 *       - Opposite-direction STRUCTURAL signal (e.g. FLIP/EXPL when entry
 *         rule is absorption): CLOSES the trade at the signal's price.
 *         Does NOT open a new trade.
 *       - Same-direction structural signal: IGNORED.
 *   • Resolution priority — earliest ts wins:
 *       - tick that crosses TP   → WIN  (+TP)
 *       - tick that crosses SL   → LOSS (-SL)
 *       - opposite same-rule sig → EXIT_OPP_ENTRY  (signed pnl @ signal's price)
 *       - opposite struct  sig   → EXIT_OPP_STRUCT (signed pnl @ signal's price)
 *       - RTH 16:00 ET           → CLOSE (signed pnl @ last RTH tick price)
 *
 * Usage:
 *   const results = runCooldownBacktest({
 *     symbol: 'NQ',
 *     entry: {
 *       ruleId: 'absorption',
 *       entryPriceFromRationale: /absorbed at (\d+\.?\d*)/,
 *     },
 *     structuralExits: [
 *       { ruleId: 'clean-impulse', pattern: 'FLIP' },
 *       { ruleId: 'expl' },
 *     ],
 *     entryFilter: 'qualified',   // or 'raw' or a custom predicate
 *     tp: 80, sl: 140,
 *     tradingDb: tdb, ticksDb: xdb,
 *   });
 */

import type Database from 'better-sqlite3';

export type Direction = 'long' | 'short';
export type Outcome = 'WIN' | 'LOSS' | 'EXIT_OPP_ENTRY' | 'EXIT_OPP_STRUCT' | 'CLOSE' | 'NO_DATA';

export interface SignalRow {
  id: number;
  ts: number;
  direction: Direction;
  ruleId: string;
  pattern?: string | null;
  score: number;
  entry: number | null;
  qualified: boolean;
  payload: any;
}

export interface RuleMatcher {
  ruleId: string;
  pattern?: string;
}

/** TP/SL in points. Either a single value applied to both sides, or
 *  per-direction values. */
export type PointsByDirection = number | { long: number; short: number };

export interface BacktestConfig {
  symbol: 'NQ' | 'ES';
  tradingDb: Database.Database;
  ticksDb: Database.Database;
  tp: PointsByDirection;
  sl: PointsByDirection;
  entry: RuleMatcher & {
    /** Optional regex on rationale text to recover entry price (for older payloads) */
    entryPriceFromRationale?: RegExp;
    /** Optional payload-property name from which to read entry price */
    entryField?: string;            // default '$.entry'
    /** If true, when no entry can be parsed from payload/rationale,
     *  use the first tick price at-or-after signal ts as the entry. */
    fallbackToTickPriceAtTs?: boolean;
  };
  /** Structural exit rules (opposite-direction firings close but DO NOT open new trade). */
  structuralExits: RuleMatcher[];
  /**
   * Which entries to consider. 'raw' = all matching signals.
   * 'qualified' = only those with a row in qualified_signals.
   * Or a custom predicate.
   */
  entryFilter?: 'raw' | 'qualified' | ((s: SignalRow) => boolean);
  /** RTH window in ET. Defaults to 09:30-16:00. Set null to disable (overnight included). */
  rthWindow?: { startEt: string; endEt: string } | null;
  /** Optional override of the floor ts (defaults to ticksDb min ts for the symbol). */
  tickFloor?: number;
}

export interface TradeRecord {
  sig: SignalRow;
  outcome: Outcome;
  pnl: number;
  exitTs: number;
  exitRuleId?: string;     // rule that triggered EXIT_OPP_* (for diagnostics)
  exitDirection?: Direction;
}

// ───────── helpers ─────────

const ET_OFFSET_MS = 4 * 60 * 60_000;

function rthCloseMs(tsMs: number, endEt: string = '16:00:00'): number {
  // 16:00 ET = 20:00 UTC (DST assumed; adjust if you ever backtest pre-DST).
  const d = new Date(tsMs - ET_OFFSET_MS);
  const [h, m, s] = endEt.split(':').map(Number);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h + 4, m ?? 0, s ?? 0, 0);
}

function ruleMatches(row: { ruleId: string; pattern?: string | null }, m: RuleMatcher): boolean {
  if (row.ruleId !== m.ruleId) return false;
  if (m.pattern && row.pattern !== m.pattern) return false;
  return true;
}

// ───────── core ─────────

function pointsFor(v: PointsByDirection, dir: Direction): number {
  return typeof v === 'number' ? v : v[dir];
}

export function runCooldownBacktest(cfg: BacktestConfig): TradeRecord[] {
  const { tradingDb: tdb, ticksDb: xdb, symbol, tp, sl, entry, structuralExits } = cfg;
  const rthWindow = cfg.rthWindow === undefined
    ? { startEt: '09:30:00', endEt: '16:00:00' }
    : cfg.rthWindow;
  const tickFloor = cfg.tickFloor ??
    (xdb.prepare(`SELECT MIN(ts) AS t FROM trades WHERE symbol=?`).get(symbol) as {t:number}).t;
  const entryField = entry.entryField ?? '$.entry';

  // Build rule list for the SQL signal load: entry rule + structural exits.
  const allMatchers: RuleMatcher[] = [{ ruleId: entry.ruleId, pattern: entry.pattern }, ...structuralExits];

  // Construct WHERE for rule_id+pattern OR's
  const ruleOrs = allMatchers.map(m =>
    m.pattern
      ? `(s.rule_id = '${m.ruleId}' AND json_extract(s.payload,'$.pattern') = '${m.pattern}')`
      : `s.rule_id = '${m.ruleId}'`
  ).join(' OR ');

  const rthClause = rthWindow
    ? `AND time(s.ts/1000,'unixepoch','-4 hours') >= '${rthWindow.startEt}'
       AND time(s.ts/1000,'unixepoch','-4 hours') <  '${rthWindow.endEt}'`
    : '';

  const sql = `
    SELECT s.id, s.ts, s.direction, s.rule_id AS ruleId, s.score,
           json_extract(s.payload,'$.pattern') AS pattern,
           CAST(json_extract(s.payload,'${entryField.replace(/'/g, "''")}') AS REAL) AS entry,
           CASE WHEN q.signal_id IS NULL THEN 0 ELSE 1 END AS qualified,
           s.payload AS payloadRaw
    FROM signals s
    LEFT JOIN qualified_signals q ON q.signal_id = s.id
    WHERE s.symbol = ? AND s.ts >= ?
      ${rthClause}
      AND (${ruleOrs})
    ORDER BY s.ts ASC
  `;
  const rows = tdb.prepare(sql).all(symbol, tickFloor) as any[];

  const stmtPriceAtOrAfter = xdb.prepare(`
    SELECT price FROM trades
    WHERE symbol=? AND ts >= ? ORDER BY ts ASC LIMIT 1
  `);

  const all: SignalRow[] = rows.map(r => {
    let entryPx: number | null = (r.entry !== null && !isNaN(r.entry)) ? r.entry : null;
    if ((!entryPx || entryPx <= 0) && entry.entryPriceFromRationale) {
      try {
        const p = typeof r.payloadRaw === 'string' ? JSON.parse(r.payloadRaw) : r.payloadRaw;
        const rationale = (p && p.rationale) || '';
        const m = rationale.match(entry.entryPriceFromRationale);
        if (m) entryPx = parseFloat(m[1]);
      } catch { /* ignore */ }
    }
    // Only fall back to tick-price for signals that match the ENTRY rule (not structural exits).
    // Structural exits use ts only; we don't need their entry price.
    const isEntryRule = ruleMatches({ ruleId: r.ruleId, pattern: r.pattern ?? null }, entry);
    if (isEntryRule && (!entryPx || entryPx <= 0) && entry.fallbackToTickPriceAtTs) {
      const row = stmtPriceAtOrAfter.get(symbol, r.ts) as {price:number}|undefined;
      if (row?.price) entryPx = row.price;
    }
    return {
      id: r.id, ts: r.ts, direction: r.direction as Direction,
      ruleId: r.ruleId, pattern: r.pattern ?? null,
      score: r.score, entry: entryPx, qualified: !!r.qualified, payload: r.payloadRaw,
    };
  });

  // Entry signals (matching entry rule + filter), structural exits, and same-rule
  // opposite-direction signals (used as both exit + new-trade source).
  const entryRuleSigs = all.filter(s => ruleMatches(s, entry));
  const structSigs    = all.filter(s => structuralExits.some(m => ruleMatches(s, m)));

  const entryFilter = cfg.entryFilter;
  const predicate: (s: SignalRow) => boolean =
    entryFilter === 'qualified' ? (s => s.qualified)
  : entryFilter === 'raw'       ? (() => true)
  : (entryFilter ?? (() => true));

  const candidateEntries = entryRuleSigs.filter(s => s.entry && s.entry > 0 && predicate(s));

  const stmtTrades = xdb.prepare(`
    SELECT ts, price FROM trades
    WHERE symbol=? AND ts > ? AND ts <= ?
    ORDER BY ts ASC, id ASC
  `).raw(true);
  const stmtPriceAt = xdb.prepare(`
    SELECT price FROM trades
    WHERE symbol=? AND ts <= ? ORDER BY ts DESC LIMIT 1
  `);

  function nextOppositeSameRule(after: number, oppDir: Direction, excludeId: number): SignalRow | null {
    for (const s of entryRuleSigs) {
      if (s.ts <= after) continue;
      if (s.id === excludeId) continue;
      if (s.direction === oppDir) return s;
    }
    return null;
  }
  function nextOppositeStructural(after: number, oppDir: Direction): SignalRow | null {
    for (const s of structSigs) {
      if (s.ts <= after) continue;
      if (s.direction === oppDir) return s;
    }
    return null;
  }

  const results: TradeRecord[] = [];
  let blockUntil = 0;

  for (const s of candidateEntries) {
    if (s.ts < blockUntil) continue;

    const oppDir = s.direction === 'long' ? 'short' : 'long';
    const closeMs = rthWindow
      ? rthCloseMs(s.ts, rthWindow.endEt)
      : Number.MAX_SAFE_INTEGER;

    const oppEntry  = nextOppositeSameRule(s.ts, oppDir, s.id);
    const oppStruct = nextOppositeStructural(s.ts, oppDir);
    const oppEntryTs  = (oppEntry  && oppEntry.ts  <= closeMs) ? oppEntry.ts  : Infinity;
    const oppStructTs = (oppStruct && oppStruct.ts <= closeMs) ? oppStruct.ts : Infinity;
    const earliestEventTs = Math.min(oppEntryTs, oppStructTs);

    let outcome: Outcome = 'NO_DATA';
    let pnl = 0, exitTs = s.ts, lastPx = NaN, saw = false;
    let exitRuleId: string | undefined;
    let exitDirection: Direction | undefined;

    const iter = stmtTrades.iterate(symbol, s.ts, closeMs) as IterableIterator<[number, number]>;
    for (const [ts, px] of iter) {
      saw = true; lastPx = px;

      if (earliestEventTs <= ts) {
        const exitPxRow = stmtPriceAt.get(symbol, earliestEventTs) as {price:number}|undefined;
        const exitPx = exitPxRow?.price ?? lastPx;
        pnl = s.direction === 'long' ? exitPx - s.entry! : s.entry! - exitPx;
        exitTs = earliestEventTs;
        if (earliestEventTs === oppEntryTs) {
          outcome = 'EXIT_OPP_ENTRY';
          exitRuleId = oppEntry!.ruleId;
          exitDirection = oppEntry!.direction;
        } else {
          outcome = 'EXIT_OPP_STRUCT';
          exitRuleId = oppStruct!.ruleId;
          exitDirection = oppStruct!.direction;
        }
        if ((iter as any).return) (iter as any).return();
        break;
      }

      const tpDir = pointsFor(tp, s.direction);
      const slDir = pointsFor(sl, s.direction);
      const fav = s.direction === 'long' ? px - s.entry! : s.entry! - px;
      const adv = s.direction === 'long' ? s.entry! - px : px - s.entry!;
      if (adv >= slDir) { outcome='LOSS'; pnl=-slDir; exitTs=ts; if((iter as any).return)(iter as any).return(); break; }
      if (fav >= tpDir) { outcome='WIN';  pnl= tpDir; exitTs=ts; if((iter as any).return)(iter as any).return(); break; }
    }

    if (outcome === 'NO_DATA') {
      if (!saw) {
        results.push({ sig: s, outcome: 'NO_DATA', pnl: 0, exitTs: s.ts });
        continue;
      }
      outcome = 'CLOSE';
      pnl = s.direction === 'long' ? lastPx - s.entry! : s.entry! - lastPx;
      exitTs = closeMs;
    }

    results.push({ sig: s, outcome, pnl, exitTs, exitRuleId, exitDirection });
    blockUntil = exitTs;
  }

  return results;
}

// ───────── combined multi-rule engine ─────────

/** Per-rule specification used by the combined engine. */
export interface RuleSpec {
  ruleId: string;
  pattern?: string;
  tp: PointsByDirection;
  sl: PointsByDirection;
  entryPriceFromRationale?: RegExp;
  entryField?: string;
  fallbackToTickPriceAtTs?: boolean;
  /** Optional display label (used by reports). Defaults to "ruleId[/pattern]". */
  label?: string;
}

export interface CombinedConfig {
  symbol: 'NQ' | 'ES';
  tradingDb: Database.Database;
  ticksDb: Database.Database;
  /** Rules in this list share a SINGLE cooldown. Any opposite-direction signal
   *  from any of them closes the current trade AND can open the next trade. */
  rules: RuleSpec[];
  entryFilter?: 'raw' | 'qualified' | ((s: SignalRow) => boolean);
  /** If true, only QUALIFIED opposite-direction signals can trigger an exit.
   *  Silenced opposite signals are ignored (trade continues toward TP/SL/CLOSE).
   *  Can be per-direction: { long: true, short: false } applies to trades by
   *  the trade's own direction. Defaults to false (any opposite signal exits). */
  requireQualifiedExits?: boolean | { long: boolean; short: boolean };
  rthWindow?: { startEt: string; endEt: string } | null;
  tickFloor?: number;
}

interface SignalRowWithSpec extends SignalRow {
  spec: RuleSpec;
}

export function runCombinedCooldownBacktest(cfg: CombinedConfig): TradeRecord[] {
  const { tradingDb: tdb, ticksDb: xdb, symbol } = cfg;
  const rthWindow = cfg.rthWindow === undefined
    ? { startEt: '09:30:00', endEt: '16:00:00' }
    : cfg.rthWindow;
  const tickFloor = cfg.tickFloor ??
    (xdb.prepare(`SELECT MIN(ts) AS t FROM trades WHERE symbol=?`).get(symbol) as {t:number}).t;

  // Build a SQL WHERE that matches any of the rules.
  const ruleOrs = cfg.rules.map(r =>
    r.pattern
      ? `(s.rule_id='${r.ruleId}' AND json_extract(s.payload,'$.pattern')='${r.pattern}')`
      : `s.rule_id='${r.ruleId}'`
  ).join(' OR ');
  const rthClause = rthWindow
    ? `AND time(s.ts/1000,'unixepoch','-4 hours') >= '${rthWindow.startEt}'
       AND time(s.ts/1000,'unixepoch','-4 hours') <  '${rthWindow.endEt}'`
    : '';

  const sql = `
    SELECT s.id, s.ts, s.direction, s.rule_id AS ruleId, s.score,
           json_extract(s.payload,'$.pattern') AS pattern,
           CAST(json_extract(s.payload,'$.entry') AS REAL) AS entry,
           CASE WHEN q.signal_id IS NULL THEN 0 ELSE 1 END AS qualified,
           s.payload AS payloadRaw
    FROM signals s
    LEFT JOIN qualified_signals q ON q.signal_id = s.id
    WHERE s.symbol=? AND s.ts >= ?
      ${rthClause}
      AND (${ruleOrs})
    ORDER BY s.ts ASC
  `;
  const rawRows = tdb.prepare(sql).all(symbol, tickFloor) as any[];

  const stmtPriceAtOrAfter = xdb.prepare(`
    SELECT price FROM trades WHERE symbol=? AND ts >= ? ORDER BY ts ASC LIMIT 1
  `);

  // For each loaded row, resolve which RuleSpec it matches (first match wins) and the entry price.
  const all: SignalRowWithSpec[] = [];
  for (const r of rawRows) {
    const spec = cfg.rules.find(rs =>
      rs.ruleId === r.ruleId && (!rs.pattern || rs.pattern === r.pattern)
    );
    if (!spec) continue;
    let entryPx: number | null = (r.entry !== null && !isNaN(r.entry)) ? r.entry : null;
    if ((!entryPx || entryPx <= 0) && spec.entryPriceFromRationale) {
      try {
        const p = typeof r.payloadRaw === 'string' ? JSON.parse(r.payloadRaw) : r.payloadRaw;
        const rationale = (p && p.rationale) || '';
        const m = rationale.match(spec.entryPriceFromRationale);
        if (m) entryPx = parseFloat(m[1]);
      } catch { /* ignore */ }
    }
    if ((!entryPx || entryPx <= 0) && spec.fallbackToTickPriceAtTs) {
      const row = stmtPriceAtOrAfter.get(symbol, r.ts) as {price:number}|undefined;
      if (row?.price) entryPx = row.price;
    }
    all.push({
      id: r.id, ts: r.ts, direction: r.direction as Direction,
      ruleId: r.ruleId, pattern: r.pattern ?? null, score: r.score,
      entry: entryPx, qualified: !!r.qualified, payload: r.payloadRaw, spec,
    });
  }

  // Entries: signals with a valid entry price that pass the entry filter.
  const entryFilter = cfg.entryFilter;
  const predicate: (s: SignalRow) => boolean =
    entryFilter === 'qualified' ? (s => s.qualified)
  : entryFilter === 'raw'       ? (() => true)
  : (entryFilter ?? (() => true));
  const candidates = all.filter(s => s.entry && s.entry > 0 && predicate(s));

  const stmtTrades = xdb.prepare(`
    SELECT ts, price FROM trades
    WHERE symbol=? AND ts > ? AND ts <= ?
    ORDER BY ts ASC, id ASC
  `).raw(true);
  const stmtPriceAt = xdb.prepare(`
    SELECT price FROM trades WHERE symbol=? AND ts <= ? ORDER BY ts DESC LIMIT 1
  `);

  // For exit-event lookup. requireQualifiedExits can be:
  //   - boolean: applied uniformly
  //   - per-direction: applies to the TRADE's direction (LONG trades use .long; SHORT trades use .short)
  function shouldRequireQualifiedExitsFor(tradeDir: Direction): boolean {
    const v = cfg.requireQualifiedExits;
    if (v === undefined) return false;
    if (typeof v === 'boolean') return v;
    return v[tradeDir];
  }
  function nextOppositeAny(after: number, oppDir: Direction, excludeId: number, requireQ: boolean): SignalRowWithSpec | null {
    for (const s of all) {
      if (s.ts <= after) continue;
      if (s.id === excludeId) continue;
      if (s.direction !== oppDir) continue;
      if (requireQ && !s.qualified) continue;
      return s;
    }
    return null;
  }

  const results: TradeRecord[] = [];
  let blockUntil = 0;
  for (const s of candidates) {
    if (s.ts < blockUntil) continue;
    const tpDir = pointsFor(s.spec.tp, s.direction);
    const slDir = pointsFor(s.spec.sl, s.direction);
    const oppDir: Direction = s.direction === 'long' ? 'short' : 'long';
    const closeMs = rthWindow ? rthCloseMs(s.ts, rthWindow.endEt) : Number.MAX_SAFE_INTEGER;

    const requireQForThis = shouldRequireQualifiedExitsFor(s.direction);
    const oppEvent = nextOppositeAny(s.ts, oppDir, s.id, requireQForThis);
    const oppEventTs = (oppEvent && oppEvent.ts <= closeMs) ? oppEvent.ts : Infinity;

    let outcome: Outcome = 'NO_DATA';
    let pnl = 0, exitTs = s.ts, lastPx = NaN, saw = false;
    let exitRuleId: string | undefined;
    let exitDirection: Direction | undefined;

    const iter = stmtTrades.iterate(symbol, s.ts, closeMs) as IterableIterator<[number, number]>;
    for (const [ts, px] of iter) {
      saw = true; lastPx = px;
      if (oppEventTs <= ts) {
        const row = stmtPriceAt.get(symbol, oppEventTs) as {price:number}|undefined;
        const exitPx = row?.price ?? lastPx;
        pnl = s.direction === 'long' ? exitPx - s.entry! : s.entry! - exitPx;
        exitTs = oppEventTs;
        // In combined mode, we don't distinguish "same-rule" vs "structural" — all are exits.
        // Tag as EXIT_OPP_ENTRY if the opposite signal's rule is in our rule list
        // (always true here since we loaded only those rules).
        outcome = oppEvent && oppEvent.spec.ruleId === s.ruleId
                ? 'EXIT_OPP_ENTRY'
                : 'EXIT_OPP_STRUCT';
        exitRuleId = oppEvent!.ruleId;
        exitDirection = oppEvent!.direction;
        if ((iter as any).return) (iter as any).return();
        break;
      }
      const fav = s.direction === 'long' ? px - s.entry! : s.entry! - px;
      const adv = s.direction === 'long' ? s.entry! - px : px - s.entry!;
      if (adv >= slDir) { outcome='LOSS'; pnl=-slDir; exitTs=ts; if((iter as any).return)(iter as any).return(); break; }
      if (fav >= tpDir) { outcome='WIN';  pnl= tpDir; exitTs=ts; if((iter as any).return)(iter as any).return(); break; }
    }
    if (outcome === 'NO_DATA') {
      if (!saw) {
        results.push({ sig: s, outcome: 'NO_DATA', pnl: 0, exitTs: s.ts });
        continue;
      }
      outcome = 'CLOSE';
      pnl = s.direction === 'long' ? lastPx - s.entry! : s.entry! - lastPx;
      exitTs = closeMs;
    }
    results.push({ sig: s, outcome, pnl, exitTs, exitRuleId, exitDirection });
    blockUntil = exitTs;
  }
  return results;
}

// ───────── pretty-printer ─────────

export function summarize(label: string, rs: TradeRecord[], opts?: { tp?: PointsByDirection; sl?: PointsByDirection }): void {
  const tpLbl = opts?.tp == null ? '?' : (typeof opts.tp === 'number' ? `${opts.tp}` : `L=${opts.tp.long}/S=${opts.tp.short}`);
  const slLbl = opts?.sl == null ? '?' : (typeof opts.sl === 'number' ? `${opts.sl}` : `L=${opts.sl.long}/S=${opts.sl.short}`);
  const usable = rs.filter(r => r.outcome !== 'NO_DATA');
  const net = usable.reduce((a, r) => a + r.pnl, 0);
  const prof = usable.filter(r => r.pnl > 0).length;

  function bucket(name: Outcome) {
    const arr = usable.filter(r => r.outcome === name);
    const n = arr.length;
    const sum = arr.reduce((a, r) => a + r.pnl, 0);
    const wins = arr.filter(r => r.pnl > 0).length;
    const losses = arr.filter(r => r.pnl < 0).length;
    const breakeven = arr.filter(r => r.pnl === 0).length;
    const avg = n ? sum / n : 0;
    return { n, sum, avg, wins, losses, breakeven };
  }

  const W   = bucket('WIN');
  const L   = bucket('LOSS');
  const EOE = bucket('EXIT_OPP_ENTRY');
  const EOS = bucket('EXIT_OPP_STRUCT');
  const CL  = bucket('CLOSE');

  console.log(`\n=== ${label} (trades=${usable.length}, no-data=${rs.length - usable.length})  [TP=${tpLbl}, SL=${slLbl}] ===`);
  console.log(`  bucket            n     sum_pts    avg_pts    +/0/-`);
  console.log(`  WIN  (TP hit):    ${String(W.n).padStart(3)}   ${String(W.sum.toFixed(0)).padStart(7)}    ${W.avg.toFixed(1).padStart(6)}    ${W.wins}/${W.breakeven}/${W.losses}`);
  console.log(`  LOSS (SL hit):    ${String(L.n).padStart(3)}   ${String(L.sum.toFixed(0)).padStart(7)}    ${L.avg.toFixed(1).padStart(6)}    ${L.wins}/${L.breakeven}/${L.losses}`);
  console.log(`  EXIT_OPP_ENTRY:   ${String(EOE.n).padStart(3)}   ${String(EOE.sum.toFixed(0)).padStart(7)}    ${EOE.avg.toFixed(1).padStart(6)}    ${EOE.wins}/${EOE.breakeven}/${EOE.losses}`);
  console.log(`  EXIT_OPP_STRUCT:  ${String(EOS.n).padStart(3)}   ${String(EOS.sum.toFixed(0)).padStart(7)}    ${EOS.avg.toFixed(1).padStart(6)}    ${EOS.wins}/${EOS.breakeven}/${EOS.losses}`);
  console.log(`  CLOSE @bell:      ${String(CL.n).padStart(3)}   ${String(CL.sum.toFixed(0)).padStart(7)}    ${CL.avg.toFixed(1).padStart(6)}    ${CL.wins}/${CL.breakeven}/${CL.losses}`);
  console.log(`  Net PnL: ${net.toFixed(0)}pt   Profitable: ${prof}/${usable.length} = ${(prof/usable.length*100).toFixed(1)}%   PnL/trade: ${(net/usable.length).toFixed(1)}pt`);

  function lineFor(lbl: string, rows: TradeRecord[]) {
    if (rows.length === 0) { console.log(`    ${lbl}: (none)`); return; }
    const w = rows.filter(r => r.outcome === 'WIN').length;
    const l = rows.filter(r => r.outcome === 'LOSS').length;
    const p = rows.filter(r => r.pnl > 0).length;
    const n = rows.reduce((a, r) => a + r.pnl, 0);
    console.log(`    ${lbl.padEnd(10)} n=${String(rows.length).padStart(3)}  W=${String(w).padStart(2)} L=${String(l).padStart(2)}  Prof=${p}/${rows.length}=${(p/rows.length*100).toFixed(0)}%  Net=${String(n.toFixed(0)).padStart(6)}pt  PnL/trade=${(n/rows.length).toFixed(1)}pt`);
  }
  lineFor('LONG',  usable.filter(r => r.sig.direction === 'long'));
  lineFor('SHORT', usable.filter(r => r.sig.direction === 'short'));

  // Per-rule breakdown (only useful when multiple rules are in the result set).
  const rulesPresent = new Set(usable.map(r => `${r.sig.ruleId}${r.sig.pattern ? '/'+r.sig.pattern : ''}`));
  if (rulesPresent.size > 1) {
    console.log(`  ---- by rule ----`);
    for (const rk of [...rulesPresent].sort()) {
      const [rid, pat] = rk.split('/');
      const subset = usable.filter(r => r.sig.ruleId === rid && (pat ? r.sig.pattern === pat : true));
      lineFor(rk + ' LONG',  subset.filter(r => r.sig.direction === 'long'));
      lineFor(rk + ' SHORT', subset.filter(r => r.sig.direction === 'short'));
    }
  }

  let cur=0, best=0;
  for (const r of usable) {
    const losing = r.outcome === 'LOSS' || r.pnl < 0;
    if (losing) { cur++; if (cur>best) best = cur; } else cur = 0;
  }
  let curS=0, bestS=0;
  for (const r of usable) {
    if (r.outcome === 'LOSS') { curS++; if (curS>bestS) bestS = curS; } else curS = 0;
  }
  console.log(`  Max consec losing trades: ${best}    Max consec SL stops: ${bestS}`);
}
