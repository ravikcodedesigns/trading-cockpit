// Backtest of clean-impulse FLIPs SILENCED by quality.ts wrong-direction-background rule.
// The current rule: LONG needs delta5 ≤ -1000, SHORT needs delta5 ≥ +1000.
// Anything else → silenced (not broadcast, trader never sees it).
//
// Run with same trader TP/SL: long TP=80/SL=55, short TP=80/SL=105.
// 120-min walk-forward, RTH-only entries.

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db        = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb   = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const TP = 80, SL_LONG = 55, SL_SHORT = 105;
const WINDOW_MS = 120 * 60_000;

// Threshold from quality.ts: |delta5| must be ≥ 1000 in the RIGHT direction.
const DELTA5_THRESHOLD = 1000;

// Strategy-H gate logic per quality.ts:
//   FLIP LONG  needs delta5 ≤ -DELTA5_THRESHOLD (background was selling, exhaustion)
//   FLIP SHORT needs delta5 ≥ +DELTA5_THRESHOLD (background was buying, exhaustion)
function isWrongDirection(direction: 'long' | 'short', delta5: number): boolean {
  if (direction === 'long')  return delta5 > -DELTA5_THRESHOLD;
  if (direction === 'short') return delta5 < +DELTA5_THRESHOLD;
  return false;
}

const rows = db.prepare(`
  SELECT id, ts, symbol, direction, score, payload
  FROM signals
  WHERE rule_id='clean-impulse'
    AND json_extract(payload,'$.pattern')='FLIP'
  ORDER BY ts ASC
`).all() as Array<{ id: number; ts: number; symbol: string; direction: 'long'|'short'; score: number; payload: string }>;

console.log(`Total clean-impulse FLIPs in DB: ${rows.length}`);

function getETMin(ts: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts));
  return parseInt(p.find(x => x.type === 'hour')?.value ?? '0', 10) * 60
       + parseInt(p.find(x => x.type === 'minute')?.value ?? '0', 10);
}

