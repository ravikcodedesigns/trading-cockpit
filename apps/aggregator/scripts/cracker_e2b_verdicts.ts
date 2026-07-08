// CRACKER E2b — verdicts at MS PRECISION (per the 2026-07-08 registration).
//
//   DETECTOR FAMILY: five detectors × declared {1s, 10s}; outcome
//   y = dir × ms_h (points, mid-based, no drift adj — negligible sub-minute).
//   Dose-response IC, chrono 60/40 split, harness verdicts; BH q=0.10 over the
//   testable cells; primary screens as E2 (absorption/imbalance → L2-NQ;
//   sweep/replenishment/wall-pull → L3-NQ); ES consistency.
//   Mean y also reported IN HALF-SPREADS (the honest cost yardstick).
//
//   QI REPLICATION (separate registered family, ONE-SIDED POSITIVE per
//   Cont–Stoikov): per-day Spearman IC of qi vs forward mid move (1s primary,
//   10s reported), day-block bootstrap of the mean day-IC; all four datasets.
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_e2b_verdicts.ts
import Database from 'better-sqlite3';
import { dayBoot, weightedSpearman, splitDays, verdict, fmt, lcg, type Boot } from './cracker_p3_harness.js';

const DB = '/Users/ravikumarbasker/trading-cockpit/data/cracker-events.db';
const H = [250, 1000, 5000, 10000, 30000] as const;
const COL: Record<number, string> = { 250: 'ms_250', 1000: 'ms_1s', 5000: 'ms_5s', 10000: 'ms_10s', 30000: 'ms_30s' };
const DECLARED = [1000, 10000];
const PRIMARY: Record<string, [string, string]> = {
  absorption: ['l2', 'NQ'], imbalance: ['l2', 'NQ'], sweep: ['l3', 'NQ'], replenishment: ['l3', 'NQ'], wallpull: ['l3', 'NQ'],
};
const TICKPT = 0.25;

interface ERow { day: string; intensity: number; y: Record<number, number | null>; spread: number | null; uniq: number; }

function load(db: Database.Database, store: string, sym: string, type: string): { rows: ERow[]; days: string[] } {
  const raw = db.prepare(`SELECT trading_day day, dir, intensity, spread_ticks spread, ms_250, ms_1s, ms_5s, ms_10s, ms_30s
    FROM events WHERE store=? AND symbol=? AND type=? ORDER BY trading_day, ts`).all(store, sym, type) as any[];
  const rows: ERow[] = raw.map((r) => {
    const y: Record<number, number | null> = {};
    for (const h of H) { const v = r[COL[h]!]; y[h] = v == null ? null : r.dir * v; }
    return { day: r.day, intensity: r.intensity, y, spread: r.spread, uniq: 1 };
  });
  return { rows, days: [...new Set(rows.map((r) => r.day))].sort() };
}

const icStat = (h: number) => (rs: ERow[]): number => {
  const x: number[] = [], yv: number[] = [], w: number[] = [];
  for (const r of rs) { if (r.y[h] == null) continue; x.push(r.intensity); yv.push(r.y[h]!); w.push(1); }
  return x.length >= 30 ? weightedSpearman(x, yv, w) : NaN;
};

function pTwoSided(rows: ERow[], h: number, seed: number): { est: number; p: number } {
  const byDay = new Map<string, ERow[]>();
  for (const r of rows) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day)!.push(r); }
  const days = [...byDay.keys()].sort();
  const est = icStat(h)(rows);
  const rnd = lcg(seed);
  let lo = 0, hi2 = 0, n = 0;
  for (let b = 0; b < 2000; b++) {
    const rs: ERow[] = [];
    for (let i = 0; i < days.length; i++) rs.push(...byDay.get(days[Math.floor(rnd() * days.length)]!)!);
    const v = icStat(h)(rs);
    if (!isFinite(v)) continue;
    n++; if (v <= 0) lo++; if (v >= 0) hi2++;
  }
  return { est, p: Math.max(1 / Math.max(n, 1), 2 * Math.min(lo, hi2) / Math.max(n, 1)) };
}

