// perf_es_flip.ts — Perf report for the es-flip rule on ES.
//
// Uses the strategy's NATIVE TP=20 / SL=20 (per strategy-es-flip.ts header,
// derived from labelled-swing analysis on 8 train / 8 holdout ES days).
// Walks each qualified es-flip signal from entry to TP / SL / 15:54 ET.
// Reports per-direction breakdown + total. $/pt = $5 for MES.
//
// Stale clean-impulse ES signals (14 raw) are EXCLUDED — those are from when
// strategy-h had ES in its SYMBOLS list before being restricted to NQ-only.
//
// All es-flip signals are currently force-shadow (action='SKIP_FORCE_SHADOW'),
// so the cohort = all qualified=1, regardless of action.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb   = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const TP = 20;
const SL = 20;
const DOLLAR_PER_PT = 5;   // MES

const fmtEtDate = (tsMs: number) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = p.split('/');
  return `${yyyy}-${mm}-${dd}`;
};
const rthCloseTsFor = (tsMs: number) => Date.parse(`${fmtEtDate(tsMs)}T15:54:00-04:00`);

const tickWalk = ticksDb.prepare(
  `SELECT ts, price FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`
);
const lastTick = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol=? AND ts <= ? ORDER BY ts DESC LIMIT 1`
);

function walkExit(symbol: string, fromTs: number, untilTs: number, entry: number, dir: 'long'|'short', tp: number, sl: number) {
  const tpPx = dir === 'long' ? entry + tp : entry - tp;
  const slPx = dir === 'long' ? entry - sl : entry + sl;
  for (const r of tickWalk.iterate(symbol, fromTs, untilTs) as IterableIterator<{ ts: number; price: number }>) {
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

interface Sig { signal_id: number; ts: number; symbol: string; rule_id: string; direction: 'long'|'short'; entry: number; action: string; }
const sigs = tradingDb.prepare(`
  SELECT s.id AS signal_id, s.ts, s.symbol, s.rule_id, s.direction, t.action,
         CAST(json_extract(s.payload, '$.entry') AS REAL) AS entry
  FROM signals s
  JOIN tradable_signals t ON t.signal_id = s.id
  WHERE s.symbol = 'ES'
    AND s.rule_id = 'es-flip'
    AND t.qualified = 1
    AND CAST(json_extract(s.payload, '$.entry') AS REAL) IS NOT NULL
  ORDER BY s.ts ASC
