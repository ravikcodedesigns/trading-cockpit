/**
 * structural_sl_analysis.ts
 *
 * For each gold-tier signal, compares:
 *   A) Structural SL (derived from signal logic / payload)
 *   B) Current fixed SL (55/105/70/140)
 *
 * Classifies each signal as:
 *   - BOTH_WIN      : TP hit before both SLs — no difference
 *   - WINNER_SAVED  : Structural SL would have stopped it out, but current SL let it run to TP
 *                     → "winner filtered out" by structural SL
 *   - LOSER_EARLY   : Both SLs would have been hit; structural SL exits earlier (saves pts)
 *   - LOSER_SAME    : Structural SL >= current SL — no benefit (same or wider)
 *   - EOD           : Neither SL hit by RTH close
 *
 * Structural SL per strategy:
 *   CF↑  : bar low from context_json.stopDist (payload structural stop)
 *           ALSO compare vs macro-low approximation (40pt fixed for comparison)
 *   CF↓  : bar high from context_json.stopDist
 *           ALSO compare vs macro-high approximation (45pt fixed)
 *   EXPL : rangeLow from signals.payload → structural SL dist = entry - rangeLow + 5pt buffer
 *   ABSO : prior-swing approximation = 60pt (best practical structural stop per sweep analysis)
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trDb    = new Database(path.resolve(__dirname, '../../../data/trading.db'),   { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'),     { readonly: true });

const TP = 80;

// ── Helpers ──────────────────────────────────────────────────────────────────

function etParts(ms: number) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
}
function isRTH(ms: number): boolean {
  const p = etParts(ms);
  const wd = p.find(x => x.type === 'weekday')!.value;
  const h  = parseInt(p.find(x => x.type === 'hour')!.value, 10);
  const m  = parseInt(p.find(x => x.type === 'minute')!.value, 10);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(wd) && h * 60 + m >= 570 && h * 60 + m < 960;
}
function rthEnd(ms: number): number {
  const etStr = new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const [m, d, y] = etStr.split('/').map(Number);
  const end = new Date(`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}T00:00:00`);
  end.setUTCHours(20, 0, 0, 0);
  if (end.getTime() <= ms) end.setUTCHours(21, 0, 0, 0);
  return end.getTime();
}

const fwdQuery = ticksDb.prepare(
  `SELECT ts, price FROM trades WHERE symbol='NQ' AND ts > ? AND ts <= ? ORDER BY ts ASC`
);
const entryQuery = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? ORDER BY ts ASC LIMIT 1`
);

function getEntry(ts: number, payload: string, ctxJson: string | null): number {
  const ctx = ctxJson ? JSON.parse(ctxJson) : {};
  if (ctx.entry && ctx.entry > 1000) return ctx.entry;
  const p = JSON.parse(payload);
  if (p.entry && p.entry > 1000) return p.entry;
  const row = entryQuery.get(ts) as any;
  return row?.price ?? 0;
}

type Outcome = 'TP' | 'SL' | 'EOD';
function simulate(ts: number, ep: number, dir: 'long' | 'short', sl: number): Outcome {
  const end    = rthEnd(ts);
  const trades = fwdQuery.all(ts, end) as { ts: number; price: number }[];
  for (const t of trades) {
    const pnl = dir === 'long' ? t.price - ep : ep - t.price;
    if (pnl >= TP)  return 'TP';
    if (pnl <= -sl) return 'SL';
  }
  return 'EOD';
}

// ── Classification ────────────────────────────────────────────────────────────

type Category = 'BOTH_WIN' | 'WINNER_SAVED' | 'LOSER_EARLY' | 'LOSER_SAME' | 'EOD_BOTH';

function classify(
  ts: number, ep: number, dir: 'long' | 'short',
  structuralSL: number, currentSL: number,
): Category {
  const atStructural = simulate(ts, ep, dir, structuralSL);
  const atCurrent    = simulate(ts, ep, dir, currentSL);

  if (atCurrent === 'TP' && atStructural === 'TP') return 'BOTH_WIN';
  if (atCurrent === 'TP' && atStructural === 'SL')  return 'WINNER_SAVED';  // structural wrongly stopped a winner
  if (atCurrent === 'SL' && atStructural === 'SL')  return 'LOSER_EARLY';   // both lose; structural exits sooner (saves pts)
  if (atCurrent === 'SL' && atStructural !== 'SL')  return 'LOSER_SAME';    // current SL is tighter — not applicable here
  return 'EOD_BOTH';
}

// ── Analysis per strategy ─────────────────────────────────────────────────────

interface StrategyConfig {
  ruleId:     string;
  direction:  'long' | 'short';
  label:      string;
  currentSL:  number;
  getStructuralSL: (payload: string, ctxJson: string | null) => number | null;
  structuralLabel: string;
}

const configs: StrategyConfig[] = [
  {
    ruleId: 'clean-impulse', direction: 'long',
    label: 'CF↑  (FLIP LONG)',
    currentSL: 55,
    structuralLabel: 'bar low (stored stopDist)',
    getStructuralSL: (_, ctx) => {
      if (!ctx) return null;
      const c = JSON.parse(ctx);
      return c.stopDist && c.stopDist > 0 ? c.stopDist : null;
    },
  },
  {
    ruleId: 'clean-impulse', direction: 'long',
    label: 'CF↑  (FLIP LONG) — macro-low approx',
    currentSL: 55,
    structuralLabel: 'macro low approx (40pt)',
    getStructuralSL: () => 40,
  },
  {
    ruleId: 'clean-impulse', direction: 'short',
    label: 'CF↓  (FLIP SHORT)',
    currentSL: 105,
    structuralLabel: 'bar high (stored stopDist)',
    getStructuralSL: (_, ctx) => {
      if (!ctx) return null;
      const c = JSON.parse(ctx);
      return c.stopDist && c.stopDist > 0 ? c.stopDist : null;
    },
  },
  {
    ruleId: 'clean-impulse', direction: 'short',
    label: 'CF↓  (FLIP SHORT) — macro-high approx',
    currentSL: 105,
    structuralLabel: 'macro high approx (45pt)',
    getStructuralSL: () => 45,
  },
  {
    ruleId: 'expl', direction: 'long',
    label: 'EXPL LONG',
    currentSL: 70,
    structuralLabel: 'rangeLow − entry + 5pt buffer',
    getStructuralSL: (payload) => {
      const p = JSON.parse(payload);
      if (!p.rangeLow) return null;
      // entry is determined from first tick — we don't have it here yet.
      // Approximation: rangeLow stored; structural SL dist = we'll compute in context
      return null; // handled separately below
    },
  },
  {
    ruleId: 'absorption', direction: 'long',
    label: 'ABSO LONG',
    currentSL: 140,
    structuralLabel: 'prior swing approx (60pt)',
    getStructuralSL: () => 60,
  },
  {
    ruleId: 'absorption', direction: 'short',
    label: 'ABSO SHORT',
    currentSL: 140,
    structuralLabel: 'prior swing approx (60pt)',
    getStructuralSL: () => 60,
  },
];

// ── Load signals ──────────────────────────────────────────────────────────────

const rows = trDb.prepare(`
  SELECT q.signal_id, q.signal_ts AS ts, q.symbol, q.rule_id, q.direction,
         s.payload, q.context_json
  FROM qualified_signals q
  JOIN signals s ON s.id = q.signal_id
  ORDER BY q.signal_ts
`).all() as any[];

// Pre-compute entry prices for all signals
const sigMap = new Map<number, { ep: number; payload: string; ctxJson: string | null }>();
for (const r of rows) {
  if (r.symbol !== 'NQ' || !isRTH(r.ts)) continue;
  const ep = getEntry(r.ts, r.payload, r.context_json);
  if (ep > 0) sigMap.set(r.signal_id, { ep, payload: r.payload, ctxJson: r.context_json });
}

// ── EXPL: compute structural SL from rangeLow vs actual entry ─────────────────

// For EXPL, rangeLow is in the signals.payload but entry comes from the first tick.
// We compute structural SL = entry - rangeLow + 5pt buffer per signal.
const explRows = rows.filter(r => r.rule_id === 'expl' && r.direction === 'long' && r.symbol === 'NQ' && isRTH(r.ts));
const explStructural = new Map<number, number>(); // signal_id → structural SL dist
for (const r of explRows) {
  const d = sigMap.get(r.signal_id);
  if (!d) continue;
  const payload = JSON.parse(r.payload);
  const rangeLow = payload.rangeLow as number | undefined;
  if (rangeLow && d.ep > rangeLow) {
    explStructural.set(r.signal_id, Math.round(d.ep - rangeLow + 5));
  }
}

// ── Run analysis ──────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  STRUCTURAL SL ANALYSIS  —  winners filtered out vs losers saved');
console.log('══════════════════════════════════════════════════════════════════\n');

for (const cfg of configs) {
  const cfgRows = rows.filter(r =>
    r.rule_id === cfg.ruleId &&
    r.direction === cfg.direction &&
    r.symbol === 'NQ' &&
    isRTH(r.ts)
  );

  const counts = { BOTH_WIN: 0, WINNER_SAVED: 0, LOSER_EARLY: 0, LOSER_SAME: 0, EOD_BOTH: 0 };
  const details: string[] = [];
  let nUsed = 0;
  let totalSavedPts = 0;

  for (const r of cfgRows) {
    const d = sigMap.get(r.signal_id);
    if (!d) continue;

    let structuralSL: number | null;

    if (cfg.ruleId === 'expl' && cfg.direction === 'long') {
      structuralSL = explStructural.get(r.signal_id) ?? null;
    } else {
      structuralSL = cfg.getStructuralSL(r.payload, r.context_json);
    }

    if (structuralSL === null || structuralSL <= 0) continue;

    // If structural SL >= current SL, it's wider — not the structural tightening scenario
    // Still classify LOSER_SAME for awareness
    nUsed++;
    const cat = classify(r.ts, d.ep, cfg.direction as 'long' | 'short', structuralSL, cfg.currentSL);
    counts[cat]++;

    if (cat === 'LOSER_EARLY') {
      totalSavedPts += cfg.currentSL - structuralSL;
    }

    const date = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(r.ts)).replace(',', '');

    details.push(`  ${date}  ep=${d.ep.toFixed(2)}  struct=${structuralSL.toFixed(1)}  ${cat}`);
  }

  const winnersSaved = counts.WINNER_SAVED;
  const losersSaved  = counts.LOSER_EARLY;
  const bothWin      = counts.BOTH_WIN;
  const eodBoth      = counts.EOD_BOTH;
  const avgSaved     = losersSaved > 0 ? totalSavedPts / losersSaved : 0;

  console.log(`── ${cfg.label}`);
  console.log(`   Structural SL : ${cfg.structuralLabel}`);
  console.log(`   Current SL    : ${cfg.currentSL}pt  |  TP: ${TP}pt  |  n=${nUsed}`);
  console.log(`   ┌─────────────────────────────────────────────────────┐`);
  console.log(`   │ BOTH WIN (TP before both SLs)     : ${String(bothWin).padStart(3)} signals    │`);
  console.log(`   │ WINNER FILTERED OUT (struct stops  : ${String(winnersSaved).padStart(3)} signals    │`);
  console.log(`   │   a winner — current SL let it TP)                  │`);
  console.log(`   │ LOSER CLOSED EARLY (both SLs hit;  : ${String(losersSaved).padStart(3)} signals    │`);
  console.log(`   │   struct exits at tighter loss)     avg saved ${avgSaved.toFixed(1)}pt │`);
  console.log(`   │ EOD / other                        : ${String(eodBoth).padStart(3)} signals    │`);
  console.log(`   └─────────────────────────────────────────────────────┘`);
  console.log(`   Net trade-off: filter ${winnersSaved} winners to save ${losersSaved} losers from full loss`);
  if (winnersSaved > 0 || losersSaved > 0) {
    const costOfFiltering  = winnersSaved * (cfg.currentSL + TP);   // cost: lost +80 TP + paid -SL instead
    const savingFromEarly  = losersSaved  * avgSaved;                // saving: exit at struct SL not current SL
    console.log(`   Cost (filtered winners)  : ${winnersSaved} × ${(cfg.currentSL + TP).toFixed(0)}pt = ${costOfFiltering.toFixed(0)}pt`);
    console.log(`   Saving (earlier exits)   : ${losersSaved} × ${avgSaved.toFixed(1)}pt avg = ${savingFromEarly.toFixed(0)}pt`);
    const net = savingFromEarly - costOfFiltering;
    console.log(`   Net impact               : ${net >= 0 ? '+' : ''}${net.toFixed(0)}pt vs using current SL`);
  }
  console.log('');

  // Print per-signal detail for WINNER_SAVED so user can see which trades
  const filtered = details.filter(d => d.includes('WINNER_SAVED'));
  if (filtered.length > 0) {
    console.log('   Filtered winners (would have been stopped, then recovered to TP):');
    filtered.forEach(l => console.log(l));
    console.log('');
  }
  const earlyLosers = details.filter(d => d.includes('LOSER_EARLY'));
  if (earlyLosers.length > 0) {
    console.log('   Losers closed early at structural SL:');
    earlyLosers.forEach(l => console.log(l));
    console.log('');
  }
}

trDb.close();
ticksDb.close();
