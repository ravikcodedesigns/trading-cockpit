// QI EXECUTION-OVERLAY STUDY — FLIP/CONT × queue imbalance at decision time.
//
// Question (Ravi, 2026-07-08): does top-of-book queue imbalance (the confirmed
// Cont–Stoikov predictor, qi_samples 1/s) discriminate FLIP/CONT outcomes —
// (a) carve losers out of the TRADABLE (OPEN) book, (b) identify skipped
// winners in the QUALIFIED pool, (c) improve entry prices via a wait rule?
//
// HONESTY FRAME: exploratory, in-sample, small n — NOT pre-registered. QI's
// confirmed horizon is ~1s; any claim that it predicts 80pt-bracket outcomes
// is a NEW hypothesis that must survive forward data before touching the gate.
//
// Data: trading.db tradable_signals (OPEN rows use the banked tick-accurate
// sim: TP/SL/OPP/RTH; SKIP rows graded here standalone TP/SL/RTH — no OPP,
// no portfolio state — via the same walk convention + brackets as
// persist_simulated_outcomes.ts). QI from cracker-events.db qi_samples
// (store l2, NQ): qi0 = last sample ≤ eval ts (≤5s), qi30/qi300 = trailing
// means. All direction-signed (qiA > 0 = book leans WITH the trade).
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/qi_overlay_flipcont.ts
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trading = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticks = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });
const events = new Database(path.resolve(__dirname, '../../../data/cracker-events.db'), { readonly: true });

function tpsl(ruleId: string, direction: 'long' | 'short'): { tp: number; sl: number } {
  if (ruleId === 'clean-impulse') return { tp: 80, sl: direction === 'long' ? 55 : 105 };
  return { tp: 80, sl: 70 }; // cont-reentry
}
const fmtEtDate = (tsMs: number) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = p.split('/');
  return `${yyyy}-${mm}-${dd}`;
};
const rthCloseTs = (tsMs: number): number => Date.parse(`${fmtEtDate(tsMs)}T15:54:00-04:00`);

interface Sig {
  id: number; ts: number; evalTs: number; day: string; rule: string; dir: 1 | -1;
  entry: number; universe: 'OPEN' | 'SKIP'; action: string;
  outcome: 'TP' | 'SL' | 'OPP' | 'RTH' | null; pnl: number | null;
  qi0: number | null; qi30: number | null; qi300: number | null;
}

// ── 1. Load signals (dedup by signal_id) ─────────────────────────────────────
const raw = trading.prepare(`
  SELECT signal_id id, signal_ts ts, evaluated_at evalTs, rule_id rule, direction, entry, action,
         sim_exit_reason reason, sim_pnl_pts pnl
  FROM tradable_signals
  WHERE symbol='NQ' AND rule_id IN ('clean-impulse','cont-reentry') AND entry IS NOT NULL
  GROUP BY signal_id ORDER BY signal_ts`).all() as any[];

// ── 2. Grade SKIP rows standalone (same brackets/walk as the banked sim) ─────
const tickQ = ticks.prepare('SELECT ts, price FROM trades WHERE symbol = ? AND ts > ? AND ts <= ? ORDER BY ts ASC');
const lastTick = ticks.prepare('SELECT price FROM trades WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1');
function gradeStandalone(evalTs: number, entry: number, dir: 1 | -1, tp: number, sl: number): { outcome: 'TP' | 'SL' | 'RTH'; pnl: number } | null {
  const close = rthCloseTs(evalTs);
  if (evalTs >= close) return null; // post-close signal, ungradeable standalone
  const tpPx = dir === 1 ? entry + tp : entry - tp;
  const slPx = dir === 1 ? entry - sl : entry + sl;
  for (const r of tickQ.iterate('NQ', evalTs, close) as IterableIterator<{ ts: number; price: number }>) {
    if (dir === 1) {
      if (r.price <= slPx) return { outcome: 'SL', pnl: -sl };
      if (r.price >= tpPx) return { outcome: 'TP', pnl: tp };
    } else {
      if (r.price >= slPx) return { outcome: 'SL', pnl: -sl };
      if (r.price <= tpPx) return { outcome: 'TP', pnl: tp };
    }
  }
  const last = lastTick.get('NQ', close) as { price: number } | undefined;
  if (!last) return null;
  return { outcome: 'RTH', pnl: dir === 1 ? last.price - entry : entry - last.price };
}

