// DANGER-FLAG-CONFIRM forward resolver (registered 2026-07-08, family live-book).
//
// Claim: FLIP/CONT entries in the danger-flag-UP state (🔋 — violent tape at
// the signal bar; frozen thresholds in @trading/contracts) carry HIGHER EV
// than flag-DOWN (🪫) entries, both directions pooled.
// In-sample reference (the data the idea was found on — NOT the test):
//   🔋 longs 17TP/11SL +26.8pt · 🪫 longs 25/25 +9.7 · 🔋 shorts 18/5 +38.2 ·
//   🪫 shorts 6/2 +20.8 (n=126, perm p=0.24/0.52).
// RESOLUTION RULE (frozen): at ≥40 forward tagged OPENs (days > 2026-07-08)
// with BOTH states represented, or 2026-10-08 hard stop — ADOPT the sizing
// overlay (2 MNQ flag-up / 1 flag-down) only if the forward up−down EV
// difference is POSITIVE and day-block permutation p < 0.10. Never a gate.
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/dflag_confirm_resolve.ts
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const REGISTERED = '2026-07-08';

interface Row { day: string; dir: string; dflag: number; pnl: number; reason: string; }
const all = db.prepare(`
  SELECT date(signal_ts/1000,'unixepoch','localtime') day, direction dir, dflag, sim_pnl_pts pnl, sim_exit_reason reason
  FROM (SELECT * FROM tradable_signals WHERE symbol='NQ' AND rule_id IN ('clean-impulse','cont-reentry')
        AND action='OPEN' AND sim_pnl_pts IS NOT NULL AND dflag IS NOT NULL GROUP BY signal_id)
  ORDER BY day`).all() as Row[];

function cohorts(rows: Row[], label: string): { up: Row[]; dn: Row[] } {
  const up = rows.filter((r) => r.dflag === 1), dn = rows.filter((r) => r.dflag === 0);
  const st = (g: Row[]) => {
    const w = g.filter((r) => r.reason === 'TP').length, l = g.filter((r) => r.reason === 'SL').length;
    const tot = g.reduce((a, r) => a + r.pnl, 0);
    return `n=${g.length} ${w}W/${l}L wr=${(100 * w / Math.max(w + l, 1)).toFixed(0)}% total ${tot >= 0 ? '+' : ''}${tot.toFixed(1)}pt avg ${g.length ? (tot / g.length).toFixed(1) : '—'}pt`;
  };
  console.log(`\n== ${label} ==`);
  console.log(`  🔋 up:   ${st(up)}`);
  console.log(`  🪫 down: ${st(dn)}`);
  return { up, dn };
}

/** day-block permutation: shuffle day-level flag assignment (days resampled whole) */
function dayBlockP(up: Row[], dn: Row[], B = 10000): { diff: number; p: number } {
  const days = new Map<string, { u: number[]; d: number[] }>();
  for (const r of up) { if (!days.has(r.day)) days.set(r.day, { u: [], d: [] }); days.get(r.day)!.u.push(r.pnl); }
  for (const r of dn) { if (!days.has(r.day)) days.set(r.day, { u: [], d: [] }); days.get(r.day)!.d.push(r.pnl); }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const diff = mean(up.map((r) => r.pnl)) - mean(dn.map((r) => r.pnl));
  // permute trade-level flags WITHIN each day (regime-safe: day effects cancel)
  let s0 = 987654321 >>> 0;
  const rnd = () => ((s0 = (1664525 * s0 + 1013904223) >>> 0) / 4294967296);
  let ge = 0;
  for (let b = 0; b < B; b++) {
    const u: number[] = [], d: number[] = [];
    for (const { u: du, d: dd } of days.values()) {
      const pool = [...du, ...dd];
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
      u.push(...pool.slice(0, du.length)); d.push(...pool.slice(du.length));
    }
    if (u.length && d.length && Math.abs(mean(u) - mean(d)) >= Math.abs(diff)) ge++;
  }
  return { diff, p: Math.max(ge / B, 1 / B) };
}

console.log(`=== DANGER-FLAG-CONFIRM resolver (registered ${REGISTERED}) ===`);
cohorts(all.filter((r) => r.day <= REGISTERED), `in-sample reference (≤ ${REGISTERED}) — context only, NOT the test`);
const fwd = all.filter((r) => r.day > REGISTERED);
const { up, dn } = cohorts(fwd, `FORWARD sample (days > ${REGISTERED}) — the registered test`);

const n = up.length + dn.length;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
if ((n >= 40 && up.length > 0 && dn.length > 0) || today >= '2026-10-08') {
  const { diff, p } = dayBlockP(up, dn);
  const adopt = diff > 0 && p < 0.10;
  console.log(`\nRESOLUTION: n=${n} · up−down ΔEV ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}pt · within-day perm p=${p.toFixed(3)}`);
  console.log(`→ ${adopt ? 'ADOPT sizing overlay (2 MNQ 🔋 / 1 MNQ 🪫) — wire in trader signalQty + record resolution' : 'NOT CONFIRMED — keep shadow tag as dead cohort marker, record resolution'}`);
} else {
  console.log(`\nRESOLUTION: n=${n}/40 forward tagged opens (🔋 ${up.length} · 🪫 ${dn.length}) — keep accruing (hard stop 2026-10-08).`);
}
db.close();
