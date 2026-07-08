// IV → PARTICIPATION GATE study for FLIP/CONT (Ravi, 2026-07-08).
//
// Question: does FLIP/CONT expectancy at the FIXED brackets (80/70–105 —
// brackets stay fixed; the adaptive-bracket null is settled and NOT
// relitigated here) collapse on low-expected-range days? If yes, morning IV
// (knowledge time 10:00 ET, the validated range forecaster) becomes a
// go/no-go participation gate. Secondary: risk-normalized sizing demo
// (variance smoothing only — no expectancy claim).
//
// Morning IV source: data/quantdata_features.csv `iv` column = mean NDX IV
// over the first 30 min of RTH (build_features.ts; knowledge-clean at 10:00).
// Coverage 2025-01-02 → 2026-07-01 (374 days).
//
// No-lookahead gating: each trade day's IV tercile is computed from the
// TRAILING distribution (all CSV days strictly before that day) — a live
// gate would know exactly this. In-sample terciles also reported (labeled).
//
// Honesty: exploratory, n=144 OPEN sims; permutation p on EV differences;
// trades evaluated before 10:00 ET are un-gateable and reported separately.
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/iv_participation_flipcont.ts
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trading = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticks = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });

// ── 1. Morning IV per day ─────────────────────────────────────────────────────
const csv = fs.readFileSync(path.resolve(__dirname, '../../../data/quantdata_features.csv'), 'utf8').trim().split('\n');
const header = csv[0]!.split(',');
const dayIx = header.indexOf('day'), ivIx = header.indexOf('iv');
const ivByDay = new Map<string, number>();
const ivDays: { day: string; iv: number }[] = [];
for (const line of csv.slice(1)) {
  const c = line.split(',');
  const iv = Number(c[ivIx]);
  if (Number.isFinite(iv) && iv > 0) { ivByDay.set(c[dayIx]!, iv); ivDays.push({ day: c[dayIx]!, iv }); }
}
ivDays.sort((a, b) => a.day.localeCompare(b.day));

/** trailing tercile of `iv` among all CSV days strictly before `day` (min 60 obs) */
function trailingTercile(day: string, iv: number): 1 | 2 | 3 | null {
  const prior = ivDays.filter((d) => d.day < day).map((d) => d.iv);
  if (prior.length < 60) return null;
  const s = [...prior].sort((a, b) => a - b);
  const t1 = s[Math.floor(s.length / 3)]!, t2 = s[Math.floor((2 * s.length) / 3)]!;
  return iv < t1 ? 1 : iv < t2 ? 2 : 3;
}

// ── 2. Load OPEN sims ─────────────────────────────────────────────────────────
const fmtEt = (tsMs: number) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = p.split('/');
  return `${yyyy}-${mm}-${dd}`;
};
const etHour = (tsMs: number) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(new Date(tsMs)));

interface Trade { day: string; rule: string; dir: string; ts: number; pnl: number; reason: string; iv: number | null; terc: 1 | 2 | 3 | null; gateable: boolean; }
const rawTrades = trading.prepare(`
  SELECT signal_ts ts, rule_id rule, direction dir, sim_exit_reason reason, sim_pnl_pts pnl
  FROM tradable_signals
  WHERE symbol='NQ' AND rule_id IN ('clean-impulse','cont-reentry') AND action='OPEN' AND sim_pnl_pts IS NOT NULL
  GROUP BY signal_id ORDER BY signal_ts`).all() as any[];
const trades: Trade[] = rawTrades.map((r) => {
  const day = fmtEt(r.ts);
  const iv = ivByDay.get(day) ?? null;
  return {
    day, rule: r.rule, dir: r.dir, ts: r.ts, pnl: r.pnl, reason: r.reason,
    iv, terc: iv != null ? trailingTercile(day, iv) : null,
    gateable: etHour(r.ts + 60_000) >= 10, // decision at/after 10:00 ET (IV knowledge time)
  };
});

// ── 3. Realized RTH range per trade day (mechanical sanity) ──────────────────
const rangeStmt = ticks.prepare(`SELECT MAX(price) - MIN(price) rg FROM trades WHERE symbol='NQ' AND ts BETWEEN ? AND ?`);
const rangeByDay = new Map<string, number>();
for (const day of new Set(trades.map((t) => t.day))) {
  const lo = Date.parse(`${day}T09:30:00-04:00`), hi = Date.parse(`${day}T16:00:00-04:00`);
  const r = rangeStmt.get(lo, hi) as any;
  if (r?.rg) rangeByDay.set(day, r.rg);
}

