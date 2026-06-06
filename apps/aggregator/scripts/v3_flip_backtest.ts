// Retroactive V3 backtest on ALL clean-impulse FLIP signals from inception.
//
// Replays the V3 decision pipeline against each historical FLIP signal under
// the CURRENT V3 config (cvdLongFloor=-3000, cvdShortFloor=+3000,
// dropFlipShorts=false, closeShortsOnlyOnFlipLong=true, requireQualifiedExitsLongs=true).
//
// Sequence of gates for each FLIP signal:
//   1. SKIP_SYMBOL    — V3 manages NQ only; ES bypassed
//   2. SKIP_SILENCED  — not in qualified_signals
//   3. SKIP_FLIP_SHORT — only if dropFlipShorts; currently FALSE
//   4. SKIP_CVD       — cvdSession violates floor at signal time
//   5. SKIP_COOLDOWN  — V3 already has an open trade in this symbol
//   6. OPEN           — entry at signal.entry
//
// Exit logic per open trade (walked tick-by-tick + interleaved opposing signals):
//   a. TP hit (TP=80) → WIN
//   b. SL hit (long SL=55, short SL=105) → LOSS
//   c. 15:54 ET RTH-close → CLOSE_AT_BELL (mark-to-current)
//   d. Opposing-direction qualified signal that passes shouldExitOnSignal → OPP_SIG_EXIT
//
// We must walk ALL qualified V3-eligible signals (not just FLIPs) so that
// non-FLIP qualified opps can close LONG trades.

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });

// ─── V3 config snapshot (must match src/config.ts v3 block) ─────────
const CVD_LONG_FLOOR  = -3000;
const CVD_SHORT_FLOOR = 3000;
const DROP_FLIP_SHORTS = false;
const CLOSE_SHORTS_ONLY_ON_FLIP_LONG = true;
const REQ_QUAL_EXITS_LONGS = true;
const V3_SYMBOLS = new Set(['NQ']);
const V3_ENTRY_RULES = new Set(['clean-impulse', 'absorption', 'wall-broken-fade']); // V3-eligible

// FLIP TP/SL per config.perRule['clean-impulse-FLIP']
const TP_FLIP   = 80;
const SL_LONG   = 55;
const SL_SHORT  = 105;
const PV_NQ = 2;

// RTH close at 15:54 ET, 09:30 ET RTH open (matched to cvd-session.ts)
const ET_OFFSET_MS = 4 * 60 * 60_000;
function etDateOf(tsMs: number): string {
  const d = new Date(tsMs - ET_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function rthOpenMs(etDate: string): number {
  const [y,m,d] = etDate.split('-').map(Number) as [number,number,number];
  return Date.UTC(y, m-1, d, 13, 30); // 09:30 ET = 13:30 UTC (EDT)
}
function rthForceCloseMs(etDate: string): number {
  const [y,m,d] = etDate.split('-').map(Number) as [number,number,number];
  return Date.UTC(y, m-1, d, 19, 54); // 15:54 ET = 19:54 UTC (EDT)
}

// ─── Pull qualified V3-eligible signals (for opposing-exit logic) ───
// We INCLUDE clean-impulse, absorption, wall-broken-fade.
// For each FLIP we tag entry candidate; for non-FLIP we tag exit candidate only.
interface Sig {
  id: number;
  ts: number;
  symbol: string;
  ruleId: string;
  pattern: string | null;
  direction: 'long'|'short';
  score: number;
  entry: number;
  isFlip: boolean;
  isQualified: boolean;
}
const allSignals = db.prepare(`
  SELECT s.id, s.ts, s.symbol, s.rule_id AS ruleId,
         json_extract(s.payload,'$.pattern') AS pattern,
         s.direction, s.score,
         json_extract(s.payload,'$.entry')  AS entry,
         CASE WHEN q.signal_id IS NOT NULL THEN 1 ELSE 0 END AS isQualified
  FROM signals s
  LEFT JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.rule_id IN ('clean-impulse','absorption','wall-broken-fade')
    AND s.symbol IN ('NQ')
  ORDER BY s.ts ASC, s.id ASC
`).all().map((r: any) => ({
  id: r.id, ts: r.ts, symbol: r.symbol, ruleId: r.ruleId,
  pattern: r.pattern, direction: r.direction, score: r.score,
  entry: r.entry,
  isFlip: r.ruleId === 'clean-impulse' && r.pattern === 'FLIP',
  isQualified: r.isQualified === 1,
})) as Sig[];

console.log(`Loaded ${allSignals.length} V3-eligible NQ signals (entry-candidates + opposing-exit-candidates)`);
console.log(`  FLIP signals: ${allSignals.filter(s => s.isFlip).length}`);
console.log(`  FLIP qualified: ${allSignals.filter(s => s.isFlip && s.isQualified).length}\n`);

// ─── CVD lookup: precompute one cumulative table per ET-day ────────
// For each ET day we'll walk ticks once and remember the cumulative
// (ts, cvd) array; then binary-search for any ts to get the CVD up to it.
const dayCvdMs = new Map<string, { ts: number[]; cvd: number[] }>();
function ensureDayCvd(etDate: string): void {
  if (dayCvdMs.has(etDate)) return;
  const openMs = rthOpenMs(etDate);
  const closeBoundMs = openMs + 7 * 60 * 60_000; // until ~16:30 ET, generous
  const ticks = ticksDb.prepare(`
    SELECT ts, size, is_bid_aggressor
    FROM trades
    WHERE symbol='NQ' AND ts >= ? AND ts < ?
    ORDER BY ts ASC
  `).all(openMs, closeBoundMs) as Array<{ ts: number; size: number; is_bid_aggressor: number }>;
  const tsArr: number[] = [];
  const cvdArr: number[] = [];
  let cvd = 0;
  for (const t of ticks) {
    cvd += t.is_bid_aggressor === 1 ? t.size : -t.size;
    tsArr.push(t.ts);
    cvdArr.push(cvd);
  }
  dayCvdMs.set(etDate, { ts: tsArr, cvd: cvdArr });
}
function cvdAt(tsMs: number): number {
  const etDate = etDateOf(tsMs);
  ensureDayCvd(etDate);
  const { ts, cvd } = dayCvdMs.get(etDate)!;
  if (!ts.length || tsMs < ts[0]!) return 0;
  // binary search: largest ts[i] <= tsMs
  let lo = 0, hi = ts.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! <= tsMs) { ans = mid; lo = mid + 1; }
    else                  { hi = mid - 1; }
  }
  return ans < 0 ? 0 : cvd[ans]!;
}

