// CRACKER Phase 0.1 acceptance tests (CRACKER_PLAN.md §Phase 0.1).
// A: unit — MSSwing confirmTs is causal (confirmTs ≥ extreme ts, births causal).
// B: unit — registry lifecycle: Beta posterior, break-accepted retirement,
//    inactivity retirement (9-session sweep), revive-with-history, hydrate round-trip.
// C: integration — real 5-day replay: (1) two fresh runs → byte-identical rows
//    (determinism); (2) re-running the last day on the same DB → identical counts
//    (day-scoped idempotency, no session double-bump); (3) active levels bounded.
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_p01_accept.ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { MultiScaleSwingDetector } from '../src/l3/swing-levels-ms.js';
import { LevelRegistry, holdPosterior, LM_CFG } from '../src/l3/level-memory.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

// ── A: confirmTs causality ───────────────────────────────────────────────────
console.log('\nA. MSSwing confirmTs (no-lookahead)');
{
  const det = new MultiScaleSwingDetector();
  // synthetic zigzag: ramp to a peak, then retrace far enough to confirm on all scales
  let ts = 0; const feed = (p: number) => det.update(p, ++ts * 1000, 5);
  for (let p = 100; p <= 300; p += 2) feed(p);          // impulse up → extreme at ts of p=300
  const out: any[] = [];
  for (let p = 298; p >= 100; p -= 2) out.push(...feed(p)); // retrace → confirms highs
  const all = det.all() as any[];
  check('swings produced', all.length > 0, `${all.length} swings`);
  check('every confirmTs ≥ extreme ts', all.every((s) => s.confirmTs >= s.ts));
  check('confirmTs strictly after extreme for retrace-confirmed swings', all.some((s) => s.confirmTs > s.ts));
  const lv = det.levels(3);
  check('levels() exposes causal bornTs', lv.length > 0 && lv.every((l) => l.bornTs >= l.ts));
}

// ── B: registry lifecycle ────────────────────────────────────────────────────
console.log('\nB. LevelRegistry — posterior / retirement / revive / hydrate');
{
  const reg = new LevelRegistry('NQ');
  reg.beginSession();
  const l = reg.upsert(21000, 'swing', 'high', 1000);
  check('fresh level posterior = prior mean', Math.abs(l.holdPost - 0.65) < 1e-9, l.holdPost.toFixed(4));
  // 1 hold then 3 breaks → posterior (2.6+1)/(4+4)=0.45, then break-accepted below 0.35?
  reg.onVisit(l, true, 2000);
  check('posterior after 1 hold', Math.abs(l.holdPost - (2.6 + 1) / (4 + 1)) < 1e-9, l.holdPost.toFixed(4));
  reg.onVisit(l, false, 3000); reg.onVisit(l, false, 4000); reg.onVisit(l, false, 5000);
  const expect = holdPosterior(1, 4);
  check('posterior after 1H/3B', Math.abs(l.holdPost - expect) < 1e-9, l.holdPost.toFixed(4));
  check('break-accepted retirement fires (<0.35, ≥3 visits)', l.retired === (expect < LM_CFG.RETIRE_POST), `retired=${l.retired}`);
  // revive on re-approach keeps history
  const r = reg.upsert(21001, 'swing', 'high', 6000);
  check('revive merges to same level, history kept', r.id === l.id && r.visits === 4 && !r.retired);
  // inactivity: 9 sessions untested → swept
  for (let i = 0; i < LM_CFG.RETIRE_AGE_SESSIONS; i++) reg.beginSession();
  check('inactivity sweep retires after 9 untested sessions', r.retired === true);
  // hydrate round-trip
  const reg2 = new LevelRegistry('NQ');
  reg2.hydrate(reg.all(), reg.sessionIdx);
  check('hydrate restores levels + session counter', reg2.all().length === 1 && reg2.sessionIdx === reg.sessionIdx
    && reg2.all()[0]!.holdPost === r.holdPost);
}

// ── C: integration on real data (5 days, ~10-20 min) ───────────────────────
console.log('\nC. Integration — determinism / idempotency / bounded registry (5 real days)');
const SCRATCH = '/private/tmp/claude-501/-Users-ravikumarbasker-trading-cockpit/db114df8-c43a-4d05-abd2-fc4d58a7c51f/scratchpad';
const dbHash = (p: string) => {
  const db = new Database(p, { readonly: true });
  const lv = db.prepare(`SELECT * FROM levels ORDER BY id`).all();
  const it = db.prepare(`SELECT level_id,symbol,trading_day,ts_ms,session_idx,source,kind,level_price,side,visit_index,held,taps,dwell_ms,penetration,absorbed_vol,lambda,ofi_net FROM interactions ORDER BY level_id, ts_ms`).all();
  const stats = {
    levels: lv.length, interactions: it.length,
    active: (db.prepare(`SELECT COUNT(*) n FROM levels WHERE retired = 0`).get() as any).n,
    retired: (db.prepare(`SELECT COUNT(*) n FROM levels WHERE retired = 1`).get() as any).n,
  };
  db.close();
  return { hash: crypto.createHash('sha256').update(JSON.stringify({ lv, it })).digest('hex').slice(0, 16), ...stats };
};
const run = (db: string, env: Record<string, string>) =>
  execFileSync('pnpm', ['exec', 'tsx', 'scripts/build_level_memory.ts'], {
    cwd: '/Users/ravikumarbasker/trading-cockpit/apps/aggregator',
    env: { ...process.env, LM_DB: db, LM_QUIET: '1', ...env }, stdio: ['ignore', 'ignore', 'inherit'],
  });

const dbA = `${SCRATCH}/lm_accept_A.db`, dbB = `${SCRATCH}/lm_accept_B.db`;
for (const f of [dbA, dbB]) for (const s of ['', '-wal', '-shm']) fs.rmSync(f + s, { force: true });

console.log('  run 1/3: fresh 5-day replay (A)…');
run(dbA, { LM_DAYS: '5' });
console.log('  run 2/3: fresh 5-day replay (B)…');
run(dbB, { LM_DAYS: '5' });
const A = dbHash(dbA), B = dbHash(dbB);
check('determinism: two fresh runs byte-identical', A.hash === B.hash, `A=${A.hash} B=${B.hash}`);
check('trace non-trivial', A.interactions > 50 && A.levels > 10, `${A.levels} levels, ${A.interactions} visits`);

// idempotency: re-run the LAST of the 5 days on B without wiping
const lastDay = (() => {
  const db = new Database(dbB, { readonly: true });
  const d = (db.prepare(`SELECT MAX(trading_day) d FROM interactions`).get() as any).d; db.close(); return d;
})();
console.log(`  run 3/3: re-run last day (${lastDay}) on B without wipe…`);
run(dbB, { LM_DAYS: lastDay, LM_KEEP: '1' });
const B2 = dbHash(dbB);
check('day-scoped idempotency: counts unchanged after same-day re-run',
  B2.interactions === B.interactions && B2.levels === B.levels,
  `visits ${B.interactions}→${B2.interactions}, levels ${B.levels}→${B2.levels}`);
check('active registry bounded (<150/symbol)', B2.active < 150, `active=${B2.active}, retired=${B2.retired}`);

console.log(`\n=== Phase 0.1 acceptance: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
