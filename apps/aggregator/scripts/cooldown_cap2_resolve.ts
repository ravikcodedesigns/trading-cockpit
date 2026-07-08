// COOLDOWN-CAP2 forward resolver (registered 2026-07-08, family live-book).
//
// The cooldown gate discards flow measured at +11.7pt/trade in-sample
// (05-05→07-08, n=45), with the realistic relaxation being CAP-2: take a
// cooldown-skipped signal only when fewer than 2 positions are open.
// cooldown-shadow.ts has logged every SKIP_COOLDOWN live into
// trading.db shadow_trades (source='cooldown-skipped') since 2026-06-10.
//
// This script resolves the FORWARD sample (days > 2026-07-08, the
// registration date) — plus reports the accrued-so-far tally for context:
//   variant A (remove gate): all shadow trades
//   variant B (cap-2): shadow trades taken only when live-book concurrency
//     (positions.db real fills + already-taken cap-2 shadows) < 2 at open
// Resolution rule (frozen): resolve at >=20 forward shadow trades OR
// 2026-10-08, whichever first; ADOPT cap-2 only if its forward total is
// positive AND day-block permutation p(cap-2 pnl vs 0) < 0.10.
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cooldown_cap2_resolve.ts
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trading = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const positions = new Database(path.resolve(__dirname, '../../../data/positions.db'), { readonly: true });

const REGISTERED = '2026-07-08';

interface Sh { day: string; openTs: number; closeTs: number | null; rule: string; dir: string; reason: string | null; pnl: number | null; }
const shadows = (trading.prepare(`
  SELECT trading_day day, open_ts openTs, close_ts closeTs, rule_id rule, direction dir, close_reason reason, pnl_pts pnl
  FROM shadow_trades WHERE source='cooldown-skipped' ORDER BY open_ts`).all() as Sh[]);

// real live-book intervals (fills) for concurrency reconstruction
const real = positions.prepare(`
  SELECT created_at a, updated_at b, status FROM positions
  WHERE status LIKE 'closed%' OR status='filled_entry'`).all() as any[];
const realIv = real.map((r) => [r.a, r.status === 'filled_entry' ? Number.MAX_SAFE_INTEGER : r.b] as [number, number]);

function summarize(label: string, rows: Sh[]) {
  const closed = rows.filter((r) => r.pnl != null);
  const tp = closed.filter((r) => r.reason === 'TP').length, sl = closed.filter((r) => r.reason === 'SL').length;
  const tot = closed.reduce((a, r) => a + (r.pnl ?? 0), 0);
  console.log(`  ${label}: n=${closed.length} (${rows.length - closed.length} still open) · ${tp}W/${sl}L · total ${tot >= 0 ? '+' : ''}${tot.toFixed(1)}pt ($${(2 * tot).toFixed(0)})`);
  return { n: closed.length, tot };
}

function run(rows: Sh[], title: string) {
  console.log(`\n== ${title} ==`);
  summarize('variant A (all taken)  ', rows);
  // cap-2: chronological; concurrency = real positions + accepted cap-2 shadows
  const accepted: Sh[] = [];
  const acceptedIv: [number, number][] = [];
  for (const s of rows) {
    const conc =
      realIv.filter(([a, b]) => a <= s.openTs && s.openTs < b).length +
      acceptedIv.filter(([a, b]) => a <= s.openTs && s.openTs < b).length;
    if (conc < 2) { accepted.push(s); acceptedIv.push([s.openTs, s.closeTs ?? Number.MAX_SAFE_INTEGER]); }
  }
  const { n, tot } = summarize(`variant B (cap-2, ${accepted.length}/${rows.length})`, accepted);
  return { n, tot, accepted };
}

const fwd = shadows.filter((s) => s.day > REGISTERED);
const pre = shadows.filter((s) => s.day <= REGISTERED);
run(pre, `accrued pre-registration (2026-06-10 → ${REGISTERED}) — context only, NOT the test`);
const { n, tot, accepted } = run(fwd, `FORWARD sample (days > ${REGISTERED}) — the registered test`);

// resolution check (day-block permutation of cap-2 mean daily pnl vs 0 via sign-flip)
if (n >= 20) {
  const byDay = new Map<string, number>();
  for (const s of accepted) if (s.pnl != null) byDay.set(s.day, (byDay.get(s.day) ?? 0) + s.pnl);
  const days = [...byDay.values()];
  let s0 = 1664525 >>> 0;
  const rnd = () => ((s0 = (1664525 * s0 + 1013904223) >>> 0) / 4294967296);
  const obs = days.reduce((a, b) => a + b, 0);
  let ge = 0; const B = 10000;
  for (let i = 0; i < B; i++) {
    let t = 0;
    for (const d of days) t += rnd() < 0.5 ? d : -d;
    if (t >= obs) ge++;
  }
  const p = Math.max(1 / B, ge / B);
  console.log(`\nRESOLUTION: n=${n} ≥ 20 → total ${tot >= 0 ? '+' : ''}${tot.toFixed(1)}pt, day-block sign-flip p=${p.toFixed(3)} → ${tot > 0 && p < 0.10 ? 'ADOPT cap-2' : 'REJECT (keep gate as-is)'}`);
} else {
  console.log(`\nRESOLUTION: n=${n} < 20 forward trades — keep accruing (hard stop 2026-10-08: resolve on whatever has accrued).`);
}
trading.close(); positions.close();
