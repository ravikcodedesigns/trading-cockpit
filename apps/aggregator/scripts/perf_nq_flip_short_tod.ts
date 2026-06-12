// perf_nq_flip_short_tod.ts — NQ clean-impulse FLIP short performance,
// segmented by ET time-of-day. Compares post-14:30 cohort against pre-14:30
// to evaluate whether the universal 14:30 stop is leaving edge on the table.
//
// TP=80, SL=105 (clean-impulse short). Walk each trade independently to
// TP / SL / 15:54 ET. No OPP exit (so we test the rule in isolation, not
// the live cooldown overlay).

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb   = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const TP = 80;
const SL = 105;
const DOLLAR_PER_PT = 2;

const fmtEtDate = (tsMs: number) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = p.split('/');
  return `${yyyy}-${mm}-${dd}`;
};
const etHour = (tsMs: number) => parseInt(
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(new Date(tsMs)), 10
);
const etMin = (tsMs: number) => {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = fmt.formatToParts(new Date(tsMs));
  const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  return h * 60 + m;
};
const rthCloseTsFor = (tsMs: number) => Date.parse(`${fmtEtDate(tsMs)}T15:54:00-04:00`);

const walkStmt = ticksDb.prepare(
  `SELECT ts, price FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`
);
const lastTickStmt = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol=? AND ts <= ? ORDER BY ts DESC LIMIT 1`
);

function walkExit(symbol: string, fromTs: number, untilTs: number, entry: number, tp: number, sl: number) {
  // FLIP-short: entry → expect price DOWN to TP; SL is above
  const tpPx = entry - tp;
  const slPx = entry + sl;
  for (const r of walkStmt.iterate(symbol, fromTs, untilTs) as IterableIterator<{ ts: number; price: number }>) {
    if (r.price >= slPx) return { ts: r.ts, price: slPx, reason: 'SL' as const };
    if (r.price <= tpPx) return { ts: r.ts, price: tpPx, reason: 'TP' as const };
  }
  return null;
}

interface Sig { signal_id: number; ts: number; entry: number; action: string; }
const sigs = tradingDb.prepare(`
  SELECT s.id AS signal_id, s.ts, t.action,
         CAST(json_extract(s.payload, '$.entry') AS REAL) AS entry
  FROM signals s
  JOIN tradable_signals t ON t.signal_id = s.id
  WHERE s.symbol='NQ'
    AND s.rule_id='clean-impulse'
    AND s.direction='short'
    AND t.qualified=1
    AND json_extract(s.payload, '$.pattern') = 'FLIP'
    AND CAST(json_extract(s.payload, '$.entry') AS REAL) IS NOT NULL
  ORDER BY s.ts ASC
