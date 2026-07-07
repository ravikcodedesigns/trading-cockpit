// CRACKER P1.6 acceptance — volume-profile.ts (kernel profile + HVN/LVN + structural 1R).
//
// Synthetic ground-truth recovery FIRST (the module must recover known densities
// before it touches market data), then property tests, then one real-day sanity
// pass on the L3 mini store. Deterministic throughout (seeded LCG, no Math.random).
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_p16_accept.ts
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';
import { computeProfile, structuralStopDist, VP_CFG, type ProfileInput } from '../src/l3/volume-profile.js';

const TICK = 0.25;
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

// ── deterministic synthetic trade generator ───────────────────────────────────
function lcg(seed: number) { let s = seed >>> 0; return () => (s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32; }
function gauss(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-12), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** Mixture of Gaussians → exact ProfileInput (prices snapped to tick). */
function synth(modes: Array<{ mu: number; sd: number; w: number }>, n: number, seed: number, sizes: number[] = [1, 2, 3, 4, 5]): ProfileInput {
  const rnd = lcg(seed);
  const hist = new Map<number, number>();
  let totVol = 0, totVolSq = 0;
  const cum: number[] = [];
  let acc = 0; for (const m of modes) { acc += m.w; cum.push(acc); }
  for (let i = 0; i < n; i++) {
    const u = rnd() * acc;
    const m = modes[cum.findIndex((c) => u <= c)]!;
    const px = Math.round((m.mu + m.sd * gauss(rnd)) / TICK) * TICK;
    const sz = sizes[Math.floor(rnd() * sizes.length)]!;
    hist.set(px, (hist.get(px) ?? 0) + sz);
    totVol += sz; totVolSq += sz * sz;
  }
  return { pxVol: [...hist.entries()].map(([price, vol]) => ({ price, vol })), totVol, totVolSq, tick: TICK };
}
const silvermanH = (input: ProfileInput): number => {
  // reproduce the module's fallback formula for the ISJ-beats-Silverman check
  const tot = input.totVol;
  let mu = 0; for (const b of input.pxVol) mu += b.price * b.vol; mu /= tot;
  let va = 0; for (const b of input.pxVol) va += b.vol * (b.price - mu) ** 2; va /= tot;
  const srt = [...input.pxVol].sort((a, b) => a.price - b.price);
  const q = (f: number) => { let a = 0; for (const b of srt) { a += b.vol; if (a >= f * tot) return b.price; } return srt[srt.length - 1]!.price; };
  const nEff = tot * tot / input.totVolSq;
  return 0.9 * Math.min(Math.sqrt(va), (q(0.75) - q(0.25)) / 1.34) * Math.pow(nEff, -1 / 5);
};

async function main() {
  console.log('=== P1.6 ACCEPTANCE — volume-profile ===\n-- synthetic ground truth --');

  // T1 bimodal recovery: modes 80pt apart must BOTH surface as HVNs, valley as LVN
  const bi = synth([{ mu: 20000, sd: 8, w: 1 }, { mu: 20080, sd: 8, w: 1 }], 40_000, 42);
  const pBi = computeProfile(bi)!;
  const near = (arr: number[], x: number, tol: number) => arr.some((p) => Math.abs(p - x) <= tol);
  const hv = pBi.hvns.map((n) => n.price), lv = pBi.lvns.map((n) => n.price);
  check('T1a bimodal: both modes recovered as HVNs (±3pt)', near(hv, 20000, 3) && near(hv, 20080, 3), `hvns [${hv.map((p) => p.toFixed(0)).join(', ')}]`);
  check('T1b bimodal: valley recovered as LVN (20040 ±6pt)', near(lv, 20040, 6), `lvns [${lv.map((p) => p.toFixed(0)).join(', ')}]`);
  check('T1c bimodal: no spurious extrema', pBi.hvns.length === 2 && pBi.lvns.length === 1, `${pBi.hvns.length} HVN, ${pBi.lvns.length} LVN`);
  check('T1d POC is the global max and first in the HVN set', Math.abs(pBi.poc - pBi.hvns[0]!.price) < 1e-9);

  // T2 trimodal: 3 HVNs, 2 LVNs, correct ordering
  const tri = synth([{ mu: 20000, sd: 7, w: 1.2 }, { mu: 20060, sd: 7, w: 1 }, { mu: 20130, sd: 7, w: 0.9 }], 60_000, 7);
  const pTri = computeProfile(tri)!;
  const hvT = pTri.hvns.map((n) => n.price).sort((a, b) => a - b);
  check('T2a trimodal: 3 HVNs at the 3 modes (±3pt)', pTri.hvns.length === 3 && near(hvT, 20000, 3) && near(hvT, 20060, 3) && near(hvT, 20130, 3), `[${hvT.map((p) => p.toFixed(0)).join(', ')}]`);
  const lvT = pTri.lvns.map((n) => n.price).sort((a, b) => a - b);
  check('T2b trimodal: 2 LVNs at the 2 valleys', pTri.lvns.length === 2 && near(lvT, 20030, 8) && near(lvT, 20095, 8), `[${lvT.map((p) => p.toFixed(0)).join(', ')}]`);
  check('T2c LVNs strictly between outermost HVNs', lvT.every((p) => p > hvT[0]! && p < hvT[hvT.length - 1]!));

  // T3 single mode: 1 HVN, 0 LVN
  const uni1 = computeProfile(synth([{ mu: 20050, sd: 12, w: 1 }], 30_000, 3))!;
  check('T3 single mode: exactly 1 HVN (±3pt), 0 LVN', uni1.hvns.length === 1 && Math.abs(uni1.hvns[0]!.price - 20050) <= 3 && uni1.lvns.length === 0);

  // T4 uniform: prominence filter kills wiggle extrema; fallback path exercised without crash
  const flat: ProfileInput = { pxVol: [], totVol: 0, totVolSq: 0, tick: TICK };
  for (let p = 20000; p <= 20200; p += TICK) { flat.pxVol.push({ price: p, vol: 10 }); flat.totVol += 10; flat.totVolSq += 100 * 10 / 10; }
  flat.totVolSq = flat.totVol * 10;   // ~10-lot prints: Σs² = Σs · 10
  const pFlat = computeProfile(flat)!;
  check('T4 uniform: ≤1 HVN (trivial POC), 0 LVN', pFlat.hvns.length <= 1 && pFlat.lvns.length === 0, `method=${pFlat.bandwidthMethod}`);

  // T5 determinism: byte-identical repeat
  const a = JSON.stringify({ ...computeProfile(bi)!, density: undefined });
  const b = JSON.stringify({ ...computeProfile(bi)!, density: undefined });
  check('T5 determinism: identical output on identical input', a === b);

  // T6 ISJ resolves multimodality better than the normal-reference rule
  check('T6 ISJ engaged and < Silverman on bimodal data', pBi.bandwidthMethod === 'isj' && pBi.bandwidth < silvermanH(bi), `isj ${pBi.bandwidth.toFixed(2)}pt vs silverman ${silvermanH(bi).toFixed(2)}pt`);

  // T7 Kish: blockier prints (same histogram, larger Σs²) → lower n_eff → wider
  // bandwidth. THIN sample so the selector sits ABOVE the structural floor —
  // on a liquid session both variants clamp to the floor and the check is vacuous.
  const thin = synth([{ mu: 20000, sd: 12, w: 1 }, { mu: 20070, sd: 12, w: 1 }], 900, 11);
  const pThin = computeProfile(thin)!;
  const pBlockyThin = computeProfile({ ...thin, totVolSq: thin.totVolSq * 12 })!;
  check('T7 Kish n_eff: blocky prints widen the bandwidth (thin sample, above floor)',
    pThin.bandwidth > VP_CFG.H_FLOOR_PTS && pBlockyThin.bandwidth > pThin.bandwidth && pBlockyThin.nEff < pThin.nEff,
    `h ${pThin.bandwidth.toFixed(2)}→${pBlockyThin.bandwidth.toFixed(2)}pt, n_eff ${Math.round(pThin.nEff)}→${Math.round(pBlockyThin.nEff)}`);

  // T8 clamps + degenerate-input guards
  check('T8a bandwidth within [max(2 ticks, structural floor), range/10]',
    pBi.bandwidth >= Math.max(2 * TICK, VP_CFG.H_FLOOR_PTS) && pBi.bandwidth <= (pBi.gridHi - pBi.gridLo) * VP_CFG.H_HI_FRAC + 1e-9);
  check('T8b structural floor engaged on liquid sessions', pBi.bandwidth === VP_CFG.H_FLOOR_PTS, `h=${pBi.bandwidth}pt`);
  check('T8c degenerate inputs → null', computeProfile({ pxVol: [{ price: 20000, vol: 5 }], totVol: 5, totVolSq: 25, tick: TICK }) === null
    && computeProfile({ pxVol: [], totVol: 0, totVolSq: 0, tick: TICK }) === null);

  // T9 value area sane (descriptive only)
  const va = pBi;
  let inVA = 0, dTot = 0;
  for (let k = 0; k < va.density.length; k++) {
    const px = va.gridLo + k * TICK;
    dTot += va.density[k]!;
    if (px >= va.vaLo && px <= va.vaHi) inVA += va.density[k]!;
  }
  check('T9 value area covers 68–75% of smoothed volume', inVA / dTot >= 0.68 && inVA / dTot <= 0.75, `${(100 * inVA / dTot).toFixed(1)}%`);

  // T10 structural stop geometry (frozen 1R rule)
  const lvns = [19990, 20030];
  check('T10a long: nearest LVN below, 1 tick beyond', structuralStopDist(lvns, 20000, 20001, 1, 10, TICK) === 20001 - (19990 - TICK));
  check('T10b short: nearest LVN above, 1 tick beyond', structuralStopDist(lvns, 20000, 19999, -1, 10, TICK) === (20030 + TICK) - 19999);
  check('T10c LVN outside 5×σfloor window → null', structuralStopDist(lvns, 20000, 20001, 1, 1, TICK) === null);
  check('T10d degenerate geometry (entry beyond stop) → null', structuralStopDist([19999], 20000, 19998, 1, 10, TICK) === null);
  check('T10e no LVN on the stop side → null', structuralStopDist([20030], 20000, 20001, 1, 10, TICK) === null);

  // ── real-day sanity (L3 mini store) ──
  console.log('\n-- real-day sanity --');
  const ROOT = '/Users/ravikumarbasker/trading-cockpit/data';
  const dir = `${ROOT}/mbo-parquet/trades/symbol=NQ`;
  const days = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.startsWith('date=')).map((x) => x.slice(5)).sort() : [];
  const targets = ['2026-06-17', '2026-06-25', '2026-07-02'].filter((d) => days.includes(d));
  if (!targets.length) { check('T11 real days available', false, 'mbo-parquet store not found'); }
  const inst = await DuckDBInstance.create();
  const con = await inst.connect();
  for (const day of targets) {
    const et = (hm: string) => Date.parse(`${day}T${hm}:00-04:00`);
    const src = `read_parquet('${ROOT}/mbo-parquet/trades/symbol=NQ/date=${day}/*.parquet')`;
    const dom = `(SELECT contract FROM ${src} WHERE ts_ms >= ${et('09:30')} AND ts_ms < ${et('16:00')} GROUP BY contract ORDER BY SUM(size) DESC LIMIT 1)`;
    const where = `contract = ${dom} AND size > 0 AND NOT is_otc AND ts_ms >= ${et('09:30')} AND ts_ms < ${et('16:00')}`;
    const rows = (await con.streamAndReadAll(`SELECT price, SUM(size) FROM ${src} WHERE ${where} GROUP BY price`)).getRows();
    const tot = (await con.streamAndReadAll(`SELECT SUM(size), SUM(size*size), COUNT(*) FROM ${src} WHERE ${where}`)).getRows()[0]!;
    const input: ProfileInput = {
      pxVol: rows.map((r: any) => ({ price: Number(r[0]), vol: Number(r[1]) })),
      totVol: Number(tot[0]), totVolSq: Number(tot[1]), tick: TICK,
    };
    const p = computeProfile(input);
    if (!p) { check(`T11 ${day}: profile computed`, false); continue; }
    const lo = Math.min(...input.pxVol.map((x) => x.price)), hi = Math.max(...input.pxVol.map((x) => x.price));
    const hvP = p.hvns.map((n) => n.price), lvP = p.lvns.map((n) => n.price);
    const okStruct = p.poc >= lo && p.poc <= hi && p.hvns.length >= 1 && p.hvns.length <= 20
      && lvP.every((x) => x > Math.min(...hvP) && x < Math.max(...hvP))
      && p.vaLo < p.poc && p.poc < p.vaHi && p.nEff < Number(tot[2]);
    check(`T11 ${day}: structure sane`, okStruct,
      `h=${p.bandwidth.toFixed(2)}pt(${p.bandwidthMethod}) n_eff=${Math.round(p.nEff)} POC=${p.poc} HVN×${p.hvns.length} LVN×${p.lvns.length} VA[${p.vaLo},${p.vaHi}]`);
  }

  console.log(`\n${pass}/${pass + fail} checks passed${fail ? ' — FAILURES ABOVE' : ''}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