const fwdQ = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`
);

interface Result {
  id: number;
  ts: number;
  direction: 'long' | 'short';
  score: number;
  delta5: number;
  etMin: number;
  silenced: boolean;
  pnlPts: number;
  outcome: 'W' | 'L' | 'O';
}

const results: Result[] = [];

for (const r of rows) {
  const etMin = getETMin(r.ts);
  if (etMin < 570 || etMin >= 960) continue;   // RTH only

  const payload = JSON.parse(r.payload);
  const entry: number = payload.entry;
  const delta5: number = payload.delta5 ?? 0;
  if (!entry) continue;

  const silenced = isWrongDirection(r.direction, delta5);

  const sl = r.direction === 'long' ? SL_LONG : SL_SHORT;
  const fwd = fwdQ.all(r.symbol, r.ts, r.ts + WINDOW_MS) as { price: number }[];
  let outcome: 'W'|'L'|'O' = 'O', pnl = 0;
  for (const t of fwd) {
    const move = r.direction === 'long' ? t.price - entry : entry - t.price;
    if (move >=  TP) { outcome = 'W'; pnl = TP;  break; }
    if (move <= -sl) { outcome = 'L'; pnl = -sl; break; }
  }
  if (outcome === 'O' && fwd.length) {
    // Mark-to-close at end of 120m window
    const last = fwd[fwd.length - 1]!.price;
    const closeMove = r.direction === 'long' ? last - entry : entry - last;
    pnl = closeMove;
    outcome = closeMove > 0 ? 'W' : closeMove < 0 ? 'L' : 'O';
  }
  results.push({ id: r.id, ts: r.ts, direction: r.direction, score: r.score, delta5, etMin, silenced, pnlPts: pnl, outcome });
}

function summarize(rs: Result[], label: string) {
  if (rs.length === 0) { console.log(`\n══ ${label} : no data ══`); return; }
  const w = rs.filter(x => x.outcome === 'W').length;
  const l = rs.filter(x => x.outcome === 'L').length;
  const o = rs.filter(x => x.outcome === 'O').length;
  const wr = (w + l) ? (w / (w + l) * 100).toFixed(1) : '—';
  const pts = rs.reduce((s, x) => s + x.pnlPts, 0);
  console.log(`\n══ ${label} ══`);
  console.log(`  n=${rs.length}  W=${w}  L=${l}  scratch=${o}  WR=${wr}%`);
  console.log(`  net pts=${pts >= 0 ? '+' : ''}${pts.toFixed(1)}   $@MNQ ${pts*2 >= 0 ? '+$' : '-$'}${Math.abs(pts*2).toFixed(0)}`);
  console.log(`  EV/signal pts=${(pts/rs.length).toFixed(2)}`);
}

// ── Headline ────────────────────────────────────────────────────────────────
summarize(results, 'ALL FLIPs (RTH)');
summarize(results.filter(r => !r.silenced), 'PASSED quality gate (currently broadcast/traded)');
summarize(results.filter(r => r.silenced),  'SILENCED by wrong-direction-background');

// ── Silenced split by direction ────────────────────────────────────────────
summarize(results.filter(r => r.silenced && r.direction === 'long'),  'SILENCED LONG');
summarize(results.filter(r => r.silenced && r.direction === 'short'), 'SILENCED SHORT');

// ── Silenced by delta5 magnitude (closer to threshold = more borderline) ───
function bucketByDelta5(rs: Result[], label: string) {
  console.log(`\n══ ${label} — by |delta5| bucket ══`);
  const buckets: Record<string, Result[]> = {
    '0-500':    rs.filter(r => Math.abs(r.delta5) < 500),
    '500-1000': rs.filter(r => Math.abs(r.delta5) >= 500 && Math.abs(r.delta5) < 1000),
    '1000-2000':rs.filter(r => Math.abs(r.delta5) >= 1000 && Math.abs(r.delta5) < 2000),
    '2000+':    rs.filter(r => Math.abs(r.delta5) >= 2000),
  };
  console.log('bucket       n    W    L   WR%    netPts');
  for (const [k, arr] of Object.entries(buckets)) {
    const w = arr.filter(x => x.outcome === 'W').length;
    const l = arr.filter(x => x.outcome === 'L').length;
    const wr = (w + l) ? (w/(w+l)*100).toFixed(0) : '—';
    const pts = arr.reduce((s, x) => s + x.pnlPts, 0);
    console.log(`${k.padEnd(10)}  ${String(arr.length).padStart(2)}  ${String(w).padStart(3)}  ${String(l).padStart(3)}  ${String(wr).padStart(4)}    ${pts >= 0 ? '+' : ''}${pts.toFixed(0)}`);
  }
}
bucketByDelta5(results.filter(r => r.silenced && r.direction === 'long'),  'SILENCED LONG');
bucketByDelta5(results.filter(r => r.silenced && r.direction === 'short'), 'SILENCED SHORT');

// ── What if we ALSO took the silenced ones? ──
const passed = results.filter(r => !r.silenced).reduce((s, x) => s + x.pnlPts, 0);
const silenced = results.filter(r => r.silenced).reduce((s, x) => s + x.pnlPts, 0);
console.log(`\n══ Bottom line ══`);
console.log(`  Current (silence wrong-dir): +${passed.toFixed(0)}pts  ($${(passed*2).toFixed(0)})`);
console.log(`  If we ALSO took silenced:    +${(passed + silenced).toFixed(0)}pts  ($${((passed+silenced)*2).toFixed(0)})  diff: ${silenced >= 0 ? '+' : ''}${silenced.toFixed(0)}pts`);
console.log(`  → Rule is ${silenced < 0 ? '✓ HELPING' : silenced > 0 ? '✗ COSTING alpha' : 'neutral'}`);
