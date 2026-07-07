// CRACKER P4b · F11 — iceberg / replenishment at the level (L3-ONLY, mechanism-grade).
// The LAST untested mechanism family: hidden defensive size. Micro books don't
// show institutional behavior → L3 mini only (~12-13 days; low-N, reported honestly).
//
// PRE-REGISTERED SPEC (frozen 2026-07-07, before first run):
//   Per visit, evaluated AT THE END OF CONTACT (openTs + dwellMs — causal, the
//   moment a live decision would be made), defending side, ±K_TICKS of the level:
//   F11a ICEBERG INTENSITY: cumulative volume filled against defending resting
//        orders that revealed hidden size (filled beyond max displayed, or
//        displayed size replaced UP) and are still alive at contact end.
//   F11b SYNTHETIC REPLENISHMENT: count of fill→quick-resend chains at the
//        defending price zone during the visit (full passive fill, then a NEW
//        order posted at the same price within 1.5s — algo refill signature).
//   Secondary (context, non-gating): pulled vs added defending volume during
//        the visit (own windows — the legacy OrderBook event rings hold ~12s at
//        this event rate and would silently truncate; the script keeps its own
//        Cracker-scoped lifecycle state, per the rebuild directive).
//   Mechanism prior: hidden replenishing defense ⇒ hold ⇒ bounce (positive IC).
//   Declared horizons 5m/15m. Twin: identical computation at placebo visits.
//   NQ = primary; ES = consistency. Health gate (P0.3 open item): a day enters
//   only if the depth book is two-sided at ≥50% of its checkpoints; excluded
//   days are REPORTED, not silently dropped.
//   Mechanism-grade descriptives FIRST: % of visits with any defending iceberg,
//   median filled-hidden-size when present, refill-rate distribution.
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_p4b_f11.ts
import { DuckDBInstance } from '@duckdb/node-api';
import {
  loadVisits, splitDays, dayBoot, weightedSpearman, fmt, verdict, excl0,
  PLACEBO_POOL, HORIZONS, type VisitRow,
} from './cracker_p3_harness.js';