// ── 4. Stats ──────────────────────────────────────────────────────────────────
const wr = (rs: Trade[]) => {
  const w = rs.filter((t) => t.reason === 'TP').length, l = rs.filter((t) => t.reason === 'SL').length;
  return { w, l, wr: w + l ? w / (w + l) : NaN };
};
const ev = (rs: Trade[]) => (rs.length ? rs.reduce((a, t) => a + t.pnl, 0) / rs.length : NaN);
function lcg(seed: number) { let s = seed >>> 0; return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296); }
function permP(a: number[], b: number[], seed: number): number {
  if (a.length < 5 || b.length < 5) return NaN;
  const obs = a.reduce((x, y) => x + y, 0) / a.length - b.reduce((x, y) => x + y, 0) / b.length;
  const all = [...a, ...b]; const rnd = lcg(seed); let ge = 0; const B = 10000;
  for (let i = 0; i < B; i++) {
    const idx = all.map((_, j) => j);
    for (let j = idx.length - 1; j > 0; j--) { const k = Math.floor(rnd() * (j + 1)); [idx[j], idx[k]] = [idx[k]!, idx[j]!]; }
    const pa = idx.slice(0, a.length).reduce((x, j) => x + all[j]!, 0) / a.length;
    const pb = idx.slice(a.length).reduce((x, j) => x + all[j]!, 0) / b.length;
    if (Math.abs(pa - pb) >= Math.abs(obs)) ge++;
  }
  return Math.max(1 / B, ge / B);
}
const pc = (x: number) => (isFinite(x) ? (100 * x).toFixed(0) + '%' : '—');
const f1 = (x: number) => (isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(1) : '—');

// ── 5. Report ─────────────────────────────────────────────────────────────────
const withIv = trades.filter((t) => t.terc != null);
console.log(`=== IV participation gate × FLIP/CONT (fixed brackets; exploratory) ===`);
console.log(`Trades: ${trades.length} OPEN sims · with morning-IV: ${withIv.length} (CSV ends 2026-07-01; ${trades.length - trades.filter((t) => t.iv != null).length} trades on uncovered days) · gate-able (≥10:00 ET): ${withIv.filter((t) => t.gateable).length}`);

for (const rule of ['clean-impulse', 'cont-reentry', 'BOTH']) {
  const rs = withIv.filter((t) => rule === 'BOTH' || t.rule === rule);
  if (rs.length < 15) continue;
  const name = rule === 'clean-impulse' ? 'FLIP' : rule === 'cont-reentry' ? 'CONT' : 'BOTH';
  console.log(`\n## ${name} (n=${rs.length}) — by TRAILING morning-IV tercile (no lookahead)`);
  for (const terc of [1, 2, 3] as const) {
    const g = rs.filter((t) => t.terc === terc);
    const { w, l } = wr(g);
    const days = new Set(g.map((t) => t.day)).size;
    const avgRange = [...new Set(g.map((t) => t.day))].map((d) => rangeByDay.get(d)).filter(Boolean) as number[];
    const mr = avgRange.length ? avgRange.reduce((a, b) => a + b, 0) / avgRange.length : NaN;
    console.log(`  T${terc} ${terc === 1 ? '(low-IV) ' : terc === 2 ? '(mid-IV) ' : '(high-IV)'}: n=${String(g.length).padStart(3)} (${days}d) · ${w}W/${l}L wr=${pc(wr(g).wr)} · ev=${f1(ev(g))}pt · avg realized RTH range ${isFinite(mr) ? mr.toFixed(0) : '—'}pt`);
  }
  const low = rs.filter((t) => t.terc === 1), rest = rs.filter((t) => t.terc !== 1);
  const p = permP(low.map((t) => t.pnl), rest.map((t) => t.pnl), 4242 + rs.length);
  console.log(`  low-IV vs rest (the PRE-STATED starvation hypothesis): ΔEV ${f1(ev(low) - ev(rest))}pt · perm-p=${isFinite(p) ? p.toFixed(3) : '—'} · gate would remove ${low.length}/${rs.length} trades`);
  // POST-HOC (found in this data, not pre-stated — label it so): high-IV vs rest
  const hi3 = rs.filter((t) => t.terc === 3), rest3 = rs.filter((t) => t.terc !== 3);
  const p3 = permP(hi3.map((t) => t.pnl), rest3.map((t) => t.pnl), 5252 + rs.length);
  // day-block version: permute whole DAYS to respect clustering
  const dayPnl = new Map<string, { pnl: number[]; terc: number }>();
  for (const t of rs) { if (!dayPnl.has(t.day)) dayPnl.set(t.day, { pnl: [], terc: t.terc! }); dayPnl.get(t.day)!.pnl.push(t.pnl); }
  const days3 = [...dayPnl.values()];
  const dayMeans = (g: { pnl: number[] }[]) => g.map((d) => d.pnl.reduce((a, b) => a + b, 0) / d.pnl.length);
  const a3 = dayMeans(days3.filter((d) => d.terc === 3)), b3 = dayMeans(days3.filter((d) => d.terc !== 3));
  const pDay = permP(a3, b3, 6262 + rs.length);
  console.log(`  POST-HOC high-IV vs rest: ΔEV ${f1(ev(hi3) - ev(rest3))}pt · trade-perm p=${isFinite(p3) ? p3.toFixed(3) : '—'} · DAY-block perm p=${isFinite(pDay) ? pDay.toFixed(3) : '—'} (${a3.length} vs ${b3.length} days)`);
}