// ─── Tick walker for TP/SL/EOD between two times ───────────────────
const fwdTicksStmt = ticksDb.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol='NQ' AND ts > ? AND ts <= ?
  ORDER BY ts ASC
`);

interface ExitResult {
  reason: 'WIN'|'LOSS'|'CLOSE_AT_BELL'|'OPP_SIG_EXIT';
  exitTs: number;
  exitPx: number;
  pnlPts: number;
}
function walkForExit(
  entry: number, dir: 'long'|'short',
  tpPts: number, slPts: number,
  startMs: number, endMs: number
): ExitResult | null {
  const ticks = fwdTicksStmt.all(startMs, endMs) as Array<{ ts: number; price: number }>;
  for (const t of ticks) {
    const m = dir === 'long' ? t.price - entry : entry - t.price;
    if (m >=  tpPts) return { reason: 'WIN',  exitTs: t.ts, exitPx: dir === 'long' ? entry + tpPts : entry - tpPts, pnlPts: tpPts };
    if (m <= -slPts) return { reason: 'LOSS', exitTs: t.ts, exitPx: dir === 'long' ? entry - slPts : entry + slPts, pnlPts: -slPts };
  }
  return null;
}

// ─── Replicate trade-manager.shouldExitOnSignal ─────────────────────
function shouldExitOnSignal(
  openDir: 'long'|'short',
  incomingDir: 'long'|'short',
  incomingIsQualified: boolean,
  incomingRuleId: string,
  incomingPattern: string | null,
): boolean {
  if (openDir === incomingDir) return false;
  if (openDir === 'long' && REQ_QUAL_EXITS_LONGS && !incomingIsQualified) return false;
  if (openDir === 'short') {
    if (CLOSE_SHORTS_ONLY_ON_FLIP_LONG) {
      if (!incomingIsQualified) return false;
      if (incomingRuleId !== 'clean-impulse') return false;
      if (incomingPattern !== 'FLIP') return false;
    }
  }
  return true;
}

// ─── Simulate the V3 timeline ───────────────────────────────────────
interface FlipResult {
  signalId: number; ts: number; sym: string; dir: 'long'|'short'; score: number;
  entry: number; cvdAtSignal: number;
  v3Action: 'OPEN'|'SKIP_SILENCED'|'SKIP_CVD'|'SKIP_COOLDOWN'|'SKIP_FLIP_SHORT'|'SKIP_SYMBOL';
  exitReason?: 'WIN'|'LOSS'|'CLOSE_AT_BELL'|'OPP_SIG_EXIT';
  exitTs?: number;
  exitPx?: number;
  pnlPts?: number;
}

interface OpenTrade {
  symbol: string; flipSignalId: number; dir: 'long'|'short'; entry: number;
  tpPts: number; slPts: number; openTs: number;
}

const flipResults: FlipResult[] = [];
const openBySym = new Map<string, OpenTrade>();

function closeOpen(symbol: string, exitReason: ExitResult['reason'], exitTs: number, exitPx: number): void {
  const t = openBySym.get(symbol);
  if (!t) return;
  const pnlPts = t.dir === 'long' ? exitPx - t.entry : t.entry - exitPx;
  // Attach exit to the original FLIP result
  const fr = flipResults.find(f => f.signalId === t.flipSignalId);
  if (fr) {
    fr.exitReason = exitReason;
    fr.exitTs = exitTs;
    fr.exitPx = exitPx;
    fr.pnlPts = pnlPts;
  }
  openBySym.delete(symbol);
}

// Helper: before processing signal at ts, advance any open trades up to ts for
// TP/SL/EOD. If they hit, close them with the appropriate exit.
function advanceOpenTrades(uptoMs: number): void {
  for (const [sym, t] of [...openBySym.entries()]) {
    const etDate = etDateOf(t.openTs);
    const forceMs = rthForceCloseMs(etDate);
    const walkEnd = Math.min(uptoMs, forceMs);
    if (walkEnd <= t.openTs) continue;
    const exit = walkForExit(t.entry, t.dir, t.tpPts, t.slPts, t.openTs, walkEnd);
    if (exit) {
      closeOpen(sym, exit.reason, exit.exitTs, exit.exitPx);
    } else if (uptoMs >= forceMs) {
      // EOD reached without TP/SL — mark to last tick before forceMs
      const lastBefore = ticksDb.prepare(
        `SELECT ts, price FROM trades WHERE symbol='NQ' AND ts <= ? ORDER BY ts DESC LIMIT 1`
      ).get(forceMs) as { ts: number; price: number } | undefined;
      if (lastBefore) closeOpen(sym, 'CLOSE_AT_BELL', lastBefore.ts, lastBefore.price);
    }
  }
}

// Walk all signals chronologically
for (const s of allSignals) {
  // First: advance any open trades up to this signal's ts for TP/SL/EOD checks
  advanceOpenTrades(s.ts);

  // Handle opposing-signal-exit for any still-open trade
  const open = openBySym.get(s.symbol);
  if (open && shouldExitOnSignal(open.dir, s.direction, s.isQualified, s.ruleId, s.pattern)) {
    closeOpen(s.symbol, 'OPP_SIG_EXIT', s.ts, s.entry);
  }

  // Only FLIP signals can OPEN new V3 trades
  if (!s.isFlip) continue;

  // Apply V3 entry gates
  let v3Action: FlipResult['v3Action'] = 'OPEN';
  let cvd = 0;
  if (!V3_SYMBOLS.has(s.symbol)) {
    v3Action = 'SKIP_SYMBOL';
  } else if (!s.isQualified) {
    v3Action = 'SKIP_SILENCED';
  } else if (DROP_FLIP_SHORTS && s.direction === 'short') {
    v3Action = 'SKIP_FLIP_SHORT';
  } else {
    cvd = cvdAt(s.ts);
    if (s.direction === 'long' && cvd <= CVD_LONG_FLOOR) {
      v3Action = 'SKIP_CVD';
    } else if (s.direction === 'short' && cvd >= CVD_SHORT_FLOOR) {
      v3Action = 'SKIP_CVD';
    } else if (openBySym.has(s.symbol)) {
      v3Action = 'SKIP_COOLDOWN';
    }
  }

  const fr: FlipResult = {
    signalId: s.id, ts: s.ts, sym: s.symbol, dir: s.direction, score: s.score,
    entry: s.entry, cvdAtSignal: cvd, v3Action,
  };
  flipResults.push(fr);

  if (v3Action === 'OPEN') {
    const slPts = s.direction === 'long' ? SL_LONG : SL_SHORT;
    openBySym.set(s.symbol, {
      symbol: s.symbol, flipSignalId: s.id, dir: s.direction, entry: s.entry,
      tpPts: TP_FLIP, slPts, openTs: s.ts,
    });
  }
}
// Tail: close any still-open trades at their RTH bell
const lastTs = allSignals.length ? allSignals[allSignals.length-1]!.ts : Date.now();
advanceOpenTrades(lastTs + 24 * 3600 * 1000);

// ─── Report ────────────────────────────────────────────────────────
console.log('═══ V3 gate breakdown (FLIP signals only) ═══');
const counts = new Map<string, number>();
for (const r of flipResults) counts.set(r.v3Action, (counts.get(r.v3Action) ?? 0) + 1);
for (const [a, n] of [...counts.entries()].sort((a,b) => b[1]-a[1])) {
  console.log(`  ${a.padEnd(20)} ${String(n).padStart(4)}`);
}
console.log(`  ${'TOTAL'.padEnd(20)} ${String(flipResults.length).padStart(4)}`);

const opens = flipResults.filter(r => r.v3Action === 'OPEN');
console.log(`\n═══ V3-OPEN FLIPs: ${opens.length} ═══`);

function summary(rs: FlipResult[], label: string) {
  const w = rs.filter(r => r.exitReason === 'WIN' || (r.exitReason === 'OPP_SIG_EXIT' && (r.pnlPts ?? 0) > 0) || (r.exitReason === 'CLOSE_AT_BELL' && (r.pnlPts ?? 0) > 0)).length;
  const l = rs.filter(r => r.exitReason === 'LOSS' || ((r.exitReason === 'OPP_SIG_EXIT' || r.exitReason === 'CLOSE_AT_BELL') && (r.pnlPts ?? 0) < 0)).length;
  const o = rs.filter(r => r.exitReason === undefined || (r.exitReason !== 'WIN' && r.exitReason !== 'LOSS' && r.pnlPts === 0)).length;
  const wr = (w+l) ? (w/(w+l)*100).toFixed(0) : '--';
  const pts = rs.reduce((s, r) => s + (r.pnlPts ?? 0), 0);
  const $ = pts * PV_NQ;
  const ev = rs.length ? (pts/rs.length).toFixed(2) : '0';
  console.log(`${label.padEnd(28)}  n=${String(rs.length).padStart(3)}  W=${String(w).padStart(3)}  L=${String(l).padStart(3)}  O=${String(o).padStart(2)}  WR=${String(wr).padStart(4)}%  EV=${String(ev).padStart(7)}pts  net=${pts.toFixed(0).padStart(6)}pts  $=${$>=0?'+$':'-$'}${Math.abs($).toFixed(0)}`);
}

console.log('\n═══ Headline ═══');
summary(opens, 'ALL V3-OPEN');
summary(opens.filter(r => r.dir === 'long'),  '  LONG');
summary(opens.filter(r => r.dir === 'short'), '  SHORT');

console.log('\n═══ By exit reason ═══');
const reasons = new Map<string, FlipResult[]>();
for (const r of opens) {
  const k = r.exitReason ?? 'UNCLOSED';
  if (!reasons.has(k)) reasons.set(k, []);
  reasons.get(k)!.push(r);
}
for (const [reason, rs] of [...reasons.entries()].sort((a,b) => b[1].length - a[1].length)) {
  const pts = rs.reduce((s, r) => s + (r.pnlPts ?? 0), 0);
  console.log(`  ${reason.padEnd(16)}  n=${String(rs.length).padStart(3)}  net=${pts.toFixed(0).padStart(5)}pts`);
}

console.log('\n═══ By score band ═══');
for (const band of [[0,79],[80,89],[90,99],[100,100]]) {
  const lo = band[0]!, hi = band[1]!;
  const rs = opens.filter(r => r.score >= lo && r.score <= hi);
  if (rs.length) summary(rs, `score ${lo}-${hi}`);
}

console.log('\n═══ By month ═══');
const byMonth = new Map<string, FlipResult[]>();
for (const r of opens) {
  const day = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(r.ts));
  const mo = day.slice(0,7);
  if (!byMonth.has(mo)) byMonth.set(mo, []);
  byMonth.get(mo)!.push(r);
}
for (const [mo, rs] of [...byMonth.entries()].sort()) summary(rs, mo);

console.log('\n═══ By day ═══');
const byDay = new Map<string, FlipResult[]>();
for (const r of opens) {
  const day = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(r.ts));
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day)!.push(r);
}
for (const [day, rs] of [...byDay.entries()].sort()) summary(rs, day);

console.log('\n═══ All V3-OPEN trades (most recent first) ═══');
console.log('day              dir   score entry      cvd     exit      px         pts');
[...opens].reverse().forEach(r => {
  const et = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(r.ts));
  const exitTag = (r.exitReason ?? 'OPEN').padEnd(8);
  console.log(`${et}  ${r.dir.padEnd(5)} ${String(r.score).padStart(3)}   ${String(r.entry).padStart(9)}  ${String(r.cvdAtSignal).padStart(7)} ${exitTag} ${String(r.exitPx?.toFixed(2) ?? '-').padStart(9)}  ${(r.pnlPts ?? 0)>=0?'+':''}${(r.pnlPts ?? 0).toFixed(1).padStart(6)}`);
});