// ── 3. QI features from qi_samples (l2-NQ) ───────────────────────────────────
const qiAt = events.prepare(`SELECT qi FROM qi_samples WHERE store='l2' AND symbol='NQ' AND trading_day=? AND ts<=? AND ts>? ORDER BY ts DESC LIMIT 1`);
const qiMean = events.prepare(`SELECT AVG(qi) m, COUNT(*) n FROM qi_samples WHERE store='l2' AND symbol='NQ' AND trading_day=? AND ts>? AND ts<=?`);

const sigs: Sig[] = [];
for (const r of raw) {
  const dir: 1 | -1 = r.direction === 'long' ? 1 : -1;
  // decision time = signal bar CLOSE (signal_ts + 60s). evaluated_at is NOT
  // usable: the 2026-06-09 re-qualification backfill stamped all prior rows
  // with the backfill wall-clock (17:40 ET), not the live decision time.
  const evalTs = r.ts + 60_000;
  const day = fmtEtDate(evalTs);
  let universe: 'OPEN' | 'SKIP', outcome = r.reason ?? null, pnl = r.pnl ?? null;
  if (r.action === 'OPEN' && r.pnl != null) universe = 'OPEN';
  else if (r.action !== 'OPEN') {
    universe = 'SKIP';
    const { tp, sl } = tpsl(r.rule, r.direction);
    const g = gradeStandalone(evalTs, r.entry, dir, tp, sl);
    if (!g) continue;
    outcome = g.outcome; pnl = g.pnl;
  } else continue; // OPEN without sim
  const q0 = qiAt.get(day, evalTs, evalTs - 5_000) as any;
  const q30 = qiMean.get(day, evalTs - 30_000, evalTs) as any;
  const q300 = qiMean.get(day, evalTs - 300_000, evalTs) as any;
  sigs.push({
    id: r.id, ts: r.ts, evalTs, day, rule: r.rule, dir, entry: r.entry, universe, action: r.action,
    outcome, pnl,
    qi0: q0 ? q0.qi * dir : null,
    qi30: q30 && q30.n >= 10 ? q30.m * dir : null,
    qi300: q300 && q300.n >= 100 ? q300.m * dir : null,
  });
}

// ── 4. Stats helpers ──────────────────────────────────────────────────────────
const wrOf = (rs: Sig[]) => {
  const tp = rs.filter((s) => s.outcome === 'TP').length, sl = rs.filter((s) => s.outcome === 'SL').length;
  return { tp, sl, wr: tp + sl ? tp / (tp + sl) : NaN };
};
const evOf = (rs: Sig[]) => (rs.length ? rs.reduce((a, s) => a + (s.pnl ?? 0), 0) / rs.length : NaN);
function lcg(seed: number) { let s = seed >>> 0; return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296); }
/** permutation p (two-sided) for EV difference between groups A/B under label shuffle */
function permP(a: number[], b: number[], seed: number): number {
  if (!a.length || !b.length) return NaN;
  const obs = a.reduce((x, y) => x + y, 0) / a.length - b.reduce((x, y) => x + y, 0) / b.length;
  const all = [...a, ...b];
  const rnd = lcg(seed);
  let ge = 0;
  const B = 10000;
  for (let i = 0; i < B; i++) {
    const idx = all.map((_, j) => j);
    for (let j = idx.length - 1; j > 0; j--) { const k = Math.floor(rnd() * (j + 1)); [idx[j], idx[k]] = [idx[k]!, idx[j]!]; }
    const pa = idx.slice(0, a.length).reduce((x, j) => x + all[j]!, 0) / a.length;
    const pb = idx.slice(a.length).reduce((x, j) => x + all[j]!, 0) / b.length;
    if (Math.abs(pa - pb) >= Math.abs(obs)) ge++;
  }
  return Math.max(1 / B, ge / B);
}
const pct = (x: number) => (isFinite(x) ? (100 * x).toFixed(0) + '%' : '—');
const f2 = (x: number) => (isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(1) : '—');

function report(label: string, rs: Sig[], feat: 'qi0' | 'qi30' | 'qi300', seedBase: number) {
  const have = rs.filter((s) => s[feat] != null);
  if (have.length < 20) { console.log(`  ${feat}: n=${have.length} < 20 — skip`); return; }
  const alig = have.filter((s) => s[feat]! > 0), opp = have.filter((s) => s[feat]! <= 0);
  const wA = wrOf(alig), wO = wrOf(opp);
  const p = permP(alig.map((s) => s.pnl ?? 0), opp.map((s) => s.pnl ?? 0), seedBase);
  console.log(`  ${feat.padEnd(6)} (n=${have.length}): book-WITH ${wA.tp}W/${wA.sl}L wr=${pct(wA.wr)} ev=${f2(evOf(alig))}pt (n=${alig.length}) | book-AGAINST ${wO.tp}W/${wO.sl}L wr=${pct(wO.wr)} ev=${f2(evOf(opp))}pt (n=${opp.length}) | ΔEV perm-p=${isFinite(p) ? p.toFixed(3) : '—'}`);
}

