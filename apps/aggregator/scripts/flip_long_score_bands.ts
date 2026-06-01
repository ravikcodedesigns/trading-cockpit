/**
 * flip_long_score_bands.ts — qualified FLIP LONG win-rate and PnL by score band.
 *
 * Each qualified FLIP LONG is evaluated independently at TP=80 / SL=55 over
 * RTH (no cooldown — we want pure signal-quality bucketing, not trade flow).
 *
 * Outcome resolution: walk ticks forward from signal ts to RTH close; the
 * first crossing of TP or SL wins. If neither hits before RTH close, exit at
 * the closing tick (CLOSE @ bell).
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const TP = 80;
const SL = 55;

const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

const tickFloor = (xdb.prepare(`SELECT MIN(ts) AS t FROM trades WHERE symbol='NQ'`).get() as {t:number}).t;

interface Sig { id: number; ts: number; score: number; entry: number; }

const sigs = tdb.prepare(`
  SELECT s.id, s.ts, s.score,
         CAST(json_extract(s.payload,'$.entry') AS REAL) AS entry
  FROM signals s
  INNER JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.symbol='NQ'
    AND s.rule_id='clean-impulse'
    AND s.direction='long'
    AND json_extract(s.payload,'$.pattern')='FLIP'
    AND s.ts >= ?
    AND time(s.ts/1000,'unixepoch','-4 hours') >= '09:30:00'
    AND time(s.ts/1000,'unixepoch','-4 hours') <  '16:00:00'
  ORDER BY s.ts
`).all(tickFloor) as Sig[];

console.log(`Loaded ${sigs.length} qualified FLIP LONGs.\n`);

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
interface Result { sig: Sig; outcome: Outcome; pnl: number; }

const results: Result[] = sigs.map(s => {
  if (!s.entry || s.entry <= 0) return { sig: s, outcome: 'NO_DATA' as const, pnl: 0 };
  const closeMs = rthCloseMs(s.ts);
  const iter = stmtTicks.iterate(s.ts, closeMs) as IterableIterator<[number, number]>;
  let lastPx = NaN, saw = false;
  for (const [, px] of iter) {
    saw = true; lastPx = px;
    const fav = px - s.entry;
    const adv = s.entry - px;
    if (adv >= SL) { if ((iter as any).return) (iter as any).return(); return { sig: s, outcome: 'LOSS', pnl: -SL }; }
    if (fav >= TP) { if ((iter as any).return) (iter as any).return(); return { sig: s, outcome: 'WIN',  pnl: TP  }; }
  }
  if (!saw) return { sig: s, outcome: 'NO_DATA', pnl: 0 };
  return { sig: s, outcome: 'CLOSE', pnl: lastPx - s.entry };
});

function summarize(label: string, rs: Result[]) {
  const usable = rs.filter(r => r.outcome !== 'NO_DATA');
  if (usable.length === 0) { console.log(`  ${label.padEnd(18)} (no signals)`); return; }
  const w = usable.filter(r => r.outcome === 'WIN').length;
  const l = usable.filter(r => r.outcome === 'LOSS').length;
  const c = usable.filter(r => r.outcome === 'CLOSE').length;
  const closeWin  = usable.filter(r => r.outcome === 'CLOSE' && r.pnl > 0).length;
  const closeLoss = usable.filter(r => r.outcome === 'CLOSE' && r.pnl < 0).length;
  const net = usable.reduce((a, r) => a + r.pnl, 0);
  const prof = usable.filter(r => r.pnl > 0).length;
  const wr   = (prof / usable.length * 100).toFixed(1);
  const ppt  = (net / usable.length).toFixed(1);
  console.log(
    `  ${label.padEnd(18)} n=${String(usable.length).padStart(3)}  W=${String(w).padStart(2)} L=${String(l).padStart(2)} C=${String(c).padStart(2)} (cW=${closeWin} cL=${closeLoss})  Prof=${String(prof).padStart(2)}/${String(usable.length).padStart(2)}=${wr.padStart(4)}%  Net=${String(net.toFixed(0)).padStart(6)}pt  PnL/sig=${ppt.padStart(6)}pt`
  );
}

console.log(`Qualified FLIP LONGs — TP=${TP} / SL=${SL}, RTH-bounded, NO cooldown\n`);
console.log('OVERALL');
summarize('all qualified', results);

console.log('\nBY EXACT SCORE');
const distinctScores = Array.from(new Set(results.map(r => r.sig.score))).sort((a,b) => a - b);
for (const s of distinctScores) {
  summarize(`score = ${s}`, results.filter(r => r.sig.score === s));
}

console.log('\nBY SCORE BAND');
const bands: Array<{ label: string; lo: number; hi: number }> = [
  { label: '60–69',  lo: 60,  hi: 69  },
  { label: '70–79',  lo: 70,  hi: 79  },
  { label: '80–89',  lo: 80,  hi: 89  },
  { label: '90–99',  lo: 90,  hi: 99  },
  { label: '100',    lo: 100, hi: 100 },
];
for (const b of bands) {
  summarize(`score ${b.label}`, results.filter(r => r.sig.score >= b.lo && r.sig.score <= b.hi));
}

console.log('\nBY CUMULATIVE FLOOR (>=)');
for (const t of [60, 70, 75, 80, 85, 90, 95, 100]) {
  summarize(`score >= ${t}`, results.filter(r => r.sig.score >= t));
}

tdb.close(); xdb.close();
