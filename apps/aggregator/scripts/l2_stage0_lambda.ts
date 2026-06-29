// l2_stage0_lambda.ts — Stage 0 sanity check for the L2 Touch Decider foundation.
// Validates the two primitives before building Stage 1:
//   (1) CqgL2Book reconstructs a usable L2 book from ticks.db (time-accurate CQG).
//   (2) Kyle's λ (divergence.ts, L2-only) is a meaningful "is the level holding?" read.
// Method: for each BrZT0 first-touch-per-minute (RS_TOUCH_SPEC), compute λ + CVD over the
// trailing 30s (causal), then — FOR SANITY ONLY (not the decider) — look 60s forward to see
// if price held/bounced (UP) or broke (DOWN). If λ is systematically LOWER on holds (flow
// absorbed) and HIGHER on breaks (price moves easily per unit flow), the primitive works.
// Run: tsx scripts/l2_stage0_lambda.ts 2026-06-26
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CqgL2Book } from '../src/l2/cqg-l2-book.js';
import { kyleLambda, type Quote } from '../src/l3/divergence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const DAY = process.argv[2] ?? '2026-06-26';
const SYM = 'NQ', TICK = 0.25, LV = 29287.25;   // BrZT0 snapped
const WIN_MS = 30_000;       // λ window (trailing, causal)
const FWD_MS = 60_000;       // forward outcome horizon (sanity only)
const ems = (hm: string) => Date.parse(`${DAY}T${hm}:00-04:00`);
const ec = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false }).slice(-8);
const WARM = ems('09:00'), LO = ems('09:32'), HI = ems('09:54'), FWD_END = ems('09:56');

const db = new Database(`${ROOT}/data/ticks.db`, { readonly: true });
const rows = db.prepare(
  `SELECT ts,'D' k, side, price, size FROM depth WHERE symbol=? AND ts BETWEEN ? AND ?
   UNION ALL SELECT ts,'T', is_bid_aggressor, price, size FROM trades WHERE symbol=? AND size>0 AND ts BETWEEN ? AND ?
   ORDER BY ts, k`).all(SYM, WARM, FWD_END, SYM, WARM, FWD_END) as any[];

const book = new CqgL2Book(TICK);
const qbuf: { ts: number; q: Quote }[] = [];   // best-quote ring for λ
const trades: { ts: number; price: number }[] = [];
let lastQ = '';
let last = NaN, curMin = -1, curOpen = NaN; const touched = new Set<number>();
type Touch = { ts: number; tad: string; lambda: number | null; r2: number; cvd: number; n: number };
const touches: Touch[] = [];

for (const r of rows) {
  const ts = Number(r.ts); const k = r.k; const a = Number(r.side); const price = Number(r.price); const size = Number(r.size);
  book.lastTs = ts;
  if (k === 'D') book.applyDepth(a === 0 ? 'bid' : 'ask', book.intFromPrice(price), size);
  else {
    book.applyTrade(size, a === 1);
    trades.push({ ts, price });
  }
  // sample best-quote into the ring on change
  const q = book.quote();
  if (q) { const key = `${q.bidPx}:${q.bidSz}:${q.askPx}:${q.askSz}`; if (key !== lastQ) { lastQ = key; qbuf.push({ ts, q }); if (qbuf.length > 6000) qbuf.shift(); } }
  if (k !== 'T') continue;

  const mb = Math.floor(ts / 60000);
  if (mb !== curMin) { curMin = mb; curOpen = price; touched.clear(); }
  if (ts >= LO && ts <= HI && !Number.isNaN(last) && !touched.has(mb)) {
    if ((last - LV) * (price - LV) < 0 || price === LV) {
      touched.add(mb);
      const w = qbuf.filter(x => x.ts >= ts - WIN_MS && x.ts <= ts).map(x => x.q);
      const lam = kyleLambda(w);
      touches.push({ ts, tad: curOpen > LV ? 'FROM_UP' : 'FROM_BELOW',
        lambda: lam ? lam.lambda : null, r2: lam ? lam.r2 : 0, cvd: Math.round(book.cvd), n: w.length });
    }
  }
  last = price;
}

// forward outcome (SANITY ONLY): net price move over FWD_MS after the touch
const priceAt = (t: number) => { let p = NaN; for (const x of trades) { if (x.ts <= t) p = x.price; else break; } return p; };
function fwd(ts: number): { dir: string; move: number } {
  const p0 = priceAt(ts), p1 = priceAt(ts + FWD_MS);
  const mv = p1 - p0; return { dir: mv > 5 ? 'UP' : mv < -5 ? 'DOWN' : 'flat', move: mv };
}

console.log(`\n=== STAGE 0 SANITY — Kyle's λ at BrZT0 ${LV} touches · ${SYM} ${DAY} 09:32–09:54 ===`);
console.log(`λ over trailing ${WIN_MS/1000}s of best-quotes (L2, causal); forward ${FWD_MS/1000}s = sanity outcome only\n`);
console.log(`${'touch(ms)'.padEnd(13)}${'TAD'.padEnd(11)}${'λ(Δmid/OFI)'.padEnd(14)}${'r2'.padEnd(7)}${'cvd'.padEnd(8)}${'fwd60s'.padEnd(8)}move`);
const lows: number[] = [], highs: number[] = [];
for (const t of touches) {
  const f = fwd(t.ts);
  const lamStr = t.lambda == null ? 'n/a' : t.lambda.toExponential(2);
  const tcol = (ec(t.ts) + '.' + String(t.ts % 1000).padStart(3, '0')).padEnd(13);
  console.log(`${tcol}${t.tad.padEnd(11)}${lamStr.padEnd(14)}${t.r2.toFixed(2).padEnd(7)}${String(t.cvd).padEnd(8)}${f.dir.padEnd(8)}${f.move >= 0 ? '+' : ''}${f.move.toFixed(1)}`);
  if (t.lambda != null) { if (f.dir === 'UP') lows.push(t.lambda); else if (f.dir === 'DOWN') highs.push(t.lambda); }
}
const avg = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
console.log(`\nλ on HELD/UP touches  (avg): ${avg(lows).toExponential(2)}  (n=${lows.length})`);
console.log(`λ on BROKE/DOWN touches (avg): ${avg(highs).toExponential(2)}  (n=${highs.length})`);
console.log(`→ expect λ(UP) < λ(DOWN) if absorption (low impact) marks holds. Sanity only — n is tiny.`);
process.exit(0);
