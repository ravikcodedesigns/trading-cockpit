// REGISTRATIONS STATUS — one command that answers "what's on probation,
// how much evidence has accrued, and is anything due for resolution?"
//
// Reads docs/cracker-registrations.json (the tamper-evident contract file)
// and counts the accrued evidence for every OPEN item from its data source:
//   forward-lockbox family → cracker-trace.db lockbox days (> 2026-07-07)
//   FLIP-HIIV-VETO         → forward FLIP OPEN sims + IV-data coverage
//   COOLDOWN-CAP2          → shadow_trades cooldown-skipped forward rows
//   CVD-LONGFLOOR-OFF      → tradable_signals reason LIKE '[CVD-LFO%'
// Prints DUE when an item's registered resolution threshold is met — then
// run its resolver (cooldown_cap2_resolve.ts, or the study script named in
// the claim). This script only reports; it never resolves.
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/registrations_status.ts
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/cracker-registrations.json'), 'utf8'));
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const open = (f: string) => new Database(path.join(ROOT, 'data', f), { readonly: true });

console.log(`=== Registrations status — ${today} (ET) ===\n`);
const items = (reg.hypotheses as any[]).filter((h) => !h.resolution);
if (!items.length) console.log('No open items.');

for (const h of items) {
  let status = '';
  try {
    if (h.family === 'forward-lockbox') {
      const db = open('cracker-trace.db');
      const r = db.prepare(`SELECT COUNT(DISTINCT trading_day) d FROM visit_outcomes WHERE trading_day > '2026-07-07'`).get() as any;
      db.close();
      status = `lockbox days accrued: ${r?.d ?? '?'} (family resolves together ~2026-07-21, BH q=0.10)`;
    } else if (h.id === 'FLIP-HIIV-VETO') {
      const db = open('trading.db');
      const r = db.prepare(`SELECT COUNT(*) n FROM tradable_signals WHERE rule_id='clean-impulse'
        AND action='OPEN' AND sim_pnl_pts IS NOT NULL AND date(signal_ts/1000,'unixepoch','localtime') > '2026-07-08'`).get() as any;
      db.close();
      const csv = fs.readFileSync(path.join(ROOT, 'data/quantdata_features.csv'), 'utf8').trim().split('\n');
      const lastIvDay = csv[csv.length - 1]!.split(',')[0];
      status = `forward FLIP sims: ${r.n}/30 · morning-IV data ends ${lastIvDay}${lastIvDay! < today ? ' ⚠ EXTEND quantdata_features.csv (build_features.ts) before resolving' : ''}`;
      if (r.n >= 30) status += ' → DUE (also needs ≥5 T3 days — check in the resolver)';
    } else if (h.id === 'COOLDOWN-CAP2') {
      const db = open('trading.db');
      const r = db.prepare(`SELECT COUNT(*) n FROM shadow_trades WHERE source='cooldown-skipped'
        AND trading_day > '2026-07-08' AND pnl_pts IS NOT NULL`).get() as any;
      db.close();
      status = `forward cooldown shadows: ${r.n}/20 · resolver: cooldown_cap2_resolve.ts`;
      if (r.n >= 20 || today >= '2026-10-08') status += ' → DUE';
    } else if (h.id === 'DANGER-FLAG-CONFIRM') {
      const db = open('trading.db');
      const r = db.prepare(`SELECT SUM(dflag=1) up, SUM(dflag=0) dn,
        SUM(CASE WHEN dflag=1 THEN sim_pnl_pts ELSE 0 END) upPts, SUM(CASE WHEN dflag=0 THEN sim_pnl_pts ELSE 0 END) dnPts
        FROM tradable_signals WHERE action='OPEN' AND rule_id IN ('clean-impulse','cont-reentry') AND dflag IS NOT NULL
        AND date(signal_ts/1000,'unixepoch','localtime') > '2026-07-08'`).get() as any;
      db.close();
      const n = (r.up ?? 0) + (r.dn ?? 0);
      status = `forward tagged opens: ${n}/40 (🟩 ${r.up ?? 0}: ${(r.upPts ?? 0).toFixed(1)}pt · 🟥 ${r.dn ?? 0}: ${(r.dnPts ?? 0).toFixed(1)}pt)`;
      if ((n >= 40 && (r.up ?? 0) > 0 && (r.dn ?? 0) > 0) || today >= '2026-10-08') status += ' → DUE';
    } else if (h.id === 'CVD-LONGFLOOR-OFF') {
      const db = open('trading.db');
      const r = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(sim_pnl_pts),0) pts,
        SUM(CASE WHEN sim_exit_reason='TP' THEN 1 ELSE 0 END) w, SUM(CASE WHEN sim_exit_reason='SL' THEN 1 ELSE 0 END) l
        FROM tradable_signals WHERE action='OPEN' AND reason LIKE '[CVD-LFO%'`).get() as any;
      db.close();
      status = `tagged CVD-LFO opens: ${r.n}/20 (${r.w ?? 0}W/${r.l ?? 0}L, ${r.pts >= 0 ? '+' : ''}${(r.pts ?? 0).toFixed(1)}pt so far)`;
      if (r.n >= 20 || today >= '2026-10-08') status += ' → DUE';
    } else {
      status = '(no counter wired — check the claim text for the test set)';
    }
  } catch (e: any) {
    status = `counter failed: ${String(e.message).slice(0, 60)}`;
  }
  console.log(`  ${h.id.padEnd(18)} [${h.family}] registered ${h.registered}`);
  console.log(`    ${status}\n`);
}
console.log('Resolved items:', (reg.hypotheses as any[]).filter((h) => h.resolution).map((h) => h.id).join(', '));