`).all() as Sig[];

console.log(`\n══ NQ FLIP-short perf by ET time-of-day — ${sigs.length} qualified signals ══`);
console.log(`   TP=${TP}pt · SL=${SL}pt · walk independently to TP/SL/15:54 ET\n`);

interface Trade { sig: Sig; pnlPts: number; reason: 'TP'|'SL'|'RTH'; }
const trades: Trade[] = [];
for (const s of sigs) {
  const rthClose = rthCloseTsFor(s.ts);
  if (s.ts >= rthClose) continue;  // skip post-15:54
  const hit = walkExit('NQ', s.ts, rthClose, s.entry, TP, SL);
  if (hit) {
    trades.push({ sig: s, pnlPts: s.entry - hit.price, reason: hit.reason });
  } else {
    const r = lastTickStmt.get('NQ', rthClose) as { price: number } | undefined;
    const px = r?.price ?? s.entry;
    trades.push({ sig: s, pnlPts: s.entry - px, reason: 'RTH' });
  }
}

function bucket(min: number): string {
  if (min < 9 * 60 + 30)  return 'pre-RTH (<09:30)';
  if (min < 10 * 60 + 30) return 'OPEN (09:30-10:30)';
  if (min < 14 * 60 + 30) return 'MID (10:30-14:30)';
  return 'LATE (14:30-15:54) ⛔ currently halted';
}

const buckets = new Map<string, Trade[]>();
const order = ['pre-RTH (<09:30)', 'OPEN (09:30-10:30)', 'MID (10:30-14:30)', 'LATE (14:30-15:54) ⛔ currently halted'];
for (const t of trades) {
  const b = bucket(etMin(t.sig.ts));
  const arr = buckets.get(b) ?? [];
  arr.push(t);
  buckets.set(b, arr);
}

const pad = (s: string, n: number, right = false) => right ? s.padStart(n) : s.padEnd(n);
console.log('┌─────────────────────────────────────────────┬─────┬─────┬─────┬────────┬───────────┬──────────┬─────────────┐');
console.log('│ Bucket                                      │  n  │  W  │  L  │   WR   │  Total $  │ EV/trade │ TP / SL / RTH │');
console.log('├─────────────────────────────────────────────┼─────┼─────┼─────┼────────┼───────────┼──────────┼─────────────┤');
let allN = 0, allW = 0, allL = 0, allPts = 0;
for (const key of order) {
  const arr = buckets.get(key) ?? [];
  if (arr.length === 0) {
    console.log(`│ ${pad(key, 43)} │ ${pad('0', 3, true)} │  —  │  —  │   —    │     —     │    —     │   —/— /—    │`);
    continue;
  }
  const n = arr.length;
  const w = arr.filter(t => t.pnlPts > 0).length;
  const l = arr.filter(t => t.pnlPts < 0).length;
  const pts = arr.reduce((s, t) => s + t.pnlPts, 0);
  const usd = pts * DOLLAR_PER_PT;
  const wr = (w + l) ? (100 * w / (w + l)).toFixed(1) + '%' : '—';
  const tp = arr.filter(t => t.reason === 'TP').length;
  const sl = arr.filter(t => t.reason === 'SL').length;
  const rth = arr.filter(t => t.reason === 'RTH').length;
  const usdStr = usd >= 0 ? `+$${usd.toFixed(0)}` : `-$${Math.abs(usd).toFixed(0)}`;
  const ev = usd / n;
  const evStr = ev >= 0 ? `+$${ev.toFixed(1)}` : `-$${Math.abs(ev).toFixed(1)}`;
  console.log(`│ ${pad(key, 43)} │ ${pad(String(n),3,true)} │ ${pad(String(w),3,true)} │ ${pad(String(l),3,true)} │ ${pad(wr,6,true)} │ ${pad(usdStr,9,true)} │ ${pad(evStr,8,true)} │ ${pad(`${tp}/${sl}/${rth}`, 11)} │`);
  allN += n; allW += w; allL += l; allPts += pts;
}
const allUsd = allPts * DOLLAR_PER_PT;
const allWr = (allW + allL) ? (100 * allW / (allW + allL)).toFixed(1) + '%' : '—';
const allUsdStr = allUsd >= 0 ? `+$${allUsd.toFixed(0)}` : `-$${Math.abs(allUsd).toFixed(0)}`;
const allEv = allUsd / allN;
const allEvStr = allEv >= 0 ? `+$${allEv.toFixed(1)}` : `-$${Math.abs(allEv).toFixed(1)}`;
console.log('├─────────────────────────────────────────────┼─────┼─────┼─────┼────────┼───────────┼──────────┼─────────────┤');
console.log(`│ ${pad('TOTAL', 43)} │ ${pad(String(allN),3,true)} │ ${pad(String(allW),3,true)} │ ${pad(String(allL),3,true)} │ ${pad(allWr,6,true)} │ ${pad(allUsdStr,9,true)} │ ${pad(allEvStr,8,true)} │             │`);
console.log('└─────────────────────────────────────────────┴─────┴─────┴─────┴────────┴───────────┴──────────┴─────────────┘');

// Show every LATE signal (the cohort we'd unblock)
const lateTrades = buckets.get('LATE (14:30-15:54) ⛔ currently halted') ?? [];
if (lateTrades.length > 0) {
  console.log(`\nLATE (post-14:30) signals in detail:`);
  for (const t of lateTrades) {
    const day = fmtEtDate(t.sig.ts);
    const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t.sig.ts));
    const pnlStr = t.pnlPts >= 0 ? `+${t.pnlPts.toFixed(1)}pt` : `${t.pnlPts.toFixed(1)}pt`;
    const usdStr = t.pnlPts * DOLLAR_PER_PT >= 0 ? `+$${(t.pnlPts * DOLLAR_PER_PT).toFixed(0)}` : `-$${Math.abs(t.pnlPts * DOLLAR_PER_PT).toFixed(0)}`;
    console.log(`  ${day} ${time} ET  entry=${t.sig.entry}  ${t.reason}  ${pnlStr} ${usdStr}  ${t.sig.action === 'OPEN' ? 'pipeline=OPEN' : `pipeline=${t.sig.action}`}`);
  }
}
