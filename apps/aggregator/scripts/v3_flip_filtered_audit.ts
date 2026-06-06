// Audit V3-FILTERED NQ FLIPs:
//   1. How many of the 124 filtered-out FLIPs would have been winners?
//   2. For each filtered-out winner, was there a confluence signal nearby
//      (WBF / tape-speed / large-print / absorption — same symbol, same
//      direction, within ±5 min) that could have validated the FLIP?
//
// Uses the same V3 gate logic as v3_flip_backtest.ts.

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });

const CVD_LONG_FLOOR  = -3000;
const CVD_SHORT_FLOOR = 3000;
const TP = 80;
const SL_LONG = 55;
const SL_SHORT = 105;
const FWD_MS = 120 * 60_000;
const CONFLUENCE_WINDOW_MS = 5 * 60_000;   // ±5 min around FLIP ts
const PV_NQ = 2;

const ET_OFFSET_MS = 4 * 60 * 60_000;
function etDateOf(tsMs: number): string {
  const d = new Date(tsMs - ET_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function rthOpenMs(etDate: string): number {
  const [y,m,d] = etDate.split('-').map(Number) as [number,number,number];
  return Date.UTC(y, m-1, d, 13, 30);
}

// ─── CVD lookup ─────────────────────────────────────────────────────
const dayCvdMs = new Map<string, { ts: number[]; cvd: number[] }>();
function ensureDayCvd(etDate: string): void {
  if (dayCvdMs.has(etDate)) return;
  const openMs = rthOpenMs(etDate);
  const ticks = ticksDb.prepare(`
    SELECT ts, size, is_bid_aggressor FROM trades
    WHERE symbol='NQ' AND ts >= ? AND ts < ?
    ORDER BY ts ASC
  `).all(openMs, openMs + 7 * 3600_000) as Array<{ ts: number; size: number; is_bid_aggressor: number }>;
  const tsArr: number[] = [], cvdArr: number[] = [];
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
  let lo = 0, hi = ts.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! <= tsMs) { ans = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return ans < 0 ? 0 : cvd[ans]!;
}

// ─── Pull all 164 NQ FLIP signals + their qualification + V3 gates ───
const flips = db.prepare(`
  SELECT s.id, s.ts, s.direction, s.score,
         json_extract(s.payload,'$.entry') AS entry,
         CASE WHEN q.signal_id IS NOT NULL THEN 1 ELSE 0 END AS isQualified
  FROM signals s
  LEFT JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.rule_id='clean-impulse'
    AND s.symbol='NQ'
    AND json_extract(s.payload,'$.pattern')='FLIP'
  ORDER BY s.ts ASC
`).all() as Array<{ id: number; ts: number; direction: 'long'|'short'; score: number; entry: number; isQualified: number }>;

// ─── For each FLIP, simulate the V3 gate decision (simplified — no
// inter-trade cooldown across FLIPs since we want to know each one's outcome
// in isolation) ────────────────────────────────────────────────────
const fwdTicks = ticksDb.prepare(`
  SELECT price FROM trades
  WHERE symbol='NQ' AND ts > ? AND ts <= ?
  ORDER BY ts ASC
`);

function simulateOutcome(entry: number, dir: 'long'|'short', startMs: number): { o: 'W'|'L'|'O'; pts: number } {
  const slPts = dir === 'long' ? SL_LONG : SL_SHORT;
  const ticks = fwdTicks.all(startMs, startMs + FWD_MS) as Array<{ price: number }>;
  for (const t of ticks) {
    const m = dir === 'long' ? t.price - entry : entry - t.price;
    if (m >=  TP)     return { o: 'W', pts:  TP };
    if (m <= -slPts)  return { o: 'L', pts: -slPts };
  }
  if (!ticks.length) return { o: 'O', pts: 0 };
  const last = ticks[ticks.length-1]!.price;
  const m = dir === 'long' ? last - entry : entry - last;
  return { o: m>0?'W':m<0?'L':'O', pts: m };
}

// ─── Confluence lookup: for each FLIP, find same-direction signals
// (WBF, tape-speed, large-print, absorption) within ±5 min ──────────
const confluence = db.prepare(`
  SELECT s.rule_id AS rule_id, s.ts AS ts, s.score AS score,
         json_extract(s.payload,'$.pattern') AS pattern,
         CASE WHEN q.signal_id IS NOT NULL THEN 1 ELSE 0 END AS isQualified
  FROM signals s
  LEFT JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.symbol='NQ' AND s.direction=?
    AND s.ts >= ? AND s.ts <= ?
    AND s.rule_id IN ('wall-broken-fade','tape-speed','large-print','absorption')
  ORDER BY s.ts ASC
`);

interface FlipDecision {
  id: number; ts: number; dir: 'long'|'short'; score: number; entry: number;
  v3Action: 'OPEN'|'SKIP_SILENCED'|'SKIP_CVD';
  cvd: number;
  outcome: 'W'|'L'|'O'; pts: number;
  confluence: Array<{ rule: string; pattern: string|null; score: number; qualified: boolean; deltaSec: number }>;
}

const decisions: FlipDecision[] = [];
for (const f of flips) {
  const cvd = cvdAt(f.ts);
  let v3Action: FlipDecision['v3Action'] = 'OPEN';
  if (!f.isQualified) {
    v3Action = 'SKIP_SILENCED';
  } else if (f.direction === 'long' && cvd <= CVD_LONG_FLOOR) {
    v3Action = 'SKIP_CVD';
  } else if (f.direction === 'short' && cvd >= CVD_SHORT_FLOOR) {
    v3Action = 'SKIP_CVD';
  }
  // (Note: we're NOT simulating cooldown here — every FLIP gets evaluated in
  // isolation so we can see its standalone outcome. v3_flip_backtest.ts has
  // the cooldown-aware version.)
  const out = simulateOutcome(f.entry, f.direction, f.ts);
  const confl = confluence.all(f.direction, f.ts - CONFLUENCE_WINDOW_MS, f.ts + CONFLUENCE_WINDOW_MS) as Array<{ rule_id: string; ts: number; score: number; pattern: string|null; isQualified: number }>;
  decisions.push({
    id: f.id, ts: f.ts, dir: f.direction, score: f.score, entry: f.entry,
    v3Action, cvd, outcome: out.o, pts: out.pts,
    confluence: confl.map(c => ({
      rule: c.rule_id, pattern: c.pattern, score: c.score,
      qualified: c.isQualified === 1,
      deltaSec: Math.round((c.ts - f.ts) / 1000),
    })),
  });
}

// ─── Report ────────────────────────────────────────────────────────
function summary(rs: FlipDecision[], label: string): void {
  const w = rs.filter(r => r.outcome === 'W').length;
  const l = rs.filter(r => r.outcome === 'L').length;
  const o = rs.filter(r => r.outcome === 'O').length;
  const wr = (w+l) ? (w/(w+l)*100).toFixed(0) : '--';
  const pts = rs.reduce((s, r) => s + r.pts, 0);
  const $ = pts * PV_NQ;
  console.log(`  ${label.padEnd(28)}  n=${String(rs.length).padStart(3)}  W=${String(w).padStart(3)}  L=${String(l).padStart(3)}  O=${String(o).padStart(2)}  WR=${String(wr).padStart(4)}%  net=${pts.toFixed(0).padStart(5)}pts  $=${$>=0?'+$':'-$'}${Math.abs($).toFixed(0)}`);
}

console.log('═══ Standalone outcome by V3 action ═══');
console.log('(Outcomes computed independently — no cooldown blocking)');
summary(decisions, 'ALL FLIPs (164)');
summary(decisions.filter(d => d.v3Action === 'OPEN'),         'V3-OPEN');
summary(decisions.filter(d => d.v3Action === 'SKIP_SILENCED'),'V3-SKIP_SILENCED');
summary(decisions.filter(d => d.v3Action === 'SKIP_CVD'),     'V3-SKIP_CVD');

console.log('\n═══ Filtered-out winners by skip reason ═══');
const filtered = decisions.filter(d => d.v3Action !== 'OPEN');
const filteredWinners = filtered.filter(d => d.outcome === 'W');
const filteredLosers  = filtered.filter(d => d.outcome === 'L');
console.log(`  Total filtered:  ${filtered.length}`);
console.log(`    Winners (TP=80 hit): ${filteredWinners.length}  (+${filteredWinners.length * 80} pts left on table)`);
console.log(`    Losers  (SL hit):    ${filteredLosers.length}   (-${filteredLosers.reduce((s,r) => s + Math.abs(r.pts), 0)} pts avoided)`);
console.log(`    Open    (no hit):    ${filtered.filter(d => d.outcome === 'O').length}`);
const netIfTaken = filtered.reduce((s, r) => s + r.pts, 0);
console.log(`  Net if all filtered FLIPs had been taken: ${netIfTaken.toFixed(0)} pts ($${(netIfTaken * PV_NQ).toFixed(0)})`);

console.log('\n═══ Filtered-out winners: which had confluence? ═══');
const RULES = ['wall-broken-fade','tape-speed','large-print','absorption'] as const;
const stats: Record<string, { winnerWithConf: number; loserWithConf: number; winnerQualConf: number; loserQualConf: number }> = {};
for (const r of RULES) stats[r] = { winnerWithConf: 0, loserWithConf: 0, winnerQualConf: 0, loserQualConf: 0 };

let winnersWithAnyConf = 0;
let losersWithAnyConf  = 0;
let winnersWithQualConf = 0;
let losersWithQualConf  = 0;

for (const d of filtered) {
  const hasConf = d.confluence.length > 0;
  const hasQualConf = d.confluence.some(c => c.qualified);
  if (d.outcome === 'W') {
    if (hasConf)     winnersWithAnyConf++;
    if (hasQualConf) winnersWithQualConf++;
  } else if (d.outcome === 'L') {
    if (hasConf)     losersWithAnyConf++;
    if (hasQualConf) losersWithQualConf++;
  }
  for (const c of d.confluence) {
    const k = c.rule as keyof typeof stats;
    if (!stats[k]) continue;
    if (d.outcome === 'W') {
      stats[k].winnerWithConf++;
      if (c.qualified) stats[k].winnerQualConf++;
    } else if (d.outcome === 'L') {
      stats[k].loserWithConf++;
      if (c.qualified) stats[k].loserQualConf++;
    }
  }
}

console.log(`  Filtered WINNERS with ANY confluence (±5min):     ${winnersWithAnyConf} / ${filteredWinners.length}  (${(winnersWithAnyConf/filteredWinners.length*100).toFixed(0)}%)`);
console.log(`  Filtered WINNERS with QUALIFIED confluence:        ${winnersWithQualConf} / ${filteredWinners.length}  (${(winnersWithQualConf/filteredWinners.length*100).toFixed(0)}%)`);
console.log(`  Filtered LOSERS with ANY confluence (control):    ${losersWithAnyConf} / ${filteredLosers.length}  (${(losersWithAnyConf/filteredLosers.length*100).toFixed(0)}%)`);
console.log(`  Filtered LOSERS with QUALIFIED confluence (ctrl): ${losersWithQualConf} / ${filteredLosers.length}  (${(losersWithQualConf/filteredLosers.length*100).toFixed(0)}%)`);

console.log('\n═══ Confluence breakdown by rule ═══');
console.log(`  ${'rule'.padEnd(20)}  W-w/-conf  L-w/-conf  W-qual  L-qual  edge%`);
for (const rule of RULES) {
  const s = stats[rule]!;
  const edge = (s.winnerQualConf + s.loserQualConf) > 0
    ? ((s.winnerQualConf / (s.winnerQualConf + s.loserQualConf)) * 100).toFixed(0)
    : '--';
  console.log(`  ${rule.padEnd(20)}  ${String(s.winnerWithConf).padStart(9)}  ${String(s.loserWithConf).padStart(9)}  ${String(s.winnerQualConf).padStart(6)}  ${String(s.loserQualConf).padStart(6)}  ${String(edge).padStart(4)}%`);
}

console.log('\n═══ Rescue analysis: "FLIP+qualified-confluence" subset ═══');
const rescue = filtered.filter(d => d.confluence.some(c => c.qualified));
console.log(`  Filtered FLIPs with QUALIFIED confluence: ${rescue.length}`);
summary(rescue,                                'all rescued candidates');
summary(rescue.filter(d => d.v3Action === 'SKIP_SILENCED'), '  SKIP_SILENCED rescued');
summary(rescue.filter(d => d.v3Action === 'SKIP_CVD'),       '  SKIP_CVD rescued');
const rescuePts = rescue.reduce((s, r) => s + r.pts, 0);
console.log(`  Net if "rescue" had taken these: ${rescuePts.toFixed(0)} pts ($${(rescuePts * PV_NQ).toFixed(0)})`);

console.log('\n═══ Top 20 missed winners (qualified confluence, most recent first) ═══');
console.log('day              dir   score entry      cvd     v3action          confluence (qualified only)');
[...rescue].filter(d => d.outcome === 'W').reverse().slice(0,20).forEach(d => {
  const et = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(d.ts));
  const conf = d.confluence.filter(c => c.qualified).map(c => `${c.rule}(${c.pattern ?? ''}/${c.score}/${c.deltaSec >= 0 ? '+' : ''}${c.deltaSec}s)`).join(', ');
  console.log(`${et}  ${d.dir.padEnd(5)} ${String(d.score).padStart(3)}   ${String(d.entry).padStart(9)}  ${String(d.cvd).padStart(7)}  ${d.v3Action.padEnd(15)}  ${conf}`);
});
