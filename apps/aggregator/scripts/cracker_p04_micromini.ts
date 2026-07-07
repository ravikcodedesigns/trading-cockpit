// CRACKER Phase 0.4 — micro-vs-mini footprint agreement (CRACKER_PLAN.md §0.4).
//
// We plan to SCREEN flow patterns on micro data (54-day L2 set, statistical
// power) and CONFIRM on mini (institutional truth). That only works if the two
// crowds' footprints actually look alike. This measures how alike, per feature
// family, and produces the ROUTING TABLE.
//
// Design: BOTH contracts come from the same Bookmap capture (same clock, same
// recorder) — comparing NQ-mini vs MNQ-micro within L3 isolates the crowd
// difference from feed artifacts. Aggressor = the certified native flag
// (true ⇔ BUY, P0.3). No book replay needed → pure SQL + light JS, all days.
//
// Metrics per day (RTH, dominant contract each side):
//   • delta family    — per-minute signed-delta Pearson r (and 5-min)
//   • profile family  — per-bin volume correlation, POC distance (pts),
//                       70% value-area Jaccard overlap
//   • imbalance family— per-bin diagonal imbalance category (buy/sell/none,
//                       binomial z≥2 as in footprint.ts) → Cohen's κ
//                       (chance-corrected; raw % agreement flatters)
//
// This is ESTIMATION, not hypothesis testing (plan §0.4): report distributions
// + CIs. Provisional routing rules (pre-stated): delta micro-OK if mean r1m≥0.90
// (both-with-correction 0.75–0.90, else mini-only); profile micro-OK if median
// |POC dist| ≤ 4pt (one bin); imbalance micro-OK if κ≥0.60 (both 0.40–0.60,
// else mini-only).
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_p04_micromini.ts
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';