function main() {
  const db = new Database(DB, { readonly: true });
  console.log('=== E2b — ms-precision verdicts ===');
  const family: { name: string; p: number; est: number }[] = [];

  for (const type of Object.keys(PRIMARY)) {
    const [store, sym] = PRIMARY[type]!;
    const { rows, days } = load(db, store, sym, type);
    console.log(`\n## ${type} — ${store.toUpperCase()}-${sym} (${rows.length} events / ${days.length}d)`);
    if (rows.length < 60) { console.log('  insufficient events — UNDERPOWERED by construction'); continue; }
    const { train, valid } = splitDays(days);
    const tr = rows.filter((r) => train.has(r.day)), va = rows.filter((r) => valid.has(r.day));
    for (const h of H) {
      const isDecl = DECLARED.includes(h);
      const label = h < 1000 ? `${h}ms` : `${h / 1000}s`;
      if (!isDecl) {
        const ic = icStat(h)(rows);
        console.log(`  IC(${label.padStart(4)}): full ${isFinite(ic) ? (ic >= 0 ? '+' : '') + ic.toFixed(3) : '—'}`);
        continue;
      }
      const icTr = dayBoot(tr as any, icStat(h) as any, 11100 + h) as Boot;
      const icVa = dayBoot(va as any, icStat(h) as any, 11200 + h) as Boot;
      icTr.n = tr.filter((r) => r.y[h] != null).length; icVa.n = va.filter((r) => r.y[h] != null).length;
      const v = verdict(sym, 1, icTr, icVa, true, 'ic');
      const { est, p } = pTwoSided(rows, h, 11300 + h);
      family.push({ name: `${type}@${label}`, p, est });
      // mean y in half-spreads (cost yardstick)
      let sy = 0, n2 = 0, ss = 0;
      for (const r of rows) if (r.y[h] != null && r.spread != null) { sy += r.y[h]!; ss += (r.spread * TICKPT) / 2; n2++; }
      const meanY = sy / Math.max(n2, 1), halfSpread = ss / Math.max(n2, 1);
      console.log(`  IC(${label.padStart(4)}): train ${fmt(icTr)} | valid ${fmt(icVa)} | full ${est >= 0 ? '+' : ''}${est.toFixed(3)} p=${p.toFixed(4)}  → ${v} [declared]`);
      console.log(`    mean y(${label}) ${meanY >= 0 ? '+' : ''}${meanY.toFixed(3)}pt = ${(meanY / halfSpread).toFixed(2)} half-spreads (avg half-spread ${halfSpread.toFixed(2)}pt)`);
    }
  }

  console.log(`\n— BH q=0.10, detector family (${family.length} cells) —`);
  const sorted = [...family].sort((a, b) => a.p - b.p);
  let kMax = 0;
  sorted.forEach((r, i) => { if (r.p <= (0.10 * (i + 1)) / sorted.length) kMax = i + 1; });
  sorted.forEach((r, i) => console.log(`  ${r.name.padEnd(22)} p=${r.p.toFixed(4)} IC=${r.est >= 0 ? '+' : ''}${r.est.toFixed(3)} → ${i < kMax ? '★ FAMILY-SIGNIFICANT' : 'ns'}`));

  // ── QI replication (one-sided positive, per-day IC → day-bootstrap of mean) ──
  console.log('\n=== QI replication (Cont–Stoikov; declared POSITIVE, one-sided) ===');
  for (const [store, sym] of [['l3', 'NQ'], ['l3', 'ES'], ['l2', 'NQ'], ['l2', 'ES']] as const) {
    const days = (db.prepare(`SELECT DISTINCT trading_day d FROM qi_samples WHERE store=? AND symbol=? ORDER BY 1`).all(store, sym) as any[]).map((r) => r.d);
    const dayIC = (h: '1s' | '10s'): { day: string; ic: number }[] => days.map((d) => {
      const rs = db.prepare(`SELECT qi, dmid_${h} v FROM qi_samples WHERE store=? AND symbol=? AND trading_day=? AND dmid_${h} IS NOT NULL`).all(store, sym, d) as any[];
      if (rs.length < 500) return { day: d, ic: NaN };
      return { day: d, ic: weightedSpearman(rs.map((r) => r.qi), rs.map((r) => r.v), rs.map(() => 1)) };
    }).filter((x) => isFinite(x.ic));
    for (const h of ['1s', '10s'] as const) {
      const ics = dayIC(h);
      const bt = dayBoot(ics.map((x) => ({ day: x.day, ic: x.ic })) as any, ((rs: any[]) => rs.reduce((a, r) => a + r.ic, 0) / Math.max(rs.length, 1)) as any, 12000) as Boot;
      // one-sided p from the bootstrap distribution sign
      const rnd = lcg(12345);
      const byDay = new Map(ics.map((x) => [x.day, x.ic]));
      const dl = [...byDay.keys()];
      let neg = 0, n = 0;
      for (let b = 0; b < 4000; b++) {
        let s = 0;
        for (let i = 0; i < dl.length; i++) s += byDay.get(dl[Math.floor(rnd() * dl.length)]!)!;
        n++; if (s / dl.length <= 0) neg++;
      }
      const p1 = Math.max(1 / n, neg / n);
      const posDays = ics.filter((x) => x.ic > 0).length;
      console.log(`  ${store.toUpperCase()}-${sym} qi→Δmid(${h}): mean day-IC ${bt.est >= 0 ? '+' : ''}${bt.est.toFixed(4)} CI95 [${bt.ci95[0].toFixed(4)}, ${bt.ci95[1].toFixed(4)}] · ${posDays}/${ics.length} days positive · one-sided p=${p1.toFixed(4)}${h === '1s' ? ' [declared]' : ''}`);
    }
  }
  db.close();
}
main();
