/**
 * sl_sweep.ts
 *
 * Sweeps SL values for a given signal type (from qualified_signals)
 * and computes WR + E[PnL] at TP=80 for each SL candidate.
 *
 * Usage:
 *   pnpm --filter aggregator exec tsx scripts/sl_sweep.ts expl long
 *   pnpm --filter aggregator exec tsx scripts/sl_sweep.ts clean-impulse short
 *   pnpm --filter aggregator exec tsx scripts/sl_sweep.ts absorption long
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trDb    = new Database(path.resolve(__dirname, '../../../data/trading.db'),   { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'),     { readonly: true });

const [ruleId, direction] = process.argv.slice(2);
if (!ruleId || !direction) {
  console.error('Usage: tsx sl_sweep.ts <rule_id> <long|short>');
  process.exit(1);
}

const TP = 80;
const SL_MIN  = 20;
const SL_MAX  = 200;
const SL_STEP = 5;

// ── Helpers ──────────────────────────────────────────────────────────────────

function etParts(ms: number) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
}
function etMinute(ms: number): number {
  const p = etParts(ms);
  return parseInt(p.find(x => x.type === 'hour')!.value, 10) * 60
       + parseInt(p.find(x => x.type === 'minute')!.value, 10);
}
function isRTH(ms: number): boolean {
  const p = etParts(ms);
  const wd = p.find(x => x.type === 'weekday')!.value;
  return ['Mon','Tue','Wed','Thu','Fri'].includes(wd)
      && etMinute(ms) >= 570 && etMinute(ms) < 960;
}
function rthEnd(ms: number): number {
  const etStr = new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const [m, d, y] = etStr.split('/').map(Number);
  const end = new Date(`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}T00:00:00`);
  end.setUTCHours(20, 0, 0, 0); // 16:00 EDT
  if (end.getTime() <= ms) end.setUTCHours(21, 0, 0, 0); // 16:00 EST
  return end.getTime();
}

const fwdQuery = ticksDb.prepare(
  `SELECT ts, price FROM trades WHERE symbol='NQ' AND ts > ? AND ts <= ? ORDER BY ts ASC`
);
const entryQuery = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? ORDER BY ts ASC LIMIT 1`
);

function getEntry(ts: number, payload: string): number {
  const p = JSON.parse(payload);
  if (p.entry && p.entry > 1000) return p.entry;
  const row = entryQuery.get(ts) as any;
  return row?.price ?? 0;
}

// ── Load signals ──────────────────────────────────────────────────────────────

const rows = trDb.prepare(`
  SELECT q.signal_ts AS ts, s.payload
  FROM qualified_signals q
  JOIN signals s ON s.id = q.signal_id
  WHERE q.rule_id = ? AND q.direction = ? AND q.symbol = 'NQ'
  ORDER BY q.signal_ts
`).all(ruleId, direction) as { ts: number; payload: string }[];

const sigs = rows
  .filter(s => isRTH(s.ts))
  .map(s => ({ ts: s.ts, ep: getEntry(s.ts, s.payload) }))
  .filter(s => s.ep > 0);

console.log(`\nSL sweep: ${ruleId} ${direction} | n=${sigs.length} RTH signals (qualified_signals) | TP=${TP}pts\n`);

// Cache tick paths per signal to avoid re-querying for each SL candidate
interface TickPath { maxGain: number; maxDD: number; firstTpAt: number | null; firstSlAt: Record<number, number | null> }
const cache: TickPath[] = sigs.map(s => {
  const dir = direction as 'long' | 'short';
  const end = rthEnd(s.ts);
  const trades = fwdQuery.all(s.ts, end) as { ts: number; price: number }[];
  let maxGain = 0;
  let maxDD   = 0;
  let firstTpAt: number | null = null;
  // Track first SL hit per candidate
  const slCandidates: number[] = [];
  for (let sl = SL_MIN; sl <= SL_MAX; sl += SL_STEP) slCandidates.push(sl);
  const firstSlAt: Record<number, number | null> = {};
  for (const sl of slCandidates) firstSlAt[sl] = null;

  for (const t of trades) {
    const pnl = dir === 'long' ? t.price - s.ep : s.ep - t.price;
    if (pnl > maxGain) maxGain = pnl;
    if (pnl < -maxDD) maxDD = -pnl; // maxDD stored as positive
    if (firstTpAt === null && pnl >= TP) firstTpAt = t.ts;
    for (const sl of slCandidates) {
      if (firstSlAt[sl] === null && pnl <= -sl) firstSlAt[sl] = t.ts;
    }
  }
  return { maxGain, maxDD, firstTpAt, firstSlAt };
});

// ── Sweep ─────────────────────────────────────────────────────────────────────

console.log('SL'.padEnd(6) + 'n'.padEnd(5) + 'wins'.padEnd(6) + 'WR%'.padEnd(7) + 'E[PnL]'.padEnd(10) + 'avgGain'.padEnd(10) + 'avgDD');
console.log('─'.repeat(50));

let bestEdge = -Infinity;
let bestSL   = 0;

for (let sl = SL_MIN; sl <= SL_MAX; sl += SL_STEP) {
  let wins = 0;
  let losses = 0;
  let sumPnl = 0;
  let sumGain = 0;
  let sumDD = 0;

  for (let i = 0; i < sigs.length; i++) {
    const c = cache[i]!;
    const tpTs = c.firstTpAt;
    const slTs = c.firstSlAt[sl];

    let pnl: number;
    if (tpTs !== null && (slTs === null || tpTs <= slTs)) {
      pnl = TP;
      wins++;
    } else if (slTs !== null) {
      pnl = -sl;
      losses++;
    } else {
      pnl = 0; // neither hit
    }
    sumPnl  += pnl;
    sumGain += c.maxGain;
    sumDD   += c.maxDD;
  }

  const n   = sigs.length;
  const wr  = Math.round(wins / n * 100);
  const edg = (sumPnl / n).toFixed(1);
  const ag  = (sumGain / n).toFixed(1);
  const add = (sumDD / n).toFixed(1);

  const edge = sumPnl / n;
  if (edge > bestEdge) { bestEdge = edge; bestSL = sl; }

  const marker = edge === bestEdge ? ' ←' : '';
  console.log(
    String(sl).padEnd(6) +
    String(n).padEnd(5) +
    String(wins).padEnd(6) +
    `${wr}%`.padEnd(7) +
    String(edg).padEnd(10) +
    String(ag).padEnd(10) +
    String(add) +
    marker
  );
}

console.log('─'.repeat(50));
console.log(`\nOptimal SL = ${bestSL}pts  (E[PnL] = ${bestEdge.toFixed(1)}pts/trade)\n`);

// ── Per-window breakdown at optimal SL ──────────────────────────────────────

const WINDOWS = [
  { label: '09:30–09:59', lo: 570, hi: 600 },
  { label: '10:00–10:29', lo: 600, hi: 630 },
  { label: '10:30–11:29', lo: 630, hi: 690 },
  { label: '11:30–12:59', lo: 690, hi: 780 },
  { label: '13:00–14:29', lo: 780, hi: 870 },
  { label: '14:30–15:59', lo: 870, hi: 960 },
];

console.log(`Per-window at optimal SL=${bestSL}:\n`);
console.log('WINDOW'.padEnd(18) + 'n'.padEnd(5) + 'wins'.padEnd(6) + 'WR%'.padEnd(7) + 'E[PnL]');
console.log('─'.repeat(42));

for (const w of WINDOWS) {
  const idxs = sigs
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => { const m = etMinute(s.ts); return m >= w.lo && m < w.hi; });

  let wins = 0; let n = idxs.length; let sumPnl = 0;
  for (const { i } of idxs) {
    const c = cache[i]!;
    const tpTs = c.firstTpAt;
    const slTs = c.firstSlAt[bestSL];
    if (tpTs !== null && (slTs === null || tpTs <= slTs)) { wins++; sumPnl += TP; }
    else if (slTs !== null) sumPnl -= bestSL;
  }
  const wr  = n > 0 ? Math.round(wins / n * 100) : 0;
  const edg = n > 0 ? (sumPnl / n).toFixed(1) : '-';
  console.log(w.label.padEnd(18) + String(n).padEnd(5) + String(wins).padEnd(6) + (n > 0 ? `${wr}%` : '-').padEnd(7) + edg);
}

trDb.close();
ticksDb.close();
