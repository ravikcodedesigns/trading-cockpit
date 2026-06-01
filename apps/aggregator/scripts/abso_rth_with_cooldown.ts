/**
 * abso_rth_with_cooldown.ts
 *
 * RTH NQ absorption signals at TP=80/SL=140 with COOLDOWN logic.
 *
 * A trade stays open from its entry until ONE of these resolves it:
 *   (a) +TP touched  → WIN  (pnl = +TP)
 *   (b) -SL touched  → LOSS (pnl = -SL)
 *   (c) An OPPOSITE-direction absorption signal fires (any gate status)
 *         → EXIT-OPP, pnl = price-at-opposite_sig minus entry (signed by dir)
 *   (d) ANY clean-impulse FLIP signal fires (any direction, any gate)
 *         → EXIT-FLIP, pnl = price-at-flip minus entry (signed)
 *   (e) ANY EXPL signal fires (any direction, any gate)
 *         → EXIT-EXPL, pnl = price-at-expl minus entry (signed)
 *   (f) RTH 16:00 ET close       → CLOSE, pnl = closePx - entry (signed)
 *
 * While a trade is open, any new absorption signal (same or opposite dir) is
 * eligible to serve as exit-trigger (c). New SAME-direction absorption signals
 * during cooldown are SKIPPED — they don't start a new trade.
 *
 * Reports: (A) raw absos as entries; (B) qualified absos as entries.
 *   In BOTH reports, the exit-triggers (c/d/e) come from ALL events
 *   regardless of gate, because they represent real regime/structure events.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const TP = 80, SL = 140;
const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

const tickFloor = (xdb.prepare(`SELECT MIN(ts) AS t FROM trades WHERE symbol='NQ'`).get() as {t:number}).t;

interface Sig {
  id: number; ts: number; direction: 'long'|'short';
  rule: string; score: number; entry: number;
  qualified: boolean; payload: string;
}

const reAbsorbedAt = /absorbed at (\d+\.?\d*)/;

function loadAbsos(): Sig[] {
  const rows = tdb.prepare(`
    SELECT s.id, s.ts, s.direction, s.rule_id AS rule, s.score,
           CAST(json_extract(s.payload,'$.entry') AS REAL) AS entry,
           CASE WHEN q.signal_id IS NULL THEN 0 ELSE 1 END AS qualified,
           s.payload
    FROM signals s LEFT JOIN qualified_signals q ON q.signal_id = s.id
    WHERE s.rule_id='absorption' AND s.symbol='NQ' AND s.ts >= ?
      AND time(s.ts/1000,'unixepoch','-4 hours') >= '09:30:00'
      AND time(s.ts/1000,'unixepoch','-4 hours') <  '16:00:00'
    ORDER BY s.ts
  `).all(tickFloor) as any[];
  for (const r of rows) {
    if (!r.entry || r.entry <= 0) {
      const m = (r.payload as string).match(reAbsorbedAt);
      if (m) r.entry = parseFloat(m[1]);
    }
    r.qualified = !!r.qualified;
  }
  return rows.filter(r => r.entry && r.entry > 0) as Sig[];
}

function loadEventSigs(): Sig[] {
  // FLIPs (clean-impulse + Strategy H) and EXPLs (any) — exit triggers.
  const rows = tdb.prepare(`
    SELECT s.id, s.ts, s.direction, s.rule_id AS rule, s.score,
           CAST(json_extract(s.payload,'$.entry') AS REAL) AS entry,
           0 AS qualified, s.payload
    FROM signals s
    WHERE s.symbol='NQ' AND s.ts >= ?
      AND time(s.ts/1000,'unixepoch','-4 hours') >= '09:30:00'
      AND time(s.ts/1000,'unixepoch','-4 hours') <  '16:00:00'
      AND (
        (s.rule_id='clean-impulse' AND json_extract(s.payload,'$.pattern')='FLIP')
        OR s.rule_id='expl'
      )
    ORDER BY s.ts
  `).all(tickFloor) as Sig[];
  return rows;
}

const absos  = loadAbsos();
const events = loadEventSigs();   // FLIPs + EXPLs across all directions

console.log(`Loaded ${absos.length} abso signals (entry recoverable),`);
console.log(`        ${events.filter(e => e.rule==='clean-impulse').length} FLIPs, ${events.filter(e => e.rule==='expl').length} EXPLs.\n`);

function rthCloseMs(tsMs: number): number {
  const d = new Date(tsMs - 4*60*60_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20, 0, 0, 0);
}
function etISO(tsMs: number): string {
  const d = new Date(tsMs - 4*60*60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

// Streamed tick iterator
const stmtTrades = xdb.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol='NQ' AND ts > ? AND ts <= ?
  ORDER BY ts ASC, id ASC
`).raw(true);

// Lookup: price at-or-just-before a given ts (for opposite-sig/flip/expl exits)
const stmtPriceAt = xdb.prepare(`
  SELECT price FROM trades
  WHERE symbol='NQ' AND ts <= ? ORDER BY ts DESC LIMIT 1
`);

type Outcome = 'WIN'|'LOSS'|'EXIT_OPP'|'EXIT_FLIP'|'EXIT_EXPL'|'CLOSE'|'NO_DATA';

interface Row { sig: Sig; outcome: Outcome; pnl: number; exitTs: number; }

function simulate(entries: Sig[], opps: Sig[], allEvents: Sig[]): Row[] {
  // entries: absorption signals to consider as trade entries (already sorted by ts).
  // opps:    all absorption signals (used to find opposite-direction exit triggers).
  // allEvents: FLIPs + EXPLs (sorted by ts).
  const results: Row[] = [];
  let blockUntil = 0; // ts at which the cooldown ends (== the last open trade's exit ts)
  for (const s of entries) {
    if (s.ts < blockUntil) continue;             // cooldown skip
    // Find resolution
    const closeMs = rthCloseMs(s.ts);
    // Candidate cutoff events strictly AFTER s.ts (so a trigger that fires AT s.ts
    // — same instant — does not retro-close the new trade).
    const nextOpp  = opps.find(o => o.id !== s.id && o.ts > s.ts && o.direction !== s.direction);
    // Find via linear scan; arrays are small enough at this scale and time-sorted.
    let nextFlipTs = -1, nextExplTs = -1;
    for (const e of allEvents) {
      if (e.ts <= s.ts) continue;
      if (e.ts > closeMs) break;
      if (e.rule === 'clean-impulse' && nextFlipTs < 0) nextFlipTs = e.ts;
      else if (e.rule === 'expl' && nextExplTs < 0) nextExplTs = e.ts;
      if (nextFlipTs >= 0 && nextExplTs >= 0) break;
    }
    const nextOppTs = (nextOpp && nextOpp.ts <= closeMs) ? nextOpp.ts : -1;

    // Walk ticks to find the FIRST of {TP, SL} that hits, OR until any of
    // the event triggers fire.
    let outcome: Outcome = 'NO_DATA';
    let pnl = 0, exitTs = s.ts, lastPx = NaN, sawTick = false;
    const iter = stmtTrades.iterate(s.ts, closeMs) as IterableIterator<[number, number]>;
    for (const [ts, px] of iter) {
      sawTick = true; lastPx = px;
      // Event triggers that fire before this tick close the trade at the event's price-at-or-before-event-ts.
      // We check at the START of each loop body — if the event's ts <= tick ts, exit on the event first.
      const nextEventTs = Math.min(
        nextOppTs > 0 ? nextOppTs : Infinity,
        nextFlipTs > 0 ? nextFlipTs : Infinity,
        nextExplTs > 0 ? nextExplTs : Infinity,
      );
      if (nextEventTs <= ts) {
        const exitPxRow = stmtPriceAt.get(nextEventTs) as {price:number}|undefined;
        const exitPx = exitPxRow?.price ?? lastPx;
        pnl = s.direction === 'long' ? exitPx - s.entry : s.entry - exitPx;
        exitTs = nextEventTs;
        outcome = nextEventTs === nextOppTs ? 'EXIT_OPP'
                : nextEventTs === nextFlipTs ? 'EXIT_FLIP'
                : 'EXIT_EXPL';
        if ((iter as any).return) (iter as any).return();
        break;
      }
      const fav = s.direction === 'long' ? px - s.entry : s.entry - px;
      const adv = s.direction === 'long' ? s.entry - px : px - s.entry;
      if (adv >= SL) { outcome = 'LOSS'; pnl = -SL; exitTs = ts; if ((iter as any).return) (iter as any).return(); break; }
      if (fav >= TP) { outcome = 'WIN';  pnl = TP;  exitTs = ts; if ((iter as any).return) (iter as any).return(); break; }
    }
    if (outcome === 'NO_DATA' && sawTick) {
      // No TP/SL/event triggered within RTH — exit at last RTH tick
      outcome = 'CLOSE';
      pnl = s.direction === 'long' ? lastPx - s.entry : s.entry - lastPx;
      exitTs = closeMs;
    }
    if (!sawTick) { results.push({ sig: s, outcome: 'NO_DATA', pnl: 0, exitTs: s.ts }); continue; }
    results.push({ sig: s, outcome, pnl, exitTs });
    blockUntil = exitTs;
  }
  return results;
}

function report(label: string, rs: Row[]) {
  const usable = rs.filter(r => r.outcome !== 'NO_DATA');
  const w = usable.filter(r => r.outcome === 'WIN').length;
  const l = usable.filter(r => r.outcome === 'LOSS').length;
  const eo = usable.filter(r => r.outcome === 'EXIT_OPP').length;
  const ef = usable.filter(r => r.outcome === 'EXIT_FLIP').length;
  const ee = usable.filter(r => r.outcome === 'EXIT_EXPL').length;
  const cl = usable.filter(r => r.outcome === 'CLOSE').length;
  const net = usable.reduce((a, r) => a + r.pnl, 0);
  const profitable = usable.filter(r => r.pnl > 0).length;
  console.log(`\n=== ${label} (trades=${usable.length}; skipped-by-cooldown calculated separately; no-data=${rs.length - usable.length}) ===`);
  console.log(`  WIN @+${TP}:    ${w}     contribution +${w*TP}pt`);
  console.log(`  LOSS @-${SL}:   ${l}     contribution -${l*SL}pt`);
  console.log(`  EXIT_OPP:    ${eo}     (opposite-dir abso fired — pnl is at trigger price)`);
  console.log(`  EXIT_FLIP:   ${ef}     (any FLIP fired — pnl is at flip price)`);
  console.log(`  EXIT_EXPL:   ${ee}     (any EXPL fired — pnl is at expl price)`);
  console.log(`  CLOSE @bell: ${cl}     (RTH close, no event)`);
  console.log(`  Net PnL: ${net.toFixed(0)}pt`);
  console.log(`  Profitable: ${profitable}/${usable.length} = ${(profitable/usable.length*100).toFixed(1)}%`);
  console.log(`  PnL/trade:  ${(net/usable.length).toFixed(1)}pt`);

  // Direction split
  const splitLong  = usable.filter(r => r.sig.direction === 'long');
  const splitShort = usable.filter(r => r.sig.direction === 'short');
  function lineFor(label: string, rs: Row[]) {
    if (rs.length === 0) { console.log(`    ${label}: (none)`); return; }
    const w = rs.filter(r => r.outcome === 'WIN').length;
    const l = rs.filter(r => r.outcome === 'LOSS').length;
    const prof = rs.filter(r => r.pnl > 0).length;
    const net = rs.reduce((a, r) => a + r.pnl, 0);
    console.log(`    ${label.padEnd(10)} n=${String(rs.length).padStart(3)}  W=${String(w).padStart(2)} L=${String(l).padStart(2)}  Prof=${prof}/${rs.length}=${(prof/rs.length*100).toFixed(0)}%  Net=${String(net.toFixed(0)).padStart(6)}pt`);
  }
  lineFor('LONG', splitLong);
  lineFor('SHORT', splitShort);

  // Max consec losing trades (any loss-like)
  let cur = 0, best = 0, bestFrom = -1, bestTo = -1, curStart = -1;
  for (let i = 0; i < usable.length; i++) {
    const r = usable[i];
    const losing = r.outcome === 'LOSS' || (r.pnl < 0);
    if (losing) {
      if (cur === 0) curStart = i;
      cur++;
      if (cur > best) { best = cur; bestFrom = curStart; bestTo = i; }
    } else { cur = 0; }
  }
  console.log(`  Max consec losing trades: ${best}  ${bestFrom >= 0 ? `(${etISO(usable[bestFrom].sig.ts)} → ${etISO(usable[bestTo].sig.ts)})` : ''}`);
}

// ---------- RUN ----------
const allOpps = absos; // for entries = qualified or raw, we use ALL absos for opposite triggers

console.log('\n────── REPORT A — RAW ABSORPTION ENTRIES (any score, any gate) ──────');
const rowsA = simulate(absos, allOpps, events);
report('A: cooldown raw absos', rowsA);

console.log('\n────── REPORT B — QUALIFIED ABSORPTION ENTRIES only ──────');
const rowsB = simulate(absos.filter(a => a.qualified), allOpps, events);
report('B: cooldown qualified absos', rowsB);

// Skipped-by-cooldown counts (useful diagnostic)
const enteredAids = new Set<number>(rowsA.map(r => r.sig.id));
const skippedRaw = absos.filter(a => !enteredAids.has(a.id)).length;
const enteredBids = new Set<number>(rowsB.map(r => r.sig.id));
const qualifiedTotal = absos.filter(a => a.qualified).length;
const skippedQ = qualifiedTotal - enteredBids.size;
console.log(`\nSkipped by cooldown (raw):       ${skippedRaw} / ${absos.length}`);
console.log(`Skipped by cooldown (qualified): ${skippedQ} / ${qualifiedTotal}`);

tdb.close(); xdb.close();
