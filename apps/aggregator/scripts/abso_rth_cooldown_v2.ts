/**
 * abso_rth_cooldown_v2.ts — corrected per user examples.
 *
 * Trade lifecycle (per user's 9 examples):
 *   open: at an absorption signal in the chosen entry set.
 *   exits, in priority of first ts:
 *     - +TP (80pt favorable)  → WIN
 *     - -SL (140pt adverse)   → LOSS
 *     - OPPOSITE-direction absorption signal fires
 *           → pnl = signed(priceAt(oppAbso.ts) − entry)
 *           and that opposite abso opens a NEW trade in its direction.
 *     - OPPOSITE-direction FLIP (clean-impulse with pattern='FLIP') fires
 *           → pnl = signed(priceAt(flip.ts) − entry); does NOT open new trade.
 *     - OPPOSITE-direction EXPL fires
 *           → pnl = signed(priceAt(expl.ts) − entry); does NOT open new trade.
 *     - RTH 16:00 ET close → pnl = signed(closePx − entry)
 *
 *   SAME-direction events (any) are ignored — the trade continues.
 *
 * Reports A (raw absos as entries) and B (qualified absos as entries).
 * In both reports, exit triggers come from ALL events regardless of gate.
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
  rule: string; score: number; entry: number; qualified: boolean;
}

function loadAbsos(): Sig[] {
  const reAbsorbedAt = /absorbed at (\d+\.?\d*)/;
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

function loadEvents(): Sig[] {
  return tdb.prepare(`
    SELECT s.id, s.ts, s.direction, s.rule_id AS rule, s.score,
           CAST(json_extract(s.payload,'$.entry') AS REAL) AS entry,
           0 AS qualified
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
}

const absos  = loadAbsos();
const events = loadEvents();
console.log(`Loaded ${absos.length} absos, ${events.filter(e => e.rule==='clean-impulse').length} FLIPs, ${events.filter(e => e.rule==='expl').length} EXPLs.\n`);

function rthCloseMs(tsMs: number): number {
  const d = new Date(tsMs - 4*60*60_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20, 0, 0, 0);
}
function etISO(tsMs: number): string {
  const d = new Date(tsMs - 4*60*60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

const stmtTrades = xdb.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol='NQ' AND ts > ? AND ts <= ?
  ORDER BY ts ASC, id ASC
`).raw(true);

const stmtPriceAt = xdb.prepare(`
  SELECT price FROM trades
  WHERE symbol='NQ' AND ts <= ? ORDER BY ts DESC LIMIT 1
`);

type Outcome = 'WIN'|'LOSS'|'EXIT_OPP_ABSO'|'EXIT_OPP_FLIP'|'EXIT_OPP_EXPL'|'CLOSE'|'NO_DATA';
interface Row { sig: Sig; outcome: Outcome; pnl: number; exitTs: number; }

function findNextOpposite<T extends {ts:number; direction:string}>(arr: T[], afterTs: number, oppDir: string): T | null {
  // arr is sorted by ts ASC.
  for (const x of arr) {
    if (x.ts <= afterTs) continue;
    if (x.direction === oppDir) return x;
  }
  return null;
}
function findNextOppositeAbso(after: number, oppDir: string, excludeId: number): Sig | null {
  for (const a of absos) {
    if (a.ts <= after) continue;
    if (a.id === excludeId) continue;
    if (a.direction === oppDir) return a;
  }
  return null;
}
function findNextOppositeFlip(after: number, oppDir: string): Sig | null {
  for (const e of events) {
    if (e.ts <= after) continue;
    if (e.rule === 'clean-impulse' && e.direction === oppDir) return e;
  }
  return null;
}
function findNextOppositeExpl(after: number, oppDir: string): Sig | null {
  for (const e of events) {
    if (e.ts <= after) continue;
    if (e.rule === 'expl' && e.direction === oppDir) return e;
  }
  return null;
}

function simulate(entrySet: Sig[]): Row[] {
  const results: Row[] = [];
  let blockUntil = 0;
  // Walk entrySet in ts order; for the "opposite-abso opens a new trade" rule,
  // we additionally allow any opposite abso (even one outside entrySet, e.g.
  // a silenced abso in qualified mode) to TRIGGER an exit but not a new entry.
  // Since opposite-abso EXIT and OPEN are coupled when within entrySet, we
  // model it as: closing-event sets blockUntil = exit.ts; the next entrySet
  // member at or after that ts can enter.
  for (const s of entrySet) {
    if (s.ts < blockUntil) continue;
    const oppDir = s.direction === 'long' ? 'short' : 'long';
    const closeMs = rthCloseMs(s.ts);

    const oppAbso = findNextOppositeAbso(s.ts, oppDir, s.id);
    const oppFlip = findNextOppositeFlip(s.ts, oppDir);
    const oppExpl = findNextOppositeExpl(s.ts, oppDir);
    const oppAbsoTs = (oppAbso && oppAbso.ts <= closeMs) ? oppAbso.ts : Infinity;
    const oppFlipTs = (oppFlip && oppFlip.ts <= closeMs) ? oppFlip.ts : Infinity;
    const oppExplTs = (oppExpl && oppExpl.ts <= closeMs) ? oppExpl.ts : Infinity;
    const earliestEventTs = Math.min(oppAbsoTs, oppFlipTs, oppExplTs);

    let outcome: Outcome = 'NO_DATA';
    let pnl = 0, exitTs = s.ts, lastPx = NaN, saw = false;
    const iter = stmtTrades.iterate(s.ts, closeMs) as IterableIterator<[number, number]>;
    for (const [ts, px] of iter) {
      saw = true; lastPx = px;
      // First, check if an opposite-direction event fired BEFORE this tick.
      if (earliestEventTs <= ts) {
        const row = stmtPriceAt.get(earliestEventTs) as {price:number}|undefined;
        const exitPx = row?.price ?? lastPx;
        pnl = s.direction === 'long' ? exitPx - s.entry : s.entry - exitPx;
        exitTs = earliestEventTs;
        outcome = earliestEventTs === oppAbsoTs ? 'EXIT_OPP_ABSO'
                : earliestEventTs === oppFlipTs ? 'EXIT_OPP_FLIP'
                : 'EXIT_OPP_EXPL';
        if ((iter as any).return) (iter as any).return();
        break;
      }
      const fav = s.direction === 'long' ? px - s.entry : s.entry - px;
      const adv = s.direction === 'long' ? s.entry - px : px - s.entry;
      if (adv >= SL) { outcome='LOSS'; pnl=-SL; exitTs=ts; if((iter as any).return)(iter as any).return(); break; }
      if (fav >= TP) { outcome='WIN';  pnl= TP; exitTs=ts; if((iter as any).return)(iter as any).return(); break; }
    }
    if (outcome === 'NO_DATA') {
      if (!saw) { results.push({ sig: s, outcome: 'NO_DATA', pnl: 0, exitTs: s.ts }); continue; }
      outcome = 'CLOSE';
      pnl = s.direction === 'long' ? lastPx - s.entry : s.entry - lastPx;
      exitTs = closeMs;
    }
    results.push({ sig: s, outcome, pnl, exitTs });
    blockUntil = exitTs;
  }
  return results;
}

function report(label: string, rs: Row[]) {
  const usable = rs.filter(r => r.outcome !== 'NO_DATA');
  const w = usable.filter(r => r.outcome === 'WIN').length;
  const l = usable.filter(r => r.outcome === 'LOSS').length;
  const ea = usable.filter(r => r.outcome === 'EXIT_OPP_ABSO').length;
  const ef = usable.filter(r => r.outcome === 'EXIT_OPP_FLIP').length;
  const ee = usable.filter(r => r.outcome === 'EXIT_OPP_EXPL').length;
  const cl = usable.filter(r => r.outcome === 'CLOSE').length;
  const net = usable.reduce((a, r) => a + r.pnl, 0);
  const profitable = usable.filter(r => r.pnl > 0).length;
  console.log(`\n=== ${label} (trades=${usable.length}; no-data=${rs.length - usable.length}) ===`);
  console.log(`  WIN @+${TP}:          ${w}     contribution +${w*TP}pt`);
  console.log(`  LOSS @-${SL}:         ${l}     contribution ${-l*SL}pt`);
  console.log(`  EXIT_OPP_ABSO:    ${ea}     (opp-dir abso, pnl at trigger price)`);
  console.log(`  EXIT_OPP_FLIP:    ${ef}     (opp-dir FLIP, pnl at trigger price)`);
  console.log(`  EXIT_OPP_EXPL:    ${ee}     (opp-dir EXPL, pnl at trigger price)`);
  console.log(`  CLOSE @bell:      ${cl}     (RTH close, no opp event)`);
  console.log(`  Net PnL: ${net.toFixed(0)}pt`);
  console.log(`  Profitable: ${profitable}/${usable.length} = ${(profitable/usable.length*100).toFixed(1)}%`);
  console.log(`  PnL / trade: ${(net/usable.length).toFixed(1)}pt`);

  const splitLong  = usable.filter(r => r.sig.direction === 'long');
  const splitShort = usable.filter(r => r.sig.direction === 'short');
  function lineFor(label: string, rs: Row[]) {
    if (rs.length === 0) { console.log(`    ${label}: (none)`); return; }
    const w = rs.filter(r => r.outcome === 'WIN').length;
    const l = rs.filter(r => r.outcome === 'LOSS').length;
    const prof = rs.filter(r => r.pnl > 0).length;
    const net = rs.reduce((a, r) => a + r.pnl, 0);
    console.log(`    ${label.padEnd(10)} n=${String(rs.length).padStart(3)}  W=${String(w).padStart(2)} L=${String(l).padStart(2)}  Prof=${prof}/${rs.length}=${(prof/rs.length*100).toFixed(0)}%  Net=${String(net.toFixed(0)).padStart(6)}pt  PnL/trade=${(net/rs.length).toFixed(1)}pt`);
  }
  lineFor('LONG', splitLong);
  lineFor('SHORT', splitShort);

  // Max consec losing trades (any pnl < 0 OR LOSS)
  let cur=0, best=0, bestFrom=-1, bestTo=-1, curStart=-1;
  for (let i=0; i<usable.length; i++) {
    const losing = usable[i].pnl < 0 || usable[i].outcome === 'LOSS';
    if (losing) {
      if (cur===0) curStart=i;
      cur++;
      if (cur > best) { best=cur; bestFrom=curStart; bestTo=i; }
    } else cur = 0;
  }
  console.log(`  Max consec losing trades: ${best}${bestFrom>=0 ? `  (${etISO(usable[bestFrom].sig.ts)} → ${etISO(usable[bestTo].sig.ts)})` : ''}`);

  // -140 SL hits only
  let cur2=0, best2=0;
  for (const r of usable) {
    if (r.outcome === 'LOSS') { cur2++; if (cur2>best2) best2 = cur2; } else cur2 = 0;
  }
  console.log(`  Max consec -${SL} stops:  ${best2}`);
}

// ---------- RUN ----------
console.log('────── REPORT A — RAW absorption entries ──────');
const rowsA = simulate(absos);
report('A: raw absos (all gates)', rowsA);

console.log('\n────── REPORT B — QUALIFIED absorption entries ──────');
const rowsB = simulate(absos.filter(a => a.qualified));
report('B: qualified absos', rowsB);

// Diagnostics
const enteredA = new Set(rowsA.map(r => r.sig.id));
const enteredB = new Set(rowsB.map(r => r.sig.id));
console.log(`\nEntered (raw):       ${enteredA.size} / ${absos.length}  (cooldown-skipped: ${absos.length - enteredA.size})`);
console.log(`Entered (qualified): ${enteredB.size} / ${absos.filter(a => a.qualified).length}  (cooldown-skipped: ${absos.filter(a => a.qualified).length - enteredB.size})`);

tdb.close(); xdb.close();
