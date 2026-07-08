// CRACKER E2c — verdicts for the E0.2 shape batch (per the 2026-07-08
// registration in tape-events.ts / cracker-registrations.json; frozen BEFORE
// the outcome scan ran).
//
//   DETECTORS: stackimb, wallcluster. TWO-SIDED (both mechanism signs live).
//   DECLARED CELLS (8, BH q=0.10): per detector {1s, 10s} ms (y = dir × ms_h,
//   mid-based, no drift adj) + {1m, 5m} minute (y = dir × (mo_h − drift·h)).
//   Primary screen L2-NQ; PRE-DECLARED FALLBACK: if a detector is event-starved
//   on L2-NQ (<60 events), L3-NQ carries its verdict (wall-cluster smoke showed
//   L2 sparsity). All other datasets = sign-consistency. Chrono 60/40 split,
//   dose-response IC, day-block bootstrap, harness verdicts.
//   DISCOVERY DAYS ≤ 2026-07-07 (the standing lockbox boundary).
//   Descriptive: mean y in half-spreads at ms cells; near-structure split.
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_e2c_verdicts.ts
import Database from 'better-sqlite3';
import { dayBoot, weightedSpearman, splitDays, verdict, fmt, lcg, type Boot } from './cracker_p3_harness.js';

const DB = '/Users/ravikumarbasker/trading-cockpit/data/cracker-events.db';
const FREEZE = '2026-07-07';
const TICKPT = 0.25;
const TYPES = ['stackimb', 'wallcluster'] as const;
const DATASETS: ['l2' | 'l3', string][] = [['l2', 'NQ'], ['l3', 'NQ'], ['l2', 'ES'], ['l3', 'ES']];
// declared cells: ms in ms-units, minute in minutes
const MS_CELLS = [1000, 10000] as const;
const MIN_CELLS = [1, 5] as const;
const MS_COL: Record<number, string> = { 1000: 'ms_1s', 10000: 'ms_10s' };

interface ERow { day: string; intensity: number; sigma: number; dist: number | null; spread: number | null; y: Record<string, number | null>; uniq: number; }

function load(db: Database.Database, store: string, sym: string, type: string): { rows: ERow[]; days: string[] } {
  const raw = db.prepare(`SELECT trading_day day, dir, intensity, sigma_ev sigma, dist_level_pts dist, spread_ticks spread,
      mo_1m, mo_5m, drift_pt_min drift, ms_1s, ms_10s
    FROM events WHERE store=? AND symbol=? AND type=? AND trading_day <= ? ORDER BY trading_day, ts`).all(store, sym, type, FREEZE) as any[];
  const rows: ERow[] = raw.map((r) => {
    const y: Record<string, number | null> = {};
    for (const h of MS_CELLS) { const v = r[MS_COL[h]!]; y[`ms${h}`] = v == null ? null : r.dir * v; }
    for (const h of MIN_CELLS) { const mo = r[`mo_${h}m`]; y[`m${h}`] = mo == null ? null : r.dir * (mo - (r.drift ?? 0) * h); }
    return { day: r.day, intensity: r.intensity, sigma: r.sigma, dist: r.dist, spread: r.spread, y, uniq: 1 };
  });
  return { rows, days: [...new Set(rows.map((r) => r.day))].sort() };
}

const icStat = (k: string) => (rs: ERow[]): number => {
  const x: number[] = [], yv: number[] = [], w: number[] = [];
  for (const r of rs) { if (r.y[k] == null) continue; x.push(r.intensity); yv.push(r.y[k]!); w.push(1); }
  return x.length >= 30 ? weightedSpearman(x, yv, w) : NaN;
};
const meanStat = (k: string) => (rs: ERow[]): number => {
  let s = 0, n = 0;
  for (const r of rs) if (r.y[k] != null) { s += r.y[k]!; n++; }
  return n ? s / n : NaN;
};

function pTwoSided(rows: ERow[], k: string, seed: number): { est: number; p: number } {
  const byDay = new Map<string, ERow[]>();
  for (const r of rows) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day)!.push(r); }
  const days = [...byDay.keys()].sort();
  const est = icStat(k)(rows);
  const rnd = lcg(seed);
  let lo = 0, hi = 0, n = 0;
  for (let b = 0; b < 2000; b++) {
    const rs: ERow[] = [];
    for (let i = 0; i < days.length; i++) rs.push(...byDay.get(days[Math.floor(rnd() * days.length)]!)!);
    const v = icStat(k)(rs);
    if (!isFinite(v)) continue;
    n++; if (v <= 0) lo++; if (v >= 0) hi++;
  }
  return { est, p: Math.max(1 / Math.max(n, 1), 2 * Math.min(lo, hi) / Math.max(n, 1)) };
}