`).all() as Sig[];

console.log(`\n══ ES-FLIP perf — ${sigs.length} qualified signals ══`);
console.log(`   TP=${TP}pt FIXED · SL=${SL}pt FIXED · walk to TP/SL/15:54 ET · MES $${DOLLAR_PER_PT}/pt\n`);

interface Trade { dir: 'long'|'short'; reason: 'TP'|'SL'|'OPP'|'RTH'; pnl_pts: number; }
function simulate(): Trade[] {
  const completed: Trade[] = [];
  let open: { sig: Sig; tp: number; sl: number } | null = null;
  let prevDate: string | null = null;

  function closeAtRth(rthTs: number) {
    if (!open) return;
    const o = open;
    const hit = walkExit(o.sig.symbol, o.sig.ts, rthTs, o.sig.entry, o.sig.direction, o.tp, o.sl);
    if (hit) {
      const pnl = o.sig.direction === 'long' ? hit.price - o.sig.entry : o.sig.entry - hit.price;
      completed.push({ dir: o.sig.direction, reason: hit.reason, pnl_pts: pnl });
    } else {
      const r = lastTick.get(o.sig.symbol, rthTs) as { price: number } | undefined;
      const px = r?.price ?? o.sig.entry;
      const pnl = o.sig.direction === 'long' ? px - o.sig.entry : o.sig.entry - px;
      completed.push({ dir: o.sig.direction, reason: 'RTH', pnl_pts: pnl });
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
        completed.push({ dir: o.sig.direction, reason: hit.reason, pnl_pts: pnl });
        open = null;
      }
    }
    if (open) {
      if (open.sig.direction === s.direction) continue;       // cooldown for same dir
      const o = open;                                          // opposing — close at signal entry
      const pnl = o.sig.direction === 'long' ? s.entry - o.sig.entry : o.sig.entry - s.entry;
      completed.push({ dir: o.sig.direction, reason: 'OPP', pnl_pts: pnl });
      open = null;
    }
    open = { sig: s, tp: TP, sl: SL };
  }
  if (prevDate) closeAtRth(rthCloseTsFor(sigs[sigs.length - 1]!.ts));
  return completed;
}

function printPerf(trades: Trade[]) {
  const pad = (s: string, n: number, right = false) => right ? s.padStart(n) : s.padEnd(n);
  const dirs: ('long' | 'short')[] = ['long', 'short'];

  console.log('┌──────────────┬─────┬─────┬─────┬────────┬───────────┬──────────┬──────────────────────┐');
  console.log('│ Direction    │  n  │  W  │  L  │   WR   │  Total $  │ EV/trade │ TP / SL / OPP / RTH  │');
  console.log('├──────────────┼─────┼─────┼─────┼────────┼───────────┼──────────┼──────────────────────┤');

  let allN = 0, allW = 0, allL = 0, allPts = 0;
  for (const d of dirs) {
    const subset = trades.filter(t => t.dir === d);
    const n = subset.length;
    const w = subset.filter(t => t.pnl_pts > 0).length;
    const l = subset.filter(t => t.pnl_pts < 0).length;
    const pts = subset.reduce((s, t) => s + t.pnl_pts, 0);
    const usd = pts * DOLLAR_PER_PT;
    const wr = (w + l) ? (100 * w / (w + l)).toFixed(1) + '%' : '—';
    const tp = subset.filter(t => t.reason === 'TP').length;
    const sl = subset.filter(t => t.reason === 'SL').length;
    const opp = subset.filter(t => t.reason === 'OPP').length;
    const rth = subset.filter(t => t.reason === 'RTH').length;
    const usdStr = usd >= 0 ? `+$${usd.toFixed(0)}` : `-$${Math.abs(usd).toFixed(0)}`;
    const ev = n ? usd / n : 0;
    const evStr = ev >= 0 ? `+$${ev.toFixed(1)}` : `-$${Math.abs(ev).toFixed(1)}`;
    const exits = `${String(tp).padStart(3)} / ${String(sl).padStart(3)} / ${String(opp).padStart(3)} / ${String(rth).padStart(3)}`;
    console.log(`│ ${pad(`es-flip ${d}`, 12)} │ ${pad(String(n),3,true)} │ ${pad(String(w),3,true)} │ ${pad(String(l),3,true)} │ ${pad(wr,6,true)} │ ${pad(usdStr,9,true)} │ ${pad(evStr,8,true)} │ ${exits.padEnd(20)} │`);
    allN += n; allW += w; allL += l; allPts += pts;
  }
  const allUsd = allPts * DOLLAR_PER_PT;
  const allWr = (allW + allL) ? (100 * allW / (allW + allL)).toFixed(1) + '%' : '—';
  const allUsdStr = allUsd >= 0 ? `+$${allUsd.toFixed(0)}` : `-$${Math.abs(allUsd).toFixed(0)}`;
  const allEv = allN ? allUsd / allN : 0;
  const allEvStr = allEv >= 0 ? `+$${allEv.toFixed(1)}` : `-$${Math.abs(allEv).toFixed(1)}`;
  console.log('├──────────────┼─────┼─────┼─────┼────────┼───────────┼──────────┼──────────────────────┤');
  console.log(`│ ${pad('TOTAL', 12)} │ ${pad(String(allN),3,true)} │ ${pad(String(allW),3,true)} │ ${pad(String(allL),3,true)} │ ${pad(allWr,6,true)} │ ${pad(allUsdStr,9,true)} │ ${pad(allEvStr,8,true)} │                      │`);
  console.log('└──────────────┴─────┴─────┴─────┴────────┴───────────┴──────────┴──────────────────────┘\n');
}

const trades = simulate();
printPerf(trades);

// Per-month breakdown — useful to check train/holdout/post-holdout consistency
console.log('Per-month breakdown:');
const byMonth = new Map<string, Trade[]>();
let monthCursor: string | null = null;
let cursor = 0;
for (const t of trades) {
  // Trades are in chronological order from simulate(); ts is in sigs[cursor].ts approximately.
  // Use the prior matching signal's ts to get month.
  while (cursor < sigs.length && sigs[cursor] && (sigs[cursor]!.direction !== t.dir)) cursor++;
  const ts = sigs[cursor]?.ts ?? Date.now();
  const mon = fmtEtDate(ts).slice(0, 7);
  if (mon !== monthCursor) monthCursor = mon;
  const arr = byMonth.get(mon) ?? [];
  arr.push(t);
  byMonth.set(mon, arr);
  cursor++;
}
for (const [mon, arr] of [...byMonth.entries()].sort()) {
  const n = arr.length;
  const w = arr.filter(t => t.pnl_pts > 0).length;
  const l = arr.filter(t => t.pnl_pts < 0).length;
  const wr = (w + l) ? (100 * w / (w + l)).toFixed(1) + '%' : '—';
  const usd = arr.reduce((s, t) => s + t.pnl_pts, 0) * DOLLAR_PER_PT;
  const usdStr = usd >= 0 ? `+$${usd.toFixed(0)}` : `-$${Math.abs(usd).toFixed(0)}`;
  console.log(`  ${mon}  n=${n}  W=${w} L=${l}  WR=${wr}  total=${usdStr}`);
}