const ROOT = '/Users/ravikumarbasker/trading-cockpit/data';
const SYMS = ['NQ', 'ES'];
const REAL = ['swing', 'hvn', 'lvn', 'round'];
const DECLARED = [5, 15];
const TICK = 0.25;
const K_TICKS = { NQ: 16, ES: 4 } as Record<string, number>;   // defend zone, matches LM tape window
const REFILL_MS = 1500;
const et = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-04:00`);

interface F11Row { ice: number; refills: number; pulled: number; added: number; }
type Key = string; // `${levelId}|${closeTs}`

// ── Cracker-scoped order lifecycle (send/replace/cancel/trade w/ passive ids) ──
interface Ord { p: number; s: number; bid: boolean; md: number; cf: number; ru: boolean; }

async function runSymbol(sym: string): Promise<void> {
  const { rows, days } = loadVisits(sym);
  const K = K_TICKS[sym]!;
  const feats = new Map<Key, F11Row>();
  const dayHealth = new Map<string, { ok: number; bad: number }>();
  const inst = await DuckDBInstance.create();
  const con = await inst.connect();

  const byDay = new Map<string, VisitRow[]>();
  for (const r of rows) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day)!.push(r); }

  for (const day of days) {
    const visits = (byDay.get(day) ?? []).filter((v) => v.openTs != null && v.dwellMs != null);
    if (!visits.length) continue;
    // checkpoints: end-of-contact per visit, ascending
    const cps = visits.map((v) => ({ v, t: v.openTs + v.dwellMs, lvInt: Math.round(v.levelPrice / TICK) }))
      .sort((a, b) => a.t - b.t);
    let cpi = 0;

    // active-visit accumulators, bucketed by coarse price zone for O(1) event routing
    const BUCKET = Math.max(K, 8);
    const active = new Map<Key, { lvInt: number; defBid: boolean; openTs: number; endTs: number; pulled: number; added: number; refills: number }>();
    const buckets = new Map<number, Set<Key>>();
    const bIdx = (pi: number) => Math.floor(pi / BUCKET);
    const activate = (v: VisitRow) => {
      const lvInt = Math.round(v.levelPrice / TICK);
      const key = `${v.levelId}|${v.closeTs}`;
      const a = { lvInt, defBid: v.side === 'support', openTs: v.openTs, endTs: v.openTs + v.dwellMs, pulled: 0, added: 0, refills: 0 };
      active.set(key, a);
      const bi = bIdx(lvInt);
      for (const b of [bi - 1, bi, bi + 1]) { if (!buckets.has(b)) buckets.set(b, new Set()); buckets.get(b)!.add(key); }
    };
    const deactivate = (key: Key, lvInt: number) => {
      const bi = bIdx(lvInt);
      for (const b of [bi - 1, bi, bi + 1]) buckets.get(b)?.delete(key);
      active.delete(key);
    };
    const opens = [...visits].sort((a, b) => a.openTs - b.openTs);
    let oi = 0;

    // lifecycle state
    const orders = new Map<string, Ord>();
    const hot = new Map<string, Ord>();                      // orders that revealed hidden size
    const recentFill = new Map<number, number>();            // priceInt → ts of last FULL passive fill
    let twoSided = 0, oneSided = 0;
    const bidPx = new Map<number, number>(), askPx = new Map<number, number>();  // depth ladder (health only)

    const route = (pi: number, fn: (a: { lvInt: number; defBid: boolean; openTs: number; endTs: number; pulled: number; added: number; refills: number }) => void, wantBid?: boolean) => {
      const set = buckets.get(bIdx(pi));
      if (!set) return;
      for (const key of set) {
        const a = active.get(key)!;
        if (Math.abs(pi - a.lvInt) > K) continue;
        if (wantBid !== undefined && a.defBid !== wantBid) continue;
        fn(a);
      }
    };

    const g = (t: string) => `read_parquet('${ROOT}/mbo-parquet/${t}/symbol=${sym}/date=${day}/*.parquet', filename=true, file_row_number=true)`;
    const dom = `(SELECT contract FROM read_parquet('${ROOT}/mbo-parquet/trades/symbol=${sym}/date=${day}/*.parquet') WHERE ts_ms >= ${et(day, '09:30')} AND ts_ms < ${et(day, '16:00')} GROUP BY contract ORDER BY SUM(size) DESC LIMIT 1)`;
    const [lo, hi] = [et(day, '09:00'), et(day, '16:05')];
    const SQL = `
      SELECT ts_ms,'D' s, price_int, size, is_bid, CAST(NULL AS VARCHAR) a, CAST(NULL AS VARCHAR) oid, CAST(NULL AS VARCHAR) pid, filename fn, file_row_number frn
        FROM ${g('depth')} WHERE contract = ${dom} AND ts_ms BETWEEN ${lo} AND ${hi}
      UNION ALL SELECT ts_ms,'M', price_int, size, is_bid, action, order_id, CAST(NULL AS VARCHAR), filename, file_row_number
        FROM ${g('mbo')} WHERE contract = ${dom} AND ts_ms BETWEEN ${lo} AND ${hi}
      UNION ALL SELECT ts_ms,'T', price_int, size, CAST(NULL AS BOOLEAN), CAST(NULL AS VARCHAR), aggressor_order_id, passive_order_id, filename, file_row_number
        FROM ${g('trades')} WHERE contract = ${dom} AND size > 0 AND NOT is_otc AND ts_ms BETWEEN ${lo} AND ${hi}
      ORDER BY ts_ms, s, fn, frn`;
    const stream = await con.stream(SQL);
    let chunk;
    while ((chunk = await stream.fetchChunk()) && chunk.rowCount > 0) {
      for (const row of chunk.getRows() as any[]) {
        const ts = Number(row[0]);
        // fire checkpoints (evaluate iceberg state + freeze accumulators)
        while (cpi < cps.length && cps[cpi]!.t <= ts) {
          const c = cps[cpi]!;
          const key = `${c.v.levelId}|${c.v.closeTs}`;
          const a = active.get(key);
          let iceFilled = 0;
          const want = c.v.side === 'support';
          for (const o of hot.values()) if (o.bid === want && Math.abs(o.p - c.lvInt) <= K) iceFilled += o.cf;
          feats.set(key, { ice: iceFilled, refills: a?.refills ?? 0, pulled: a?.pulled ?? 0, added: a?.added ?? 0 });
          if (a) deactivate(key, a.lvInt);
          // health sample at each checkpoint
          if (bidPx.size && askPx.size) twoSided++; else oneSided++;
          cpi++;
        }
        while (oi < opens.length && opens[oi]!.openTs <= ts) { activate(opens[oi]!); oi++; }

        const typ = row[1] as string;
        if (typ === 'D') {
          const pi = Number(row[2]), sz = Number(row[3]);
          const m = row[4] ? bidPx : askPx;
          if (!sz) m.delete(pi); else m.set(pi, sz);
          continue;
        }
        if (typ === 'M') {
          const pi = Number(row[2]), sz = Number(row[3]), isBid = !!row[4], action = row[5] as string, oid = row[6] as string;
          if (action === 'send') {
            orders.set(oid, { p: pi, s: sz, bid: isBid, md: sz, cf: 0, ru: false });
            const ft = recentFill.get(pi);
            if (ft != null && ts - ft <= REFILL_MS) route(pi, (a) => { if (ts >= a.openTs && ts <= a.endTs) a.refills++; }, isBid);
            route(pi, (a) => { if (ts >= a.openTs && ts <= a.endTs) a.added += sz; }, isBid);
          } else if (action === 'replace') {
            const o = orders.get(oid);
            if (o) {
              if (sz > o.s) { o.ru = true; hot.set(oid, o); }
              if (sz > o.md) o.md = sz;
              o.p = pi; o.s = sz;
            }
          } else if (action === 'cancel') {
            const o = orders.get(oid);
            if (o) { route(o.p, (a) => { if (ts >= a.openTs && ts <= a.endTs) a.pulled += o.s; }, o.bid); orders.delete(oid); hot.delete(oid); }
          }
          continue;
        }
        // trade: decrement passive order, arm refills, flag hidden size
        const pid = row[7] as string | null, sz = Number(row[3]);
        if (!pid) continue;
        const o = orders.get(pid);
        if (!o) continue;
        o.cf += sz;
        if (o.cf > o.md) hot.set(pid, o);
        if (o.s <= sz) { recentFill.set(o.p, ts); orders.delete(pid); hot.delete(pid); }
        else o.s -= sz;
      }
    }
    // flush unfired checkpoints (visits closing after data end)
    while (cpi < cps.length) { const c = cps[cpi++]!; feats.set(`${c.v.levelId}|${c.v.closeTs}`, { ice: 0, refills: 0, pulled: 0, added: 0 }); }
    dayHealth.set(day, { ok: twoSided, bad: oneSided });
    process.stderr.write(`  ${day}: ${visits.length} visits · health ${twoSided}/${twoSided + oneSided} two-sided · live orders ${((): number => orders.size)()}\n`);
  }

  // health gate
  const healthy = new Set([...dayHealth.entries()].filter(([, h]) => h.ok + h.bad === 0 || h.ok / (h.ok + h.bad) >= 0.5).map(([d]) => d));
  const excluded = days.filter((d) => dayHealth.has(d) && !healthy.has(d));
  console.log(`\n## ${sym} — ${days.length} days, EXCLUDED by book-health gate: ${excluded.length ? excluded.join(', ') : 'none'}`);

  const pool = rows.filter((r) => healthy.has(r.day));
  const val = (f: (x: F11Row) => number) => (r: VisitRow): number | null => {
    const x = feats.get(`${r.levelId}|${r.closeTs}`);
    return x ? f(x) : null;
  };
  // mechanism-grade descriptives
  const realFeats = pool.filter((r) => REAL.includes(r.source)).map((r) => feats.get(`${r.levelId}|${r.closeTs}`)).filter((x): x is F11Row => !!x);
  const withIce = realFeats.filter((x) => x.ice > 0);
  const withRef = realFeats.filter((x) => x.refills > 0);
  const med = (a: number[]) => (a.length ? a.sort((p, q) => p - q)[a.length >> 1] : 0);
  console.log(`  descriptives (real visits, n=${realFeats.length}): iceberg present ${(100 * withIce.length / Math.max(realFeats.length, 1)).toFixed(1)}% (median hidden-filled ${med(withIce.map((x) => x.ice))} lots) · refills present ${(100 * withRef.length / Math.max(realFeats.length, 1)).toFixed(1)}% · pulled>added in ${(100 * realFeats.filter((x) => x.pulled > x.added).length / Math.max(realFeats.length, 1)).toFixed(1)}%`);

  const { train, valid } = splitDays([...new Set(pool.map((r) => r.day))].sort());
  const tr = pool.filter((r) => train.has(r.day)), va = pool.filter((r) => valid.has(r.day));
  const icStat = (p: string[], h: number, value: (r: VisitRow) => number | null) => (rs: VisitRow[]): number => {
    const x: number[] = [], y: number[] = [], w: number[] = [];
    for (const r of rs) {
      const v = value(r);
      if (!p.includes(r.source) || v == null || r.y[h] == null) continue;
      x.push(v); y.push(r.y[h]!); w.push(r.uniq);
    }
    return x.length >= 30 ? weightedSpearman(x, y, w) : NaN;
  };
  for (const [tag, f] of [['F11a ice', (x: F11Row) => x.ice], ['F11b refill', (x: F11Row) => x.refills]] as const) {
    for (const h of HORIZONS) {
      const declared = DECLARED.includes(h);
      const icTr = dayBoot(tr, icStat(REAL, h, val(f)), 8100 + h);
      const icVa = dayBoot(va, icStat(REAL, h, val(f)), 8200 + h);
      const twVa = dayBoot(va, icStat(PLACEBO_POOL, h, val(f)), 8200 + h);
      const dfVa = dayBoot(va, (rs: VisitRow[]) => icStat(REAL, h, val(f))(rs) - icStat(PLACEBO_POOL, h, val(f))(rs), 8200 + h);
      const beats = (excl0(icVa) && !excl0(twVa)) || (excl0(icVa) && excl0(twVa) && excl0(dfVa));
      const nOf = (rs: VisitRow[]) => rs.filter((r) => REAL.includes(r.source) && val(f)(r) != null && r.y[h] != null).length;
      icTr.n = nOf(tr); icVa.n = nOf(va);
      const v = declared ? `  → ${verdict(sym, h, icTr, icVa, beats, 'ic')}` : '';
      console.log(`  ${tag} IC(${String(h).padStart(2)}m): train ${fmt(icTr)} | valid ${fmt(icVa)} | twin ${fmt(twVa)}${v}${declared ? ' [declared]' : ''}`);
    }
  }
}

async function main() {
  console.log('=== P4b · F11 — iceberg/replenishment at the level (L3-only, mechanism-grade) ===');
  for (const sym of SYMS) await runSymbol(sym);
  console.log('\nVerdict rule: EDGE = train & validation IC CI95 exclude 0, same sign, beats twin (5m/15m, ρ*=0.05).');
}
main().catch((e) => { console.error(e); process.exit(1); });