function main() {
  const db = new Database(DB, { readonly: true });
  console.log(`=== E2c — E0.2 shape-batch verdicts (discovery ≤ ${FREEZE}) ===`);
  const family: { name: string; p: number; est: number }[] = [];

  for (const type of TYPES) {
    // primary = L2-NQ; pre-declared fallback to L3-NQ if event-starved
    let [store, sym]: ['l2' | 'l3', string] = ['l2', 'NQ'];
    let { rows, days } = load(db, store, sym, type);
    if (rows.length < 60) {
      console.log(`\n## ${type}: L2-NQ starved (${rows.length} events) → L3-NQ carries the verdict [pre-declared]`);
      [store, sym] = ['l3', 'NQ'];
      ({ rows, days } = load(db, store, sym, type));
    }
    const consist = DATASETS.filter(([s, y]) => !(s === store && y === sym))
      .map(([s, y]) => ({ key: `${s.toUpperCase()}-${y}`, ...load(db, s, y, type) }));
    console.log(`\n## ${type} — primary ${store.toUpperCase()}-${sym} (${rows.length} events / ${days.length}d) · consistency ${consist.map((c) => `${c.key}:${c.rows.length}`).join(' ')}`);
    if (rows.length < 60) { console.log('  insufficient events everywhere — UNDERPOWERED by construction'); continue; }
    if (days.length < 4) { console.log(`  only ${days.length} day(s) present — scan incomplete or sample too thin for a chrono split`); continue; }
    const { train, valid } = splitDays(days);
    const tr = rows.filter((r) => train.has(r.day)), va = rows.filter((r) => valid.has(r.day));

    const cells: { key: string; label: string }[] = [
      ...MS_CELLS.map((h) => ({ key: `ms${h}`, label: `${h / 1000}s` })),
      ...MIN_CELLS.map((h) => ({ key: `m${h}`, label: `${h}m` })),
    ];
    for (const { key, label } of cells) {
      const icTr = dayBoot(tr as any, icStat(key) as any, 15100 + key.length * 7 + label.length) as Boot;
      const icVa = dayBoot(va as any, icStat(key) as any, 15200 + key.length * 7 + label.length) as Boot;
      icTr.n = tr.filter((r) => r.y[key] != null).length; icVa.n = va.filter((r) => r.y[key] != null).length;
      const v = verdict(sym, 1, icTr, icVa, true, 'ic');
      const { est, p } = pTwoSided(rows, key, 15300 + key.length * 7 + label.length);
      family.push({ name: `${type}@${label}`, p, est });
      const consStr = consist.map((c) => { const ic = icStat(key)(c.rows); return `${c.key} ${isFinite(ic) ? (ic >= 0 ? '+' : '') + ic.toFixed(3) : '—'}`; }).join(' · ');
      console.log(`  IC(${label.padStart(3)}): train ${fmt(icTr)} | valid ${fmt(icVa)} | full ${est >= 0 ? '+' : ''}${est.toFixed(3)} p=${p.toFixed(4)}  → ${v} [declared]`);
      console.log(`    consist: ${consStr}`);
      // descriptive: mean y (half-spreads at ms cells) + structure split
      const mAll = dayBoot(rows as any, meanStat(key) as any, 15400 + key.length) as Boot;
      let hsStr = '';
      if (key.startsWith('ms')) {
        let ss = 0, n2 = 0;
        for (const r of rows) if (r.y[key] != null && r.spread != null) { ss += (r.spread * TICKPT) / 2; n2++; }
        const hs = ss / Math.max(n2, 1);
        hsStr = ` = ${(mAll.est / hs).toFixed(2)} half-spreads`;
      }
      const near = rows.filter((r) => r.dist != null && r.dist <= r.sigma);
      const far = rows.filter((r) => !(r.dist != null && r.dist <= r.sigma));
      console.log(`    mean y(${label}): ${fmt(mAll, 'pt')}${hsStr} | near-structure ${meanStat(key)(near).toFixed(3)}pt (n=${near.length}) vs open-tape ${meanStat(key)(far).toFixed(3)}pt (descriptive)`);
    }
  }

  console.log(`\n— BH-FDR q=0.10 across the ${family.length}-cell E0.2 family —`);
  const sorted = [...family].sort((a, b) => a.p - b.p);
  let kMax = 0;
  sorted.forEach((r, i) => { if (r.p <= (0.10 * (i + 1)) / sorted.length) kMax = i + 1; });
  sorted.forEach((r, i) => console.log(`  ${r.name.padEnd(20)} p=${r.p.toFixed(4)} IC=${r.est >= 0 ? '+' : ''}${r.est.toFixed(3)} (rank ${i + 1}/${sorted.length}) → ${i < kMax ? '★ FAMILY-SIGNIFICANT' : 'ns'}`));
  db.close();
}
main();