const ROOT = '/Users/ravikumarbasker/trading-cockpit/data/mbo-parquet/trades';
const PAIRS = [
  { name: 'NQ/MNQ', mini: 'NQ', micro: 'MNQ', tick: 0.25, binTicks: 4 },   // 1pt bins (FP_CFG NQ)
  { name: 'ES/MES', mini: 'ES', micro: 'MES', tick: 0.25, binTicks: 1 },   // 0.25pt bins (FP_CFG ES)
];
const EXCLUDE = new Set(['2026-06-29']);
const et = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-04:00`);
const MINZ = 2.0;

const daysOf = (sym: string) => new Set(fs.existsSync(`${ROOT}/symbol=${sym}`)
  ? fs.readdirSync(`${ROOT}/symbol=${sym}`).filter((x) => x.startsWith('date=')).map((x) => x.slice(5)) : []);
const dom = (sym: string, d: string) => `(SELECT contract FROM read_parquet('${ROOT}/symbol=${sym}/date=${d}/*.parquet')
  WHERE ts_ms >= ${et(d, '09:30')} AND ts_ms < ${et(d, '16:00')} GROUP BY contract ORDER BY SUM(size) DESC LIMIT 1)`;

function pearson(a: number[], b: number[]): number {
  const n = a.length; if (n < 10) return NaN;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < n; i++) { sa += a[i]!; sb += b[i]!; saa += a[i]! ** 2; sbb += b[i]! ** 2; sab += a[i]! * b[i]!; }
  const cov = sab - sa * sb / n, va = saa - sa * sa / n, vb = sbb - sb * sb / n;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
}
const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / Math.max(1, x.length);
const median = (x: number[]) => { const s = [...x].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const sd = (x: number[]) => { const m = mean(x); return Math.sqrt(mean(x.map((v) => (v - m) ** 2))); };

/** per-minute signed delta (native flag) over RTH. */
async function minuteDelta(con: any, sym: string, d: string): Promise<Float64Array> {
  const [lo, hi] = [et(d, '09:30'), et(d, '16:00')];
  const n = Math.ceil((hi - lo) / 60_000), out = new Float64Array(n);
  const r = await con.streamAndReadAll(`SELECT CAST(FLOOR((ts_ms - ${lo}) / 60000) AS BIGINT) m,
      SUM(size * CASE WHEN is_bid_aggressor THEN 1 ELSE -1 END) d
    FROM read_parquet('${ROOT}/symbol=${sym}/date=${d}/*.parquet')
    WHERE contract = ${dom(sym, d)} AND size > 0 AND NOT is_otc AND ts_ms >= ${lo} AND ts_ms < ${hi} GROUP BY 1`);
  for (const row of r.getRows() as any[]) { const m = Number(row[0]); if (m >= 0 && m < n) out[m] = Number(row[1]); }
  return out;
}

/** session profile per price bin: Map<bin, {buy, sell}>. */
async function profile(con: any, sym: string, d: string, tick: number, binTicks: number): Promise<Map<number, { buy: number; sell: number }>> {
  const [lo, hi] = [et(d, '09:30'), et(d, '16:00')];
  const r = await con.streamAndReadAll(`SELECT CAST(FLOOR(ROUND(price / ${tick}) / ${binTicks}) AS BIGINT) b,
      SUM(CASE WHEN is_bid_aggressor THEN size ELSE 0 END) buy, SUM(CASE WHEN is_bid_aggressor THEN 0 ELSE size END) sell
    FROM read_parquet('${ROOT}/symbol=${sym}/date=${d}/*.parquet')
    WHERE contract = ${dom(sym, d)} AND size > 0 AND NOT is_otc AND ts_ms >= ${lo} AND ts_ms < ${hi} GROUP BY 1`);
  const m = new Map<number, { buy: number; sell: number }>();
  for (const row of r.getRows() as any[]) m.set(Number(row[0]), { buy: Number(row[1]), sell: Number(row[2]) });
  return m;
}

/** POC bin + 70% value-area [loBin, hiBin] from a profile. */
function pocVA(p: Map<number, { buy: number; sell: number }>): { poc: number; lo: number; hi: number } {
  const bins = [...p.entries()].map(([b, c]) => ({ b, v: c.buy + c.sell })).sort((a, b) => a.b - b.b);
  let pi = 0; for (let i = 1; i < bins.length; i++) if (bins[i]!.v > bins[pi]!.v) pi = i;
  const total = bins.reduce((s, x) => s + x.v, 0);
  let lo = pi, hi = pi, cov = bins[pi]!.v;
  while (cov < 0.7 * total && (lo > 0 || hi < bins.length - 1)) {
    const below = lo > 0 ? bins[lo - 1]!.v : -1, above = hi < bins.length - 1 ? bins[hi + 1]!.v : -1;
    if (above >= below) { hi++; cov += bins[hi]!.v; } else { lo--; cov += bins[lo]!.v; }
  }
  return { poc: bins[pi]!.b, lo: bins[lo]!.b, hi: bins[hi]!.b };
}

/** diagonal imbalance category per bin ('buy'|'sell'|'none'), binomial z≥MINZ (as footprint.ts). */
function imbCats(p: Map<number, { buy: number; sell: number }>): Map<number, string> {
  const z = (a: number, b: number) => { const n = a + b; return n > 0 ? (a - b) / Math.sqrt(n) : 0; };
  const out = new Map<number, string>();
  for (const [b, c] of p) {
    const below = p.get(b - 1), above = p.get(b + 1);
    let cat = 'none';
    if (below && z(c.buy, below.sell) >= MINZ) cat = 'buy';
    else if (above && z(c.sell, above.buy) >= MINZ) cat = 'sell';
    out.set(b, cat);
  }
  return out;
}

/** Cohen's κ over bins present in both. */
function kappa(a: Map<number, string>, b: Map<number, string>): number {
  const keys = [...a.keys()].filter((k) => b.has(k));
  if (keys.length < 10) return NaN;
  const cats = ['buy', 'sell', 'none'];
  let agree = 0; const pa = new Map(cats.map((c) => [c, 0])), pb = new Map(cats.map((c) => [c, 0]));
  for (const k of keys) {
    const ca = a.get(k)!, cb = b.get(k)!;
    if (ca === cb) agree++;
    pa.set(ca, pa.get(ca)! + 1); pb.set(cb, pb.get(cb)! + 1);
  }
  const n = keys.length, po = agree / n;
  const pe = cats.reduce((s, c) => s + (pa.get(c)! / n) * (pb.get(c)! / n), 0);
  return pe < 1 ? (po - pe) / (1 - pe) : NaN;
}

async function main() {
  const inst = await DuckDBInstance.create();
  const con = await inst.connect();
  for (const P of PAIRS) {
    const days = [...daysOf(P.mini)].filter((d) => daysOf(P.micro).has(d) && !EXCLUDE.has(d)).sort();
    console.log(`\n═══ ${P.name} — mini vs micro, same Bookmap capture (${days.length} candidate days) ═══`);
    console.log(`day          r(Δ1m)  r(Δ5m)  profile-r  |POCdist|pt  VA-Jaccard   κ(imb)   vol mini/micro`);
    const r1s: number[] = [], r5s: number[] = [], prs: number[] = [], pocs: number[] = [], jacs: number[] = [], ks: number[] = [];
    for (const d of days) {
      try {
        const dMini = await minuteDelta(con, P.mini, d);
        const dMicro = await minuteDelta(con, P.micro, d);
        const vMini = dMini.reduce((s, v) => s + Math.abs(v), 0), vMicro = dMicro.reduce((s, v) => s + Math.abs(v), 0);
        if (vMini < 1000 || vMicro < 1000) { console.log(`${d}   (thin — skipped)`); continue; }
        const r1 = pearson(Array.from(dMini), Array.from(dMicro));
        const agg5 = (x: Float64Array) => { const o: number[] = []; for (let i = 0; i < x.length; i += 5) { let s = 0; for (let j = i; j < Math.min(i + 5, x.length); j++) s += x[j]!; o.push(s); } return o; };
        const r5 = pearson(agg5(dMini), agg5(dMicro));
        const pMini = await profile(con, P.mini, d, P.tick, P.binTicks);
        const pMicro = await profile(con, P.micro, d, P.tick, P.binTicks);
        const union = new Set([...pMini.keys(), ...pMicro.keys()]);
        const va: number[] = [], vb: number[] = [];
        for (const b of union) { const x = pMini.get(b), y = pMicro.get(b); va.push((x?.buy ?? 0) + (x?.sell ?? 0)); vb.push((y?.buy ?? 0) + (y?.sell ?? 0)); }
        const pr = pearson(va, vb);
        const A = pocVA(pMini), B = pocVA(pMicro);
        const pocDist = Math.abs(A.poc - B.poc) * P.tick * P.binTicks;
        const iLo = Math.max(A.lo, B.lo), iHi = Math.min(A.hi, B.hi), uLo = Math.min(A.lo, B.lo), uHi = Math.max(A.hi, B.hi);
        const jac = uHi > uLo ? Math.max(0, iHi - iLo) / (uHi - uLo) : NaN;
        const k = kappa(imbCats(pMini), imbCats(pMicro));
        r1s.push(r1); r5s.push(r5); prs.push(pr); pocs.push(pocDist); jacs.push(jac); if (!isNaN(k)) ks.push(k);
        console.log(`${d}    ${r1.toFixed(3)}   ${r5.toFixed(3)}    ${pr.toFixed(3)}      ${pocDist.toFixed(1).padStart(6)}      ${jac.toFixed(2)}       ${isNaN(k) ? '  n/a' : k.toFixed(3)}      ${(vMini / vMicro).toFixed(2)}`);
      } catch (e: any) { console.log(`${d}   ERR ${e.message.slice(0, 60)}`); }
    }
    if (!r1s.length) continue;
    console.log(`--- ${P.name} summary (n=${r1s.length} days):`);
    console.log(`    delta:    r1m ${mean(r1s).toFixed(3)} ± ${sd(r1s).toFixed(3)}   r5m ${mean(r5s).toFixed(3)} ± ${sd(r5s).toFixed(3)}`);
    console.log(`    profile:  vol-r ${mean(prs).toFixed(3)} ± ${sd(prs).toFixed(3)}   median|POCdist| ${median(pocs).toFixed(1)}pt   VA-Jaccard ${mean(jacs).toFixed(2)}`);
    console.log(`    imbalance: κ ${mean(ks).toFixed(3)} ± ${sd(ks).toFixed(3)} (n=${ks.length})`);
    const route = (v: number, hi: number, lo: number) => v >= hi ? 'micro-OK' : v >= lo ? 'BOTH-with-correction' : 'mini-ONLY';
    console.log(`    ROUTING (provisional rules from header):`);
    console.log(`      delta family:     ${route(mean(r1s), 0.90, 0.75)}   (r1m ${mean(r1s).toFixed(3)})`);
    console.log(`      profile family:   ${median(pocs) <= 4 ? 'micro-OK' : 'BOTH-with-correction'}   (median POC dist ${median(pocs).toFixed(1)}pt)`);
    console.log(`      imbalance family: ${route(mean(ks), 0.60, 0.40)}   (κ ${mean(ks).toFixed(3)})`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
