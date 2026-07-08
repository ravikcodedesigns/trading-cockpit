// CRACKER Phase E2 — verdicts for the five frozen event detectors.
//
// SPEC (per the frozen tape-events.ts E0/E2 header; nothing chosen post-hoc):
//   Outcome y(h) = dir × (mo(h) − drift·h) — continuation in the EVENT's
//   direction, drift-adjusted, points. No sign imposed (fade vs continue is
//   the question). Declared horizons 1m/5m; 15/30m reported.
//   Screens: absorption/imbalance → L2-NQ (44d) primary; sweep/replenishment/
//   wall-pull → L3-NQ (13d) primary (L2 has no lifecycle). ES = consistency.
//   Per declared cell: chronological 60/40 day split; dose-response IC
//   (Spearman of intensity vs y) with day-block bootstrap; verdict per the
//   frozen harness rules (EDGE / NULL / UNDERPOWERED, ρ* = 0.05).
//   FAMILY CONTROL: BH-FDR q = 0.10 across the 10 declared cells using
//   two-sided full-sample bootstrap p (B = 2000).
//   Descriptive (non-gating): mean y per detector; structure-zone split
//   (near = dist_level_pts ≤ σ_ev — the F5b conditioner at event level).
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_e2_verdicts.ts
import Database from 'better-sqlite3';
import { dayBoot, weightedSpearman, splitDays, verdict, excl0, fmt, lcg, type Boot } from './cracker_p3_harness.js';

const DB = '/Users/ravikumarbasker/trading-cockpit/data/cracker-events.db';
const HORIZONS = [1, 5, 15, 30] as const;
const DECLARED = [1, 5];
const PRIMARY: Record<string, ['l2' | 'l3', string]> = {
  absorption: ['l2', 'NQ'], imbalance: ['l2', 'NQ'],
  sweep: ['l3', 'NQ'], replenishment: ['l3', 'NQ'], wallpull: ['l3', 'NQ'],
};
const CONSIST: Record<string, ['l2' | 'l3', string]> = {
  absorption: ['l2', 'ES'], imbalance: ['l2', 'ES'],
  sweep: ['l3', 'ES'], replenishment: ['l3', 'ES'], wallpull: ['l3', 'ES'],
};

interface ERow { day: string; intensity: number; sigma: number; dist: number | null; y: Record<number, number | null>; uniq: number; }

function load(db: Database.Database, store: string, sym: string, type: string): { rows: ERow[]; days: string[] } {
  const raw = db.prepare(`SELECT trading_day day, dir, intensity, sigma_ev sigma, dist_level_pts dist,
      mo_1m, mo_5m, mo_15m, mo_30m, drift_pt_min drift
    FROM events WHERE store=? AND symbol=? AND type=? ORDER BY trading_day, ts`).all(store, sym, type) as any[];
  const rows: ERow[] = raw.map((r) => {
    const y: Record<number, number | null> = {};
    for (const h of HORIZONS) { const mo = r[`mo_${h}m`]; y[h] = mo == null ? null : r.dir * (mo - (r.drift ?? 0) * h); }
    return { day: r.day, intensity: r.intensity, sigma: r.sigma, dist: r.dist, y, uniq: 1 };
  });
  return { rows, days: [...new Set(rows.map((r) => r.day))].sort() };
}

const icStat = (h: number) => (rs: ERow[]): number => {
  const x: number[] = [], yv: number[] = [], w: number[] = [];
  for (const r of rs) { if (r.y[h] == null) continue; x.push(r.intensity); yv.push(r.y[h]!); w.push(1); }
  return x.length >= 30 ? weightedSpearman(x, yv, w) : NaN;
};
const meanStat = (h: number) => (rs: ERow[]): number => {
  let s = 0, n = 0;
  for (const r of rs) if (r.y[h] != null) { s += r.y[h]!; n++; }
  return n ? s / n : NaN;
};