// ── 5. Output ─────────────────────────────────────────────────────────────────
console.log('=== QI overlay × FLIP/CONT (exploratory, in-sample) ===');
for (const universe of ['OPEN', 'SKIP'] as const) {
  for (const rule of ['clean-impulse', 'cont-reentry', 'BOTH']) {
    const rs = sigs.filter((s) => s.universe === universe && (rule === 'BOTH' || s.rule === rule));
    if (!rs.length) continue;
    const w = wrOf(rs);
    const name = rule === 'clean-impulse' ? 'FLIP' : rule === 'cont-reentry' ? 'CONT' : 'BOTH';
    console.log(`\n## ${universe} · ${name} — n=${rs.length}, ${w.tp}W/${w.sl}L (wr ${pct(w.wr)}), ev ${f2(evOf(rs))}pt`);
    report(name, rs, 'qi0', 777 + rs.length);
    report(name, rs, 'qi30', 888 + rs.length);
    report(name, rs, 'qi300', 999 + rs.length);
  }
}

// per-action SKIP breakdown (which gate is discarding what)
console.log('\n## SKIP breakdown by gate (standalone sim: TP/SL/RTH only)');
for (const action of ['SKIP_SILENCED', 'SKIP_COOLDOWN', 'SKIP_CVD', 'SKIP_TRAP_VETO']) {
  const rs = sigs.filter((s) => s.universe === 'SKIP' && s.action === action);
  if (!rs.length) continue;
  const w = wrOf(rs);
  const savedByQi = rs.filter((s) => s.qi300 != null && s.qi300 > 0);
  const wS = wrOf(savedByQi);
  console.log(`  ${action.padEnd(15)} n=${rs.length}: ${w.tp}W/${w.sl}L wr=${pct(w.wr)} ev=${f2(evOf(rs))}pt · qi300-WITH subset n=${savedByQi.length}: ${wS.tp}W/${wS.sl}L ev=${f2(evOf(savedByQi))}pt`);
}

// ── 6. Execution wait-rule sim (the actual "overlay") ───────────────────────
// For OPEN entries where qi0 is AGAINST the trade: wait until the first second
// with qi aligned (cap 30s); entry improvement = signed mid move avoided,
// approximated by cumulating dmid_1s over the waited seconds (coverage-counted).
console.log('\n## Execution wait-rule: if qi0 against, wait until aligned (cap 30s)');
const path1s = events.prepare(`SELECT ts, qi, dmid_1s FROM qi_samples WHERE store='l2' AND symbol='NQ' AND trading_day=? AND ts>=? AND ts<=? ORDER BY ts`);
for (const rule of ['clean-impulse', 'cont-reentry']) {
  const opens = sigs.filter((s) => s.universe === 'OPEN' && s.rule === rule && s.qi0 != null);
  let triggered = 0, improved = 0, totImp = 0, waitSum = 0, covered = 0;
  for (const s of opens) {
    if (s.qi0! > 0) continue; // aligned at entry — no wait
    triggered++;
    const rows = path1s.all(s.day, s.evalTs - 2_000, s.evalTs + 32_000) as any[];
    if (rows.length < 5) continue;
    covered++;
    let waited = 0, drift = 0;
    for (const r of rows) {
      if (r.ts < s.evalTs) continue;
      if (r.qi * s.dir > 0 || waited >= 30) break;
      if (r.dmid_1s != null) drift += r.dmid_1s;
      waited++;
    }
    // improvement = adverse-to-entry move avoided: long benefits if price FELL while waiting
    const imp = -s.dir * drift;
    totImp += imp; waitSum += waited; if (imp > 0) improved++;
  }
  const name = rule === 'clean-impulse' ? 'FLIP' : 'CONT';
  console.log(`  ${name}: qi-against at entry ${triggered}/${opens.length} · covered ${covered} · mean wait ${(covered ? waitSum / covered : 0).toFixed(1)}s · mean entry improvement ${covered ? f2(totImp / covered) : '—'}pt (better on ${improved}/${covered})`);
}

console.log(`\nCoverage note: qi features available on ${sigs.filter((s) => s.qi0 != null).length}/${sigs.length} signals (RTH-only sampling, sane-book gate).`);
trading.close(); ticks.close(); events.close();
