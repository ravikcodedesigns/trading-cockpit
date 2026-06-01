/**
 * abso_score90_flip_test.ts
 *
 * For each historical absorption signal at score >= 90, evaluate TWO outcomes:
 *   1. REVERSAL — trade in the signal's stated direction (current V3 behavior)
 *   2. CONTINUATION — trade in the OPPOSITE direction
 *
 * Both at TP=80 / SL=140, RTH-bounded, no cooldown (each signal evaluated independently).
 * Hypothesis: at score >= 90, absorption is degenerating from "exhaustion-reversal" into
 * "continuation-pressure-pause." If true, flipping direction should improve WR + PnL.
 *
 * Buckets reported:
 *   - score 90-94, 95-99, exactly 100
 *   - qualified vs raw
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const TP = 80;
const SL = 140;

const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

const tickFloor = (xdb.prepare(`SELECT MIN(ts) AS t FROM trades WHERE symbol='NQ'`).get() as {t:number}).t;

interface Sig {
  id: number; ts: number; direction: 'long'|'short'; score: number;
  entry: number; qualified: boolean;
}

const reAbsorbedAt = /absorbed at (\d+\.?\d*)/;

const rawRows = tdb.prepare(`
  SELECT s.id, s.ts, s.direction, s.score,
         CAST(json_extract(s.payload,'$.entry') AS REAL) AS entry,
         CASE WHEN q.signal_id IS NULL THEN 0 ELSE 1 END AS qualified,
         s.payload AS payloadRaw
  FROM signals s
  LEFT JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.rule_id = 'absorption' AND s.symbol = 'NQ' AND s.ts >= ?
    AND s.score >= 90
    AND time(s.ts/1000,'unixepoch','-4 hours') >= '09:30:00'
    AND time(s.ts/1000,'unixepoch','-4 hours') <  '16:00:00'
  ORDER BY s.ts
`).all(tickFloor) as Array<{
  id: number; ts: number; direction: string; score: number; entry: number | null;
  qualified: number; payloadRaw: string;
}>;

const sigs: Sig[] = [];
for (const r of rawRows) {
  let entry: number | null = (r.entry !== null && !isNaN(r.entry)) ? r.entry : null;
  if (!entry || entry <= 0) {
    const m = (r.payloadRaw as string).match(reAbsorbedAt);
    if (m) entry = parseFloat(m[1]!);
  }
  if (!entry || entry <= 0) continue;
  sigs.push({
    id: r.id, ts: r.ts,
    direction: r.direction as 'long'|'short',
    score: r.score, entry,
    qualified: !!r.qualified,
  });
}
console.log(`Loaded ${sigs.length} score>=90 absorption signals.\n`);

function rthCloseMs(tsMs: number): number {
  const d = new Date(tsMs - 4*60*60_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20, 0, 0, 0);
}

const stmtTicks = xdb.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol='NQ' AND ts > ? AND ts <= ?
  ORDER BY ts ASC, id ASC
`).raw(true);

type Outcome = 'WIN' | 'LOSS' | 'CLOSE' | 'NO_DATA';
interface Outcomes { reversal: { outcome: Outcome; pnl: number }; continuation: { outcome: Outcome; pnl: number }; }

function resolve(s: Sig, direction: 'long'|'short'): { outcome: Outcome; pnl: number } {
  const closeMs = rthCloseMs(s.ts);
  const iter = stmtTicks.iterate(s.ts, closeMs) as IterableIterator<[number, number]>;
  let lastPx = NaN; let saw = false;
  for (const [, px] of iter) {
    saw = true; lastPx = px;
    const fav = direction === 'long' ? px - s.entry : s.entry - px;
    const adv = -fav;
    if (adv >= SL) { if ((iter as any).return) (iter as any).return(); return { outcome: 'LOSS', pnl: -SL }; }
    if (fav >= TP) { if ((iter as any).return) (iter as any).return(); return { outcome: 'WIN',  pnl: TP  }; }
  }
  if (!saw) return { outcome: 'NO_DATA', pnl: 0 };
  return { outcome: 'CLOSE', pnl: direction === 'long' ? lastPx - s.entry : s.entry - lastPx };
}

const results = sigs.map(s => ({
  sig: s,
  reversal:     resolve(s, s.direction),
  continuation: resolve(s, s.direction === 'long' ? 'short' : 'long'),
})).filter(r => r.reversal.outcome !== 'NO_DATA' && r.continuation.outcome !== 'NO_DATA');

console.log(`Usable (both outcomes resolvable): ${results.length}\n`);

function pad(s: string | number, n: number) { return String(s).padStart(n); }

function summarize(label: string, rs: typeof results) {
  if (rs.length === 0) { console.log(`${label}: (no signals)`); return; }

  function bucket(direction: 'reversal' | 'continuation') {
    const arr = rs.map(r => r[direction]);
    const w = arr.filter(o => o.outcome === 'WIN').length;
    const l = arr.filter(o => o.outcome === 'LOSS').length;
    const c = arr.filter(o => o.outcome === 'CLOSE').length;
    const net = arr.reduce((a, o) => a + o.pnl, 0);
    const prof = arr.filter(o => o.pnl > 0).length;
    return { w, l, c, net, prof, n: arr.length };
  }

  const rev = bucket('reversal');
  const con = bucket('continuation');

  console.log(`\n=== ${label} (n=${rs.length}) ===`);
  console.log(`Direction      W   L   C   Prof%   Net    PnL/sig`);
  console.log(`-------------  --- --- ---  -----  -----   -------`);
  console.log(`REVERSAL       ${pad(rev.w,3)} ${pad(rev.l,3)} ${pad(rev.c,3)}  ${pad((rev.prof/rev.n*100).toFixed(1),5)}%  ${pad(rev.net.toFixed(0),5)}   ${pad((rev.net/rev.n).toFixed(1),6)}pt`);
  console.log(`CONTINUATION   ${pad(con.w,3)} ${pad(con.l,3)} ${pad(con.c,3)}  ${pad((con.prof/con.n*100).toFixed(1),5)}%  ${pad(con.net.toFixed(0),5)}   ${pad((con.net/con.n).toFixed(1),6)}pt`);
  const swing = con.net - rev.net;
  console.log(`Flip improves net by ${swing.toFixed(0)} pt (${swing > 0 ? 'flip wins' : 'reversal wins'})`);
}

// RAW: all score>=90 signals
console.log('────── ALL RAW SCORE>=90 ──────');
summarize('all raw',          results);
summarize('  score 90-94',    results.filter(r => r.sig.score >= 90 && r.sig.score <= 94));
summarize('  score 95-99',    results.filter(r => r.sig.score >= 95 && r.sig.score <= 99));
summarize('  score = 100',    results.filter(r => r.sig.score === 100));

// QUALIFIED
console.log('\n────── QUALIFIED SCORE>=90 ──────');
summarize('all qualified',          results.filter(r => r.sig.qualified));
summarize('  qualified 90-94',      results.filter(r => r.sig.qualified && r.sig.score >= 90 && r.sig.score <= 94));
summarize('  qualified 95-99',      results.filter(r => r.sig.qualified && r.sig.score >= 95 && r.sig.score <= 99));
summarize('  qualified = 100',      results.filter(r => r.sig.qualified && r.sig.score === 100));

// LONGs and SHORTs separately (to see if asymmetry shows up)
console.log('\n────── BY ORIGINAL DIRECTION (raw) ──────');
summarize('raw LONG  signals at score>=90', results.filter(r => r.sig.direction === 'long'));
summarize('raw SHORT signals at score>=90', results.filter(r => r.sig.direction === 'short'));

tdb.close(); xdb.close();