/** Two-sided bootstrap p for the full-sample IC (day-block, B=2000). */
function pTwoSided(rows: ERow[], h: number, seed: number): { est: number; p: number } {
  const byDay = new Map<string, ERow[]>();
  for (const r of rows) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day)!.push(r); }
  const days = [...byDay.keys()].sort();
  const est = icStat(h)(rows);
  const rnd = lcg(seed);
  let lo = 0, hi = 0, n = 0;
  for (let b = 0; b < 2000; b++) {
    const rs: ERow[] = [];
    for (let i = 0; i < days.length; i++) rs.push(...byDay.get(days[Math.floor(rnd() * days.length)]!)!);
    const v = icStat(h)(rs);
    if (!isFinite(v)) continue;
    n++; if (v <= 0) lo++; if (v >= 0) hi++;
  }
  return { est, p: Math.max(1 / Math.max(n, 1), 2 * Math.min(lo, hi) / Math.max(n, 1)) };
}

function main() {
  const db = new Database(DB, { readonly: true });
  console.log('=== P·E2 — event-detector verdicts (dose-response, frozen E0 spec) ===');
  const family: { name: string; p: number; est: number }[] = [];

  for (const type of Object.keys(PRIMARY)) {
    const [store, sym] = PRIMARY[type]!;
    const { rows, days } = load(db, store, sym, type);
    const [cs, csym] = CONSIST[type]!;
    const cons = load(db, cs, csym, type);
    console.log(`\n## ${type} — primary ${store.toUpperCase()}-${sym} (${rows.length} events / ${days.length}d) · consistency ${cs.toUpperCase()}-${csym} (${cons.rows.length})`);
    if (rows.length < 60) { console.log('  insufficient events — UNDERPOWERED by construction'); continue; }
    const { train, valid } = splitDays(days);
    const tr = rows.filter((r) => train.has(r.day)), va = rows.filter((r) => valid.has(r.day));

    for (const h of HORIZONS) {
      const declared = DECLARED.includes(h);
      if (declared) {
        const icTr = dayBoot(tr as any, icStat(h) as any, 9100 + h) as Boot;
        const icVa = dayBoot(va as any, icStat(h) as any, 9200 + h) as Boot;
        icTr.n = tr.filter((r) => r.y[h] != null).length; icVa.n = va.filter((r) => r.y[h] != null).length;
        const v = verdict(sym, h, icTr, icVa, true, 'ic');
        const { est, p } = pTwoSided(rows, h, 9300 + h);
        family.push({ name: `${type}@${h}m`, p, est });
        const consIc = icStat(h)(cons.rows);
        console.log(`  IC(${String(h).padStart(2)}m): train ${fmt(icTr)} | valid ${fmt(icVa)} | full ${est >= 0 ? '+' : ''}${est.toFixed(3)} p=${p.toFixed(4)} | consist ${isFinite(consIc) ? consIc.toFixed(3) : '—'}  → ${v} [declared]`);
      } else {
        const icFull = icStat(h)(rows);
        console.log(`  IC(${String(h).padStart(2)}m): full ${isFinite(icFull) ? (icFull >= 0 ? '+' : '') + icFull.toFixed(3) : '—'}`);
      }
      // descriptive: mean directional markout + structure split at declared cells
      if (declared) {
        const mAll = dayBoot(rows as any, meanStat(h) as any, 9400 + h) as Boot;
        const near = rows.filter((r) => r.dist != null && r.dist <= r.sigma);
        const far = rows.filter((r) => !(r.dist != null && r.dist <= r.sigma));
        console.log(`    mean y(${h}m): ${fmt(mAll, 'pt')} | near-structure ${meanStat(h)(near).toFixed(3)}pt (n=${near.length}) vs open-tape ${meanStat(h)(far).toFixed(3)}pt (n=${far.length})  (descriptive)`);
      }
    }
  }

  console.log(`\n— BH-FDR q=0.10 across the ${family.length}-cell declared family —`);
  const sorted = [...family].sort((a, b) => a.p - b.p);
  let kMax = 0;
  sorted.forEach((r, i) => { if (r.p <= (0.10 * (i + 1)) / sorted.length) kMax = i + 1; });
  sorted.forEach((r, i) => console.log(`  ${r.name.padEnd(20)} p=${r.p.toFixed(4)} IC=${r.est >= 0 ? '+' : ''}${r.est.toFixed(3)} (rank ${i + 1}/${sorted.length}, thr ${((0.10 * (i + 1)) / sorted.length).toFixed(4)}) → ${i < kMax ? '★ FAMILY-SIGNIFICANT' : 'ns'}`));
  db.close();
}
main();
