// CRACKER E3 — Gate-2 tradability of top-decile sweep-continuation (per the
// 2026-07-08 E3-GATE2 registration; frozen BEFORE this sim ran).
//
//   Taker sim on banked ms outcomes: enter dir at event_ts+L, exit at event_ts+H.
//   Net(L,H) = dir*(ms_H - ms_L) - 2*halfspread_event - fees_rt.
//   L=0 is the unphysical upper bound that dominates every L<250ms assumption
//   (incl. 100ms); L=250ms is exact from the banked column; L=500ms is dominated
//   by the 250ms cell (impact curve flat/declining after 250ms).
//   Threshold: top-decile intensity from TRAIN days only, applied to VALID;
//   verdict on VALID. Costs: event-time spread rt + all-in micro fees
//   (MNQ 0.74pt rt, MES 0.296pt rt). Secondary: QI-agreement overlay,
//   top-5%/top-2% cuts. Day-block bootstrap CI95 + positive-day counts.
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_e3_gate2.ts
import Database from 'better-sqlite3';
import { dayBoot, splitDays, type Boot } from './cracker_p3_harness.js';

const DB = '/Users/ravikumarbasker/trading-cockpit/data/cracker-events.db';
const TICKPT = 0.25;
const FEES_RT: Record<string, number> = { NQ: 0.74, ES: 0.296 }; // pts, all-in Tradovate micros $1.48rt
const ENTRY_L = [0, 250] as const;
const EXIT_H = [1000, 5000, 10000, 30000] as const;
const COL: Record<number, string> = { 0: '', 250: 'ms_250', 1000: 'ms_1s', 5000: 'ms_5s', 10000: 'ms_10s', 30000: 'ms_30s' };
const CUTS = [10, 5, 2] as const; // top-N%

interface Row { day: string; dir: number; intensity: number; hs: number; qi: number | null; ms: Record<number, number | null>; }

function load(db: Database.Database, sym: string): { rows: Row[]; days: string[] } {
  const raw = db.prepare(`SELECT trading_day day, dir, intensity, spread_ticks, qi, ms_250, ms_1s, ms_5s, ms_10s, ms_30s
    FROM events WHERE store='l3' AND symbol=? AND type='sweep' AND ms_1s IS NOT NULL AND spread_ticks IS NOT NULL
    ORDER BY trading_day, ts`).all(sym) as any[];
  const rows: Row[] = raw.map((r) => ({
    day: r.day, dir: r.dir, intensity: r.intensity, hs: (r.spread_ticks * TICKPT) / 2, qi: r.qi,
    ms: { 250: r.ms_250, 1000: r.ms_1s, 5000: r.ms_5s, 10000: r.ms_10s, 30000: r.ms_30s },
  }));
  return { rows, days: [...new Set(rows.map((r) => r.day))].sort() };
}

function pct(rows: Row[], topPct: number): number {
  const s = rows.map((r) => r.intensity).sort((a, b) => b - a);
  return s[Math.max(0, Math.floor((s.length * topPct) / 100) - 1)]!;
}

// per-event net capture; null if the needed ms columns are missing
function net(r: Row, L: number, H: number, fees: number): number | null {
  const yH = r.ms[H]; if (yH == null) return null;
  let yL = 0;
  if (L > 0) { const v = r.ms[L]; if (v == null) return null; yL = v; }
  return r.dir * (yH - yL) - 2 * r.hs - fees;
}

function cell(rows: Row[], L: number, H: number, fees: number, seed: number) {
  const usable = rows.filter((r) => net(r, L, H, fees) != null);
  if (usable.length < 30) return null;
  const stat = (rs: Row[]) => {
    let s = 0, n = 0;
    for (const r of rs) { const v = net(r, L, H, fees); if (v != null) { s += v; n++; } }
    return n ? s / n : NaN;
  };
  const bt = dayBoot(usable as any, stat as any, seed) as Boot;
  const byDay = new Map<string, number[]>();
  for (const r of usable) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day)!.push(net(r, L, H, fees)!); }
  const posDays = [...byDay.values()].filter((v) => v.reduce((a, b) => a + b, 0) / v.length > 0).length;
  // gross (before costs) for context
  let g = 0, gn = 0;
  for (const r of usable) { const yH = r.ms[H]!; const yL = L > 0 ? r.ms[L]! : 0; g += r.dir * (yH - yL); gn++; }
  return { est: bt.est, ci: bt.ci95, n: usable.length, posDays, days: byDay.size, gross: g / gn };
}

const f = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(3)}`;

function main() {
  const db = new Database(DB, { readonly: true });
  console.log('=== E3 Gate-2 — taker tradability of top-decile sweep-continuation ===');
  for (const sym of ['NQ', 'ES']) {
    const fees = FEES_RT[sym]!;
    const { rows, days } = load(db, sym);
    const { train, valid } = splitDays(days);
    const tr = rows.filter((r) => train.has(r.day)), va = rows.filter((r) => valid.has(r.day));
    console.log(`\n## L3-${sym} (${rows.length} sweeps / ${days.length}d; train ${tr.length}, valid ${va.length}; fees_rt ${fees}pt; avg half-spread ${(rows.reduce((a, r) => a + r.hs, 0) / rows.length).toFixed(3)}pt)`);
    for (const cut of CUTS) {
      const thr = pct(tr, cut); // TRAIN-only threshold, no lookahead
      const vaCut = va.filter((r) => r.intensity >= thr);
      const trCut = tr.filter((r) => r.intensity >= thr);
      console.log(`\n  — top-${cut}% (train thr=${thr.toFixed(2)}; valid n=${vaCut.length}) —`);
      for (const L of ENTRY_L) for (const H of EXIT_H) {
        if (H <= L) continue;
        const cv = cell(vaCut, L, H, fees, 13000 + L + H + cut);
        const ct = cell(trCut, L, H, fees, 14000 + L + H + cut);
        if (!cv) { console.log(`    L=${String(L).padStart(3)}ms H=${String(H / 1000).padStart(2)}s: valid n<30`); continue; }
        const tag = cut === 10 && L === 0 && H === 1000 && sym === 'NQ' ? '  ← PRIMARY' : '';
        console.log(`    L=${String(L).padStart(3)}ms H=${String(H / 1000).padStart(2)}s: valid net ${f(cv.est)}pt CI[${f(cv.ci[0])},${f(cv.ci[1])}] gross ${f(cv.gross)} (${cv.posDays}/${cv.days}d+) | train net ${ct ? f(ct.est) : '—'}${tag}`);
      }
      // QI-agreement overlay (declared secondary): sign(qi) == dir at event time
      const vaQI = vaCut.filter((r) => r.qi != null && Math.sign(r.qi) === r.dir);
      const c1 = cell(vaQI, 0, 1000, fees, 15000 + cut), c2 = cell(vaQI, 250, 1000, fees, 15100 + cut);
      if (c1) console.log(`    QI-overlay (n=${vaQI.length}): L=0 H=1s net ${f(c1.est)} CI[${f(c1.ci[0])},${f(c1.ci[1])}]${c2 ? ` | L=250 H=1s net ${f(c2.est)} CI[${f(c2.ci[0])},${f(c2.ci[1])}]` : ''}`);
      else console.log(`    QI-overlay: n=${vaQI.length} (<30, not testable)`);
    }
  }
  db.close();
}
main();