// mechanical sanity: TP-hit rate vs realized range and vs IV (terciles of each)
console.log(`\n## Mechanical sanity — TP-hit% by tercile of REALIZED RTH range (all rules)`);
const tr = withIv.filter((t) => rangeByDay.has(t.day));
const ranges = [...new Set(tr.map((t) => t.day))].map((d) => rangeByDay.get(d)!).sort((a, b) => a - b);
const r1 = ranges[Math.floor(ranges.length / 3)]!, r2 = ranges[Math.floor((2 * ranges.length) / 3)]!;
for (const [label, lo, hi] of [['small', 0, r1], ['mid', r1, r2], ['large', r2, Infinity]] as [string, number, number][]) {
  const g = tr.filter((t) => { const rg = rangeByDay.get(t.day)!; return rg >= lo && rg < hi; });
  const { w, l } = wr(g);
  console.log(`  ${label.padEnd(5)} (range ${lo.toFixed(0)}–${hi === Infinity ? '∞' : hi.toFixed(0)}pt): n=${g.length} · TP-hit ${pc(w / Math.max(w + l, 1))} · ev ${f1(ev(g))}pt`);
}
const ivRangeCorr = (() => {
  const pairs = [...new Set(tr.map((t) => t.day))].map((d) => [ivByDay.get(d)!, rangeByDay.get(d)!]);
  const n = pairs.length, mx = pairs.reduce((a, p) => a + p[0]!, 0) / n, my = pairs.reduce((a, p) => a + p[1]!, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x! - mx) * (y! - my); sxx += (x! - mx) ** 2; syy += (y! - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
})();
console.log(`  morning-IV → realized range corr on these ${new Set(tr.map((t) => t.day)).size} trade days: ${ivRangeCorr.toFixed(3)} (the forecaster link on THIS sample)`);

// ── 6. Risk-normalization demo (variance smoothing; no expectancy claim) ─────
console.log(`\n## Risk normalization — 1 contract flat vs size ∝ 1/IV (same mean size)`);
const seq = withIv.filter((t) => t.iv != null).sort((a, b) => a.ts - b.ts);
const meanInv = seq.reduce((a, t) => a + 1 / t.iv!, 0) / seq.length;
let eqF = 0, eqN = 0;
const dailyF = new Map<string, number>(), dailyN = new Map<string, number>();
for (const t of seq) {
  const k = (1 / t.iv!) / meanInv; // normalized size, mean 1.0
  eqF += t.pnl; eqN += t.pnl * k;
  dailyF.set(t.day, (dailyF.get(t.day) ?? 0) + t.pnl);
  dailyN.set(t.day, (dailyN.get(t.day) ?? 0) + t.pnl * k);
}
const sd = (m: Map<string, number>) => {
  const v = [...m.values()]; const mu = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / v.length);
};
console.log(`  flat 1-lot:   total ${f1(eqF)}pt · daily-PnL SD ${sd(dailyF).toFixed(1)}pt`);
console.log(`  IV-normalized: total ${f1(eqN)}pt · daily-PnL SD ${sd(dailyN).toFixed(1)}pt  (size range ${(Math.min(...seq.map((t) => 1 / t.iv!)) / meanInv).toFixed(2)}–${(Math.max(...seq.map((t) => 1 / t.iv!)) / meanInv).toFixed(2)} lots)`);

trading.close(); ticks.close();
