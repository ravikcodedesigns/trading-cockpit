// Forward-validation capture for the FILTERED NET-DRIFT SLOPE signal.
//
// Registered in scripts/NETDRIFT_FWD_PREREG.md. Pulls ABJ-filtered (0DTE/OTM/aggressor)
// net-drift for SPX + NDX at ONE_MINUTE, cumulates it into a drift curve, computes the
// 10-min rolling least-squares slope (the actual signal) plus a 10-min price-momentum
// slope (the placebo yardstick), and persists one row per minute to
// data/quantdata.db(netdrift_slope). Idempotent: re-running a day upserts nothing new.
//
// The forward TEST joins these rows to data/tape-events.db(tape_events) by epoch-seconds
// t_sec (NDX→NQ, SPX→ES) once ~2 weeks of consecutive sessions have accrued.
//
// Run (default = today):  pnpm --filter @trading/aggregator exec tsx scripts/netdrift_forward_capture.ts
// Backfill a day:         pnpm --filter @trading/aggregator exec tsx scripts/netdrift_forward_capture.ts 2026-07-09
// Run nightly after close via scripts/launchd/com.cockpit.netdrift-capture.plist.

import 'dotenv/config';
import { store, getNetDrift, abjNetDriftFilter } from '../src/sources/quantdata-store.js';

const SLOPE_WIN = 10; // minutes in the rolling slope window
const INDEX_TO_FUTURES: Record<string, string> = { SPX: 'ES', NDX: 'NQ' };

/** Least-squares slope (per bucket) of a short series. */
function slope(ys: number[]): number {
  const n = ys.length; if (n < 2) return 0;
  const mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (ys[i]! - my); den += (i - mx) ** 2; }
  return den ? num / den : 0;
}

function todayNY(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

async function captureDay(symbol: string, day: string): Promise<number> {
  const futures = INDEX_TO_FUTURES[symbol]!;
  const rows = await getNetDrift(symbol, day, 'ONE_MINUTE', abjNetDriftFilter(day));
  const live = rows.filter((r) => Number.isFinite(r.stock) && r.stock > 0);
  if (live.length < SLOPE_WIN) { console.log(`  ${symbol} ${day}: only ${live.length} buckets — skip`); return 0; }

  // cumulate the drift curve
  let cc = 0, cp = 0, cn = 0;
  const cum = live.map((r) => { cc += r.netCall; cp += r.netPut; cn += (r.netCall - r.netPut); return { ...r, cc, cp, cn }; });

  const ins = store().prepare(
    `INSERT OR IGNORE INTO netdrift_slope
       (symbol,futures,session_date,epoch_ms,t_sec,net_call_cum,net_put_cum,net_cum,slope10,price,price_slope10,filter_tag)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'ABJ_0DTE_OTM_AGGR')`,
  );
  const tx = store().transaction(() => {
    let written = 0;
    for (let i = 0; i < cum.length; i++) {
      const w = cum.slice(Math.max(0, i - SLOPE_WIN + 1), i + 1);
      const s10 = w.length >= SLOPE_WIN ? slope(w.map((x) => x.cn)) : null;
      const p10 = w.length >= SLOPE_WIN ? slope(w.map((x) => x.stock)) : null;
      const info = ins.run(symbol, futures, day, cum[i]!.epoch_ms, Math.floor(cum[i]!.epoch_ms / 1000),
        cum[i]!.cc, cum[i]!.cp, cum[i]!.cn, s10, cum[i]!.stock, p10);
      written += info.changes;
    }
    return written;
  });
  const written = tx();
  const last = cum[cum.length - 1]!;
  console.log(`  ${symbol}→${futures} ${day}: ${cum.length} min, +${written} new | net-drift $${Math.round(last.cn).toLocaleString()} (${last.cn >= 0 ? 'BULL' : 'BEAR'}) | px ${live[0]!.stock.toFixed(0)}→${last.stock.toFixed(0)}`);
  return written;
}

async function main() {
  const day = process.argv[2] ?? todayNY();
  console.log(`netdrift forward-capture — session ${day}`);
  for (const sym of ['SPX', 'NDX']) {
    try { await captureDay(sym, day); }
    catch (e: any) { console.log(`  ${sym} ${day}: ERR ${String(e.message).slice(0, 120)}`); }
  }
  const n = (store().prepare('SELECT COUNT(*) c, COUNT(DISTINCT session_date) d FROM netdrift_slope').get() as any);
  console.log(`netdrift_slope now holds ${n.c} rows across ${n.d} session(s).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
