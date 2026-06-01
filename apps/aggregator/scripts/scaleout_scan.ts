/**
 * scaleout_scan.ts
 *
 * For every qualified signal, scans tick data forward to determine:
 *   - Did price hit +20pts before SL? (partial TP hit rate)
 *   - Did price hit +80pts before SL? (full TP hit rate)
 *   - Order of events: 20 → 80, 20 → SL, SL only, etc.
 *
 * Reports per strategy/direction and overall.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trDb    = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const TP_FULL    = 80;
const TP_PARTIAL = 20;

function getSL(ruleId: string, direction: string): number | null {
  if (ruleId === 'clean-impulse' && direction === 'long')  return 55;
  if (ruleId === 'clean-impulse' && direction === 'short') return 105;
  if (ruleId === 'expl')                                    return 70;
  if (ruleId === 'absorption' && direction === 'long')      return 140;
  if (ruleId === 'absorption' && direction === 'short')     return 60;
  return null;
}

function rthEnd(ms: number): number {
  const etStr = new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const [m, d, y] = etStr.split('/').map(Number);
  const end = new Date(`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}T00:00:00Z`);
  end.setUTCHours(20, 0, 0, 0);
  if (end.getTime() <= ms) end.setUTCHours(21, 0, 0, 0);
  return end.getTime();
}

function etLabel(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms)).replace(',', '');
}

const entryQuery = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? ORDER BY ts ASC LIMIT 1`
);
const fwdQuery = ticksDb.prepare(
  `SELECT ts, price FROM trades WHERE symbol='NQ' AND ts > ? AND ts <= ? ORDER BY ts ASC`
);

type Scenario =
  | 'SL-only'       // SL hit before +20
  | 'P20→SL'        // hit +20, then stopped at SL before +80
  | 'P20→EOD'       // hit +20, neither +80 nor SL before EOD
  | 'P20→TP'        // hit +20 then +80 (full winner)
  | 'TP-direct'     // hit +80 without first checking +20 (shouldn't happen, sanity check)
  | 'EOD-scratch'   // neither +20 nor SL before EOD
  | 'no-entry';

interface Row {
  label: string;
  dir: string;
  ep: number;
  scenario: Scenario;
  maxGain: number;
  maxDD: number;
  pnlFull: number;   // PnL if only held for full TP
  pnlScaleHalf: number; // PnL of taking half at +20, half at +80 (or SL/EOD)
}

const rows: Row[] = [];

const signals = trDb.prepare(`
  SELECT q.signal_ts, q.rule_id, q.direction, q.score, s.payload
  FROM qualified_signals q
  JOIN signals s ON s.id = q.signal_id
  WHERE q.symbol = 'NQ'
  ORDER BY q.signal_ts ASC
`).all() as any[];

for (const sig of signals) {
  const sl = getSL(sig.rule_id, sig.direction);
  if (!sl) continue;

  const ep = (() => {
    try {
      const p = JSON.parse(sig.payload);
      if (p.entry && p.entry > 1000) return p.entry as number;
    } catch {}
    const row = entryQuery.get(sig.signal_ts) as any;
    return row?.price ?? 0;
  })();

  if (!ep) { rows.push({ label: etLabel(sig.signal_ts), dir: sig.direction, ep: 0, scenario: 'no-entry', maxGain: 0, maxDD: 0, pnlFull: 0, pnlScaleHalf: 0 }); continue; }

  const end = rthEnd(sig.signal_ts);
  const ticks = fwdQuery.all(sig.signal_ts, end) as { ts: number; price: number }[];

  const dir = sig.direction as 'long' | 'short';
  let hit20 = false, hit80 = false, hitSL = false;
  let ts20: number | null = null, ts80: number | null = null, tsSL: number | null = null;
  let maxGain = 0, maxDD = 0;

  for (const t of ticks) {
    const pnl = dir === 'long' ? t.price - ep : ep - t.price;
    if (pnl > maxGain) maxGain = pnl;
    if (-pnl > maxDD)  maxDD  = -pnl;

    if (!hit20 && pnl >= TP_PARTIAL) { hit20 = true; ts20 = t.ts; }
    if (!hit80 && pnl >= TP_FULL)    { hit80 = true; ts80 = t.ts; }
    if (!hitSL && pnl <= -sl)        { hitSL = true; tsSL = t.ts; }
  }

  let scenario: Scenario;
  let pnlFull: number;
  let pnlScaleHalf: number;

  if (!hit20 && !hitSL) {
    scenario = 'EOD-scratch';
    pnlFull = 0;
    pnlScaleHalf = 0;
  } else if (!hit20 && hitSL) {
    scenario = 'SL-only';
    pnlFull = -sl;
    pnlScaleHalf = -sl;
  } else {
    // hit +20 first (before SL)
    if (!hitSL || ts20! <= tsSL!) {
      if (hit80 && (!hitSL || ts80! <= tsSL!)) {
        scenario = 'P20→TP';
        pnlFull = TP_FULL;
        pnlScaleHalf = (TP_PARTIAL + TP_FULL) / 2;
      } else if (hitSL) {
        scenario = 'P20→SL';
        pnlFull = -sl;
        pnlScaleHalf = (TP_PARTIAL - sl) / 2;
      } else {
        scenario = 'P20→EOD';
        pnlFull = 0;
        pnlScaleHalf = TP_PARTIAL / 2;
      }
    } else {
      // SL hit before +20
      scenario = 'SL-only';
      pnlFull = -sl;
      pnlScaleHalf = -sl;
    }
  }

  const tag = `${sig.rule_id === 'clean-impulse' ? 'CF' : sig.rule_id === 'expl' ? 'EXPL' : 'ABSO'}${dir === 'long' ? '↑' : '↓'}`;
  rows.push({ label: `${etLabel(sig.signal_ts)} ${tag}`, dir, ep, scenario, maxGain, maxDD, pnlFull, pnlScaleHalf });
}

// ── Per-signal table ──────────────────────────────────────────────────────────
console.log('\n── Per-signal breakdown ─────────────────────────────────────────────────');
console.log('date+time strat   entry    scenario      maxGain  maxDD   fullPnL  scaleHalf');
console.log('─'.repeat(82));
for (const r of rows) {
  if (r.scenario === 'no-entry') continue;
  console.log(
    r.label.padEnd(24) +
    r.ep.toFixed(2).padStart(9) + '  ' +
    r.scenario.padEnd(14) +
    r.maxGain.toFixed(1).padStart(7) + '  ' +
    r.maxDD.toFixed(1).padStart(6) + '  ' +
    (r.pnlFull >= 0 ? '+' : '') + r.pnlFull.toFixed(0).padStart(6) + '  ' +
    (r.pnlScaleHalf >= 0 ? '+' : '') + r.pnlScaleHalf.toFixed(1).padStart(8)
  );
}

// ── Summary by strategy ───────────────────────────────────────────────────────
type Bucket = {
  n: number;
  hit20: number; hit80: number; sl_only: number; eod: number;
  p20_sl: number; p20_eod: number; p20_tp: number;
  pnlFull: number; pnlScale: number;
};
const byStrat: Record<string, Bucket> = {};

for (const r of rows) {
  if (r.scenario === 'no-entry') continue;
  const key = r.label.split(' ')[2] ?? 'unknown';
  const b = byStrat[key] ?? { n:0, hit20:0, hit80:0, sl_only:0, eod:0, p20_sl:0, p20_eod:0, p20_tp:0, pnlFull:0, pnlScale:0 };
  b.n++;
  b.pnlFull  += r.pnlFull;
  b.pnlScale += r.pnlScaleHalf;
  if (r.scenario === 'SL-only')    { b.sl_only++; }
  if (r.scenario === 'EOD-scratch'){ b.eod++; }
  if (r.scenario === 'P20→SL')     { b.hit20++; b.p20_sl++; }
  if (r.scenario === 'P20→EOD')    { b.hit20++; b.p20_eod++; }
  if (r.scenario === 'P20→TP')     { b.hit20++; b.p20_tp++; b.hit80++; }
  byStrat[key] = b;
}

console.log('\n\n── Summary by strategy ──────────────────────────────────────────────────────');
console.log(
  'strat'.padEnd(9) +
  'n'.padEnd(5) +
  'hit+20%'.padEnd(9) +
  'hit+80%'.padEnd(9) +
  'SL-only%'.padEnd(10) +
  'of+20→TP'.padEnd(10) +
  'of+20→SL'.padEnd(10) +
  'fullPnL'.padEnd(10) +
  'scalePnL'.padEnd(10) +
  'scale-avg'
);
console.log('─'.repeat(90));

const totals: Bucket = { n:0, hit20:0, hit80:0, sl_only:0, eod:0, p20_sl:0, p20_eod:0, p20_tp:0, pnlFull:0, pnlScale:0 };

for (const [key, b] of Object.entries(byStrat).sort()) {
  const pct20    = Math.round(b.hit20   / b.n * 100);
  const pct80    = Math.round(b.hit80   / b.n * 100);
  const pctSL    = Math.round(b.sl_only / b.n * 100);
  const pctPT    = b.hit20 ? Math.round(b.p20_tp  / b.hit20 * 100) : 0;
  const pctPS    = b.hit20 ? Math.round(b.p20_sl  / b.hit20 * 100) : 0;
  const avgScale = (b.pnlScale / b.n).toFixed(1);
  console.log(
    key.padEnd(9) +
    String(b.n).padEnd(5) +
    `${pct20}%`.padEnd(9) +
    `${pct80}%`.padEnd(9) +
    `${pctSL}%`.padEnd(10) +
    `${pctPT}%`.padEnd(10) +
    `${pctPS}%`.padEnd(10) +
    `${b.pnlFull >= 0 ? '+' : ''}${b.pnlFull}`.padEnd(10) +
    `${b.pnlScale >= 0 ? '+' : ''}${b.pnlScale.toFixed(0)}`.padEnd(10) +
    `${avgScale} pts/trade`
  );

  totals.n       += b.n;
  totals.hit20   += b.hit20;
  totals.hit80   += b.hit80;
  totals.sl_only += b.sl_only;
  totals.eod     += b.eod;
  totals.p20_tp  += b.p20_tp;
  totals.p20_sl  += b.p20_sl;
  totals.pnlFull  += b.pnlFull;
  totals.pnlScale += b.pnlScale;
}

console.log('─'.repeat(90));
const t = totals;
console.log(
  'ALL'.padEnd(9) +
  String(t.n).padEnd(5) +
  `${Math.round(t.hit20/t.n*100)}%`.padEnd(9) +
  `${Math.round(t.hit80/t.n*100)}%`.padEnd(9) +
  `${Math.round(t.sl_only/t.n*100)}%`.padEnd(10) +
  `${t.hit20 ? Math.round(t.p20_tp/t.hit20*100) : 0}%`.padEnd(10) +
  `${t.hit20 ? Math.round(t.p20_sl/t.hit20*100) : 0}%`.padEnd(10) +
  `${t.pnlFull >= 0 ? '+' : ''}${t.pnlFull}`.padEnd(10) +
  `${t.pnlScale >= 0 ? '+' : ''}${t.pnlScale.toFixed(0)}`.padEnd(10) +
  `${(t.pnlScale/t.n).toFixed(1)} pts/trade`
);

console.log(`
Legend:
  hit+20%   = % of signals that reached +20pts before SL
  hit+80%   = % of signals that reached +80pts before SL
  SL-only%  = % of signals stopped out before ever seeing +20
  of+20→TP  = of signals that hit +20, % that also hit +80 (full TP)
  of+20→SL  = of signals that hit +20, % that reversed into SL
  fullPnL   = total PnL if you held every signal to full TP/SL (current approach)
  scalePnL  = total PnL if you took half at +20, other half at full TP/SL
  scale-avg = scalePnL / n (avg pts per trade with scale-out)

  SL used: CF↑=55 · CF↓=105 · EXPL=70 · ABSO↑=140 · ABSO↓=60 · TP=80
  scale-out model: 50% at +20, 50% at +80/SL/EOD scratch
`);

trDb.close();
ticksDb.close();
