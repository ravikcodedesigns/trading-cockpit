// perf_es.ts — Perf report for ES FLIP + CONT signals.
// Walks each qualified signal from entry to TP / SL / 15:54 ET.
// SL per rule: clean-impulse long=55, short=105; cont-reentry=70.
// TP=80 (FIXED, per per-rule production config).
// $/pt for ES = $5 (MES micro).
// No look-ahead; cooldown applied to mirror live pipeline (action='OPEN' cohort).

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb   = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const TP = 80;
const DOLLAR_PER_PT = 5;   // MES

function fixedSl(rule: string, dir: 'long' | 'short'): number {
  if (rule === 'clean-impulse') return dir === 'long' ? 55 : 105;
  if (rule === 'cont-reentry')  return 70;
  throw new Error(`no SL for ${rule}`);
}

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

function walkExit(symbol: string, fromTs: number, untilTs: number, entry: number, dir: 'long' | 'short', tp: number, sl: number) {
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

interface Sig { signal_id: number; ts: number; symbol: string; rule_id: string; direction: 'long'|'short'; entry: number; action: string; qualified: number; }
const sigs = tradingDb.prepare(`
  SELECT s.id AS signal_id, s.ts, s.symbol, s.rule_id, s.direction, t.action, t.qualified,
         CAST(json_extract(s.payload, '$.entry') AS REAL) AS entry
  FROM signals s
  JOIN tradable_signals t ON t.signal_id = s.id
  WHERE s.symbol = 'ES'
    AND s.rule_id IN ('clean-impulse','cont-reentry')
    AND t.qualified = 1
    AND CAST(json_extract(s.payload, '$.entry') AS REAL) IS NOT NULL
  ORDER BY s.ts ASC
`).all() as Sig[];

console.log(`\n══ ES perf report — ${sigs.length} qualified FLIP+CONT signals ══`);
console.log(`   TP=80pt FIXED · SL per-rule · walk to TP/SL/15:54 ET · MES $${DOLLAR_PER_PT}/pt\n`);

interface Trade { rule: string; dir: 'long'|'short'; reason: 'TP'|'SL'|'OPP'|'RTH'; pnl_pts: number; }
function simulate(cohort: 'qualified' | 'tradable'): Trade[] {
  const completed: Trade[] = [];
  let open: { sig: Sig; tp: number; sl: number } | null = null;
  let prevDate: string | null = null;

  function closeAtRth(rthTs: number) {
    if (!open) return;
    const o = open;
    const hit = walkExit(o.sig.symbol, o.sig.ts, rthTs, o.sig.entry, o.sig.direction, o.tp, o.sl);
    if (hit) {
      const pnl = o.sig.direction === 'long' ? hit.price - o.sig.entry : o.sig.entry - hit.price;
      completed.push({ rule: o.sig.rule_id, dir: o.sig.direction, reason: hit.reason, pnl_pts: pnl });
    } else {
      const r = lastTick.get(o.sig.symbol, rthTs) as { price: number } | undefined;
      const px = r?.price ?? o.sig.entry;
      const pnl = o.sig.direction === 'long' ? px - o.sig.entry : o.sig.entry - px;
      completed.push({ rule: o.sig.rule_id, dir: o.sig.direction, reason: 'RTH', pnl_pts: pnl });
    }
    open = null;
  }

  const cohortSigs = cohort === 'tradable' ? sigs.filter(s => s.action === 'OPEN') : sigs;
  for (let i = 0; i < cohortSigs.length; i++) {
    const s = cohortSigs[i]!;
    const etDate = fmtEtDate(s.ts);
    if (prevDate && etDate !== prevDate) closeAtRth(rthCloseTsFor(cohortSigs[i - 1]!.ts));
    prevDate = etDate;

    if (open) {
      const o = open;
      const hit = walkExit(o.sig.symbol, o.sig.ts, s.ts, o.sig.entry, o.sig.direction, o.tp, o.sl);
      if (hit) {
        const pnl = o.sig.direction === 'long' ? hit.price - o.sig.entry : o.sig.entry - hit.price;
        completed.push({ rule: o.sig.rule_id, dir: o.sig.direction, reason: hit.reason, pnl_pts: pnl });
        open = null;
      }
    }
    if (open) {
      if (open.sig.direction === s.direction) continue;  // cooldown for same dir
      // opposing — close at this signal's entry (OPP exit)
      const o = open;
      const pnl = o.sig.direction === 'long' ? s.entry - o.sig.entry : o.sig.entry - s.entry;
      completed.push({ rule: o.sig.rule_id, dir: o.sig.direction, reason: 'OPP', pnl_pts: pnl });
      open = null;
    }
    open = { sig: s, tp: TP, sl: fixedSl(s.rule_id, s.direction) };
  }
  if (prevDate) closeAtRth(rthCloseTsFor(cohortSigs[cohortSigs.length - 1]!.ts));
  return completed;
}

function statsOf(trades: Trade[], label: string) {
  console.log(`── ${label} ──`);
  if (trades.length === 0) { console.log('  (no trades)\n'); return; }

  // Per rule × direction breakdown
  const buckets = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = `${t.rule}/${t.dir}`;
    const arr = buckets.get(key) ?? [];
    arr.push(t);
    buckets.set(key, arr);
  }
  const pad = (s: string, n: number, right = false) => right ? s.padStart(n) : s.padEnd(n);
  console.log('┌──────────────────────────┬─────┬─────┬─────┬────────┬───────────┬──────────┬────────────────────┐');
  console.log('│ Rule / Direction         │  n  │  W  │  L  │   WR   │  Total $  │ EV/trade │ TP/SL/OPP/RTH      │');
  console.log('├──────────────────────────┼─────┼─────┼─────┼────────┼───────────┼──────────┼────────────────────┤');
  let allN = 0, allW = 0, allL = 0, allPts = 0;
  for (const [key, arr] of [...buckets.entries()].sort()) {
    const n = arr.length;
    const w = arr.filter(t => t.pnl_pts > 0).length;
    const l = arr.filter(t => t.pnl_pts < 0).length;
    const pts = arr.reduce((s, t) => s + t.pnl_pts, 0);
    const usd = pts * DOLLAR_PER_PT;
    const wr = (w + l) ? (100 * w / (w + l)).toFixed(1) + '%' : '—';
    const tp = arr.filter(t => t.reason === 'TP').length;
    const sl = arr.filter(t => t.reason === 'SL').length;
    const opp = arr.filter(t => t.reason === 'OPP').length;
    const rth = arr.filter(t => t.reason === 'RTH').length;
    const usdStr = usd >= 0 ? `+$${usd.toFixed(0)}` : `-$${Math.abs(usd).toFixed(0)}`;
    const ev = n ? usd / n : 0;
    const evStr = ev >= 0 ? `+$${ev.toFixed(1)}` : `-$${Math.abs(ev).toFixed(1)}`;
    console.log(`│ ${pad(key, 24)} │ ${pad(String(n),3,true)} │ ${pad(String(w),3,true)} │ ${pad(String(l),3,true)} │ ${pad(wr,6,true)} │ ${pad(usdStr,9,true)} │ ${pad(evStr,8,true)} │ ${pad(`${tp}/${sl}/${opp}/${rth}`, 18)} │`);
    allN += n; allW += w; allL += l; allPts += pts;
  }
  const allUsd = allPts * DOLLAR_PER_PT;
  const allWr = (allW + allL) ? (100 * allW / (allW + allL)).toFixed(1) + '%' : '—';
  const allUsdStr = allUsd >= 0 ? `+$${allUsd.toFixed(0)}` : `-$${Math.abs(allUsd).toFixed(0)}`;
  const allEv = allN ? allUsd / allN : 0;
  const allEvStr = allEv >= 0 ? `+$${allEv.toFixed(1)}` : `-$${Math.abs(allEv).toFixed(1)}`;
  console.log('├──────────────────────────┼─────┼─────┼─────┼────────┼───────────┼──────────┼────────────────────┤');
  console.log(`│ ${pad('TOTAL', 24)} │ ${pad(String(allN),3,true)} │ ${pad(String(allW),3,true)} │ ${pad(String(allL),3,true)} │ ${pad(allWr,6,true)} │ ${pad(allUsdStr,9,true)} │ ${pad(allEvStr,8,true)} │                    │`);
  console.log('└──────────────────────────┴─────┴─────┴─────┴────────┴───────────┴──────────┴────────────────────┘\n');
}

statsOf(simulate('qualified'), 'QUALIFIED cohort (all qualified=1, with cooldown + OPP exits)');
statsOf(simulate('tradable'), 'TRADABLE cohort (action=\'OPEN\' only — what live pipeline traded)');
