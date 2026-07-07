// trace.ts — CRACKER Phase 1: the TRACE engine (per-visit features + outcomes).
//
// Sits beside LevelMemory (via LmHooks) and writes three sibling tables keyed to
// the spine's `interactions`: visit_features (the Tier-2 auction read),
// visit_outcomes (markouts + dual-direction barrier labels + uniqueness/cluster),
// day_context (per-day drift/regime columns). Composable — no spine schema churn.
//
// Aggressor source = the NATIVE flag (true ⇔ BUY), per P0.3 certification.
//
// THREE-PHASE visit read (Carmine's attack→absorb→resolve, made computable):
//   approach   — trades within 3×band of the level in the 60s BEFORE the visit
//                opens (captured via a rolling ring buffer — the "attack")
//   contact    — trades within 1×band while the visit is open (the "auction")
//   resolution — trades in the departure zone after the last in-band touch
// Features per phase: signed delta, volume, trade count; contact additionally
// gets size-aware imbalance count + absorption ratio = contactVol / max(pen, 1 tick).
//
// OUTCOMES (frozen, RESEARCH_PROTOCOL two-gate):
//   markouts  — raw forward mid move (points) at {1,5,15,30} min from visit close
//               (fixed-horizon signed returns — NOT MFE/MAE)
//   barriers  — WIN/LOSS/TIME at targets {1,1.5,2,3}R for BOTH directions.
//               1R (Phase 1.6, FINAL per the frozen plan-§1 rule): per direction,
//               max(distance to 1 tick beyond the nearest prior-session LVN behind
//               the level, σ_ev·√15). LVN search window = 5×σ-floor beyond the
//               level; no qualifying LVN → σ-floor (stop_src records which).
//               Vertical barrier T = 2·(1R/σ_1m)² min, capped at VERT_CAP_MIN
//               (floor-1R reproduces the interim 30min exactly).
//               Same-bar target+stop → conservative LOSS.
//   uniqueness — mean over the 30-min outcome window of 1/(concurrent open windows)
//                (window fixed at 30min per plan §1.2 regardless of per-row T)
//   cluster_id — union-find over visits with overlapping time windows at levels ≤10pt apart
//   confluence_n — distinct structural sources near the level at visit open (plan §1.6)

import Database from 'better-sqlite3';
import type { RegisteredLevel, LmHooks } from './level-memory.js';
import { zvar } from './footprint.js';
import { structuralStopDist } from './volume-profile.js';

const T_CFG = {
  RING_MS: 90_000,          // trade ring buffer horizon
  APPROACH_MS: 60_000,      // attack window before visit open
  APPROACH_BAND_K: 3,       // approach zone = 3×band
  VISIT_BUF_CAP: 20_000,    // per-visit trade buffer cap
  H_REF_MIN: 15,            // 1R σ-floor = σ_ev·√H_REF
  R_GRID: [1, 1.5, 2, 3],
  VERT_MIN: 30,             // uniqueness window; also T with a floor-1R (= 2·H_REF)
  VERT_CAP_MIN: 60,         // vertical-barrier cap when the structural 1R > floor
  MO_HORIZONS: [1, 5, 15, 30],
  CLUSTER_PTS: 10,
  IMB_BIN_PTS: 1.0, IMB_MIN_Z: 2.0,
};
export type TraceCfg = typeof T_CFG;

interface TTrade { ts: number; price: number; size: number; buy: boolean; }
interface OpenVisit { lvlPrice: number; band: number; buf: TTrade[]; approach: TTrade[]; openTs: number; }

function phaseStats(trades: TTrade[]): { delta: number; vol: number; n: number } {
  let d = 0, v = 0;
  for (const t of trades) { d += t.buy ? t.size : -t.size; v += t.size; }
  return { delta: d, vol: v, n: trades.length };
}

/** size-aware imbalance count over 1pt bins of the contact trades (native flag). */
function imbCount(trades: TTrade[], binPts: number, minZ: number): number {
  const cells = new Map<number, { b: number; s: number; bq: number; sq: number }>();
  for (const t of trades) {
    const bin = Math.round(t.price / binPts);
    let c = cells.get(bin); if (!c) { c = { b: 0, s: 0, bq: 0, sq: 0 }; cells.set(bin, c); }
    if (t.buy) { c.b += t.size; c.bq += t.size ** 2; } else { c.s += t.size; c.sq += t.size ** 2; }
  }
  let n = 0;
  for (const [bin, c] of cells) {
    const below = cells.get(bin - 1), above = cells.get(bin + 1);
    if (below && zvar(c.b, below.s, c.bq + below.sq) >= minZ) n++;
    else if (above && zvar(c.s, above.b, c.sq + above.bq) >= minZ) n++;
  }
  return n;
}

export class TraceEngine {
  private db: Database.Database;
  private ring: TTrade[] = [];
  private open = new Map<string, OpenVisit>();
  private insFeat: Database.Statement;
  currentSigma = NaN;           // runner updates each throttle tick (σ_1m, points)
  readonly hooks: LmHooks;

  constructor(dbPath: string, private symbol: string, private tradingDay: string, private cfg: TraceCfg = T_CFG) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // trace schema v3 (Phase 1.6: confluence_n + per-direction structural stops).
    // The DB file is shared with the spine (level-memory owns user_version 2);
    // v<3 trace tables are regenerable research output with an incompatible
    // shape → drop and recreate. Spine tables are untouched.
    // Stamping 3 also short-circuits level-memory's v1 cleanup (`ver < 2`) — safe:
    // that drop only matters for legacy pre-v2 files, which this engine never opens.
    const ver = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
    if (ver < 3) {
      this.db.exec(`DROP TABLE IF EXISTS visit_features; DROP TABLE IF EXISTS visit_outcomes; DROP TABLE IF EXISTS day_context;`);
      this.db.pragma('user_version = 3');
    }
    this.db.exec(TRACE_SCHEMA);
    // idempotency: wipe this day's trace rows (spine does the same for interactions)
    for (const t of ['visit_features', 'visit_outcomes', 'visit_context']) this.db.prepare(`DELETE FROM ${t} WHERE symbol = ? AND trading_day = ?`).run(symbol, tradingDay);
    this.db.prepare(`DELETE FROM day_context WHERE symbol = ? AND trading_day = ?`).run(symbol, tradingDay);
    this.insFeat = this.db.prepare(`INSERT INTO visit_features
      (level_id, symbol, trading_day, close_ts, open_ts, source, kind, level_price, side, visit_index, held, band, sigma_ev, penetration,
       ap_delta, ap_vol, ap_n, ct_delta, ct_vol, ct_n, rs_delta, rs_vol, rs_n, imb_n, absorb_ratio, confluence_n)
      VALUES (@level_id, @symbol, @trading_day, @close_ts, @open_ts, @source, @kind, @level_price, @side, @visit_index, @held, @band, @sigma_ev, @penetration,
       @ap_delta, @ap_vol, @ap_n, @ct_delta, @ct_vol, @ct_n, @rs_delta, @rs_vol, @rs_n, @imb_n, @absorb_ratio, @confluence_n)`);

    this.hooks = {
      onVisitOpen: (lvl, startTs) => {
        const band = isFinite(this.currentSigma) ? this.currentSigma : 1;
        const zone = this.cfg.APPROACH_BAND_K * band;
        const approach = this.ring.filter((t) => t.ts >= startTs - this.cfg.APPROACH_MS && Math.abs(t.price - lvl.price) <= zone);
        this.open.set(lvl.id, { lvlPrice: lvl.price, band, buf: [], approach, openTs: startTs });
      },
      onVisitClose: (lvl, info) => {
        const v = this.open.get(lvl.id); this.open.delete(lvl.id);
        if (!v) return;
        const lastInBand = info.startTs + info.dwellMs;
        const contact = v.buf.filter((t) => Math.abs(t.price - v.lvlPrice) <= v.band && t.ts <= lastInBand);
        const resolution = v.buf.filter((t) => t.ts > lastInBand);
        const ap = phaseStats(v.approach), ct = phaseStats(contact), rs = phaseStats(resolution);
        this.insFeat.run({
          level_id: lvl.id, symbol: this.symbol, trading_day: this.tradingDay,
          close_ts: info.closeTs, open_ts: info.startTs, source: lvl.source, kind: lvl.kind,
          level_price: lvl.price, side: info.side, visit_index: info.visitIndex, held: info.held ? 1 : 0,
          band: v.band, sigma_ev: isFinite(this.currentSigma) ? this.currentSigma : null, penetration: info.penetration,
          ap_delta: ap.delta, ap_vol: ap.vol, ap_n: ap.n,
          ct_delta: ct.delta, ct_vol: ct.vol, ct_n: ct.n,
          rs_delta: rs.delta, rs_vol: rs.vol, rs_n: rs.n,
          imb_n: imbCount(contact, this.cfg.IMB_BIN_PTS, this.cfg.IMB_MIN_Z),
          absorb_ratio: ct.vol / Math.max(info.penetration, 0.25),
          confluence_n: info.confluenceN,
        });
      },
    };
  }

  /** Feed EVERY trade (native flag). Maintains the ring + open-visit buffers. */
  onTrade(ts: number, price: number, size: number, buy: boolean): void {
    this.ring.push({ ts, price, size, buy });
    const cut = ts - this.cfg.RING_MS;
    while (this.ring.length && this.ring[0]!.ts < cut) this.ring.shift();
    for (const v of this.open.values()) {
      if (Math.abs(price - v.lvlPrice) <= 2.5 * v.band && v.buf.length < this.cfg.VISIT_BUF_CAP) v.buf.push({ ts, price, size, buy });
    }
  }

  /** Deferred resolution pass — run after the day's replay with the day's 1-min bars.
   *  `stops.lvns` = the PRIOR session's LVN prices (causal) for the structural 1R;
   *  omitted → σ-floor only (identical to the pre-1.6 interim rule). */
  resolveOutcomes(bars: { t: number; o: number; h: number; l: number; c: number }[], stops?: { lvns: number[]; tick: number }): { resolved: number } {
    const rows = this.db.prepare(`SELECT rowid, level_id, close_ts, sigma_ev, level_price FROM visit_features WHERE symbol = ? AND trading_day = ?`)
      .all(this.symbol, this.tradingDay) as any[];
    if (!bars.length || !rows.length) return { resolved: 0 };
    // gap-safe minute lookup (a missing 1-min bar must not shift every later index)
    const idx = new Map(bars.map((b, i) => [b.t, i]));
    const barAt = (ts: number) => idx.get(Math.floor(ts / 60_000) * 60_000) ?? -1;
    const ins = this.db.prepare(`INSERT INTO visit_outcomes
      (level_id, symbol, trading_day, close_ts, entry_px, stop_1r_l, stop_1r_s, stop_src_l, stop_src_s, vert_l, vert_s,
       mo_1m, mo_5m, mo_15m, mo_30m, bl_1, bl_15, bl_2, bl_3, bs_1, bs_15, bs_2, bs_3, uniq_w, cluster_id)
      VALUES (@level_id, @symbol, @trading_day, @close_ts, @entry_px, @stop_1r_l, @stop_1r_s, @stop_src_l, @stop_src_s, @vert_l, @vert_s,
       @mo_1m, @mo_5m, @mo_15m, @mo_30m, @bl_1, @bl_15, @bl_2, @bl_3, @bs_1, @bs_15, @bs_2, @bs_3, @uniq_w, @cluster_id)`);

    // concurrency per minute for uniqueness (30-min outcome windows)
    const winMin = this.cfg.VERT_MIN;
    const conc = new Map<number, number>();
    for (const r of rows) { const m0 = Math.floor(r.close_ts / 60_000); for (let m = m0; m < m0 + winMin; m++) conc.set(m, (conc.get(m) ?? 0) + 1); }

    // cluster ids: union-find over overlapping windows at nearby levels
    const parent = rows.map((_: any, i: number) => i);
    const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]!));
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      if (Math.abs(rows[i].level_price - rows[j].level_price) <= this.cfg.CLUSTER_PTS
        && Math.abs(rows[i].close_ts - rows[j].close_ts) <= winMin * 60_000) parent[find(i)] = find(j);
    }

    let resolved = 0;
    const tx = this.db.transaction(() => {
      for (const [ri, r] of rows.entries()) {
        const bi = barAt(r.close_ts);
        if (bi < 0) continue;
        const entry = bars[bi]!.c;
        const baseT = bars[bi]!.t;
        const sig = r.sigma_ev ?? 1;
        // ── 1R (frozen §1 rule): per direction, max(1 tick beyond nearest LVN
        // behind the level, σ_ev·√h_ref). LVNs are PRIOR-session (causal).
        const floorR = sig * Math.sqrt(this.cfg.H_REF_MIN);
        const structOf = (dir: 1 | -1): number | null => stops
          ? structuralStopDist(stops.lvns, r.level_price, entry, dir, floorR, stops.tick) : null;
        const structL = structOf(1), structS = structOf(-1);
        const oneRL = Math.max(floorR, structL ?? 0), oneRS = Math.max(floorR, structS ?? 0);
        // vertical barrier tracks the actual 1R (T = 2·(1R/σ_1m)² min), capped;
        // floor-1R reproduces the interim 30 min exactly
        const vertOf = (oneR: number) => Math.min(this.cfg.VERT_CAP_MIN, Math.round(2 * (oneR / sig) ** 2));
        const vertL = vertOf(oneRL), vertS = vertOf(oneRS);
        const mo = (h: number) => { const j = idx.get(baseT + h * 60_000); return j != null ? bars[j]!.c - entry : null; };
        // dual-direction barrier march, conservative same-bar rule, time-bounded (gap-safe)
        const march = (dir: 1 | -1, oneR: number, vertMin: number): Record<string, string> => {
          const out: Record<string, string> = {};
          const tEnd = baseT + vertMin * 60_000;
          for (const R of this.cfg.R_GRID) {
            const key = String(R).replace('.', '');
            const tgt = entry + dir * R * oneR, stp = entry - dir * oneR;
            let lab = 'T';
            for (let j = bi + 1; j < bars.length && bars[j]!.t <= tEnd; j++) {
              const hitT = dir > 0 ? bars[j]!.h >= tgt : bars[j]!.l <= tgt;
              const hitS = dir > 0 ? bars[j]!.l <= stp : bars[j]!.h >= stp;
              if (hitT && hitS) { lab = 'L'; break; }        // conservative
              if (hitS) { lab = 'L'; break; }
              if (hitT) { lab = 'W'; break; }
            }
            out[key] = lab;
          }
          return out;
        };
        const L = march(1, oneRL, vertL), S = march(-1, oneRS, vertS);
        const m0 = Math.floor(r.close_ts / 60_000);
        let u = 0; for (let m = m0; m < m0 + winMin; m++) u += 1 / (conc.get(m) ?? 1);
        ins.run({
          level_id: r.level_id, symbol: this.symbol, trading_day: this.tradingDay, close_ts: r.close_ts,
          entry_px: entry, stop_1r_l: oneRL, stop_1r_s: oneRS,
          stop_src_l: structL != null && structL > floorR ? 'lvn' : 'floor',
          stop_src_s: structS != null && structS > floorR ? 'lvn' : 'floor',
          vert_l: vertL, vert_s: vertS,
          mo_1m: mo(1), mo_5m: mo(5), mo_15m: mo(15), mo_30m: mo(30),
          bl_1: L['1'], bl_15: L['15'], bl_2: L['2'], bl_3: L['3'],
          bs_1: S['1'], bs_15: S['15'], bs_2: S['2'], bs_3: S['3'],
          uniq_w: u / winMin, cluster_id: `${this.tradingDay}:${find(ri)}`,
        });
        resolved++;
      }
    });
    tx();
    return { resolved };
  }

  /** Phase 1.4 context pass for this engine's day (see resolveContext). */
  writeVisitContext(barsNq: CtxBar[], barsEs: CtxBar[], morningIv: number | null): number {
    return resolveContext(this.db, this.symbol, this.tradingDay, barsNq, barsEs, morningIv);
  }

  writeDayContext(ctx: { openPx: number; closePx: number; hiPx: number; loPx: number }): void {
    const drift = (ctx.closePx - ctx.openPx) / 390;
    const dirRatio = ctx.hiPx > ctx.loPx ? Math.abs(ctx.closePx - ctx.openPx) / (ctx.hiPx - ctx.loPx) : 0;
    this.db.prepare(`INSERT OR REPLACE INTO day_context (symbol, trading_day, open_px, close_px, hi_px, lo_px, drift_pt_min, dir_ratio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(this.symbol, this.tradingDay, ctx.openPx, ctx.closePx, ctx.hiPx, ctx.loPx, drift, dirRatio);
  }

  close(): void { this.db.close(); }
}

// ── Phase 1.4: context columns (plan §1.4) ────────────────────────────────────
// STRATIFICATION columns, NOT entry features — each carries a defined knowledge
// time and Phase-2+ tests must respect it:
//   tod_phase   — knowledge time: visit close (pure function of the clock).
//   es_agree / rs_30m_bp — knowledge time: visit close (trailing 30-min window
//                 of our own two feeds; nothing forward).
//   morning_iv  — knowledge time: 10:00 ET (mean NDX ATM-IV 09:30–10:00, the
//                 validated IV→range forecaster input, quantdata store). Stored
//                 RAW: conditioning is rank-based, a fitted IV→points calibration
//                 would be an unnecessary estimated parameter.
//   dir_ratio (day_context, pre-existing) — knowledge time 16:00; post-hoc
//                 day-regime stratification only.
// Frozen definitions:
//   tod_phase: open = [09:30,10:30) · close = ≥14:30 · mid = between (ET).
//   es_agree: of the 6 non-overlapping 5-min log returns ending at the visit-
//     close minute, the fraction where sign(NQ)==sign(ES) among pairs where both
//     are nonzero; null if <4 valid pairs (thin tape / session edge).
//   rs_30m_bp: 30-min log-return differential (NQ − ES) × 10⁴; null unless both
//     symbols have closes at m and m−30.

export interface CtxBar { t: number; c: number; }

export function todPhase(closeTs: number, tradingDay: string): 'open' | 'mid' | 'close' {
  const m = closeTs - Date.parse(`${tradingDay}T09:30:00-04:00`);
  if (m < 60 * 60_000) return 'open';
  if (m >= 5 * 3600_000) return 'close';
  return 'mid';
}

export function commonFactor(nq: Map<number, number>, es: Map<number, number>, minuteMs: number): { agree: number | null; rsBp: number | null } {
  const M5 = 5 * 60_000;
  const ret = (m: Map<number, number>, t: number): number | null => {
    const a = m.get(t), b = m.get(t - M5);
    return a != null && b != null && b > 0 ? Math.log(a / b) : null;
  };
  let valid = 0, agree = 0;
  for (let i = 0; i < 6; i++) {
    const t = minuteMs - i * M5;
    const rn = ret(nq, t), re = ret(es, t);
    if (rn == null || re == null || rn === 0 || re === 0) continue;
    valid++; if (rn * re > 0) agree++;
  }
  const a0 = nq.get(minuteMs), a30 = nq.get(minuteMs - 30 * 60_000);
  const b0 = es.get(minuteMs), b30 = es.get(minuteMs - 30 * 60_000);
  const rsBp = a0 != null && a30 != null && b0 != null && b30 != null && a30 > 0 && b30 > 0
    ? (Math.log(a0 / a30) - Math.log(b0 / b30)) * 1e4 : null;
  return { agree: valid >= 4 ? agree / valid : null, rsBp };
}

/** Idempotent per-day context pass over existing visit_features rows. Needs NO
 *  book replay — safe as a backfill on an already-built trace. Bars should start
 *  ≥35 min before the first visit close (the runner pulls from 08:55). */
export function resolveContext(db: Database.Database, symbol: string, tradingDay: string,
  barsNq: CtxBar[], barsEs: CtxBar[], morningIv: number | null): number {
  db.exec(`CREATE TABLE IF NOT EXISTS visit_context (
    level_id TEXT, symbol TEXT, trading_day TEXT, close_ts INTEGER,
    tod_phase TEXT, es_agree REAL, rs_30m_bp REAL);
  CREATE INDEX IF NOT EXISTS idx_vc_day ON visit_context(symbol, trading_day);`);
  try { db.exec(`ALTER TABLE day_context ADD COLUMN morning_iv REAL`); } catch { /* column exists */ }
  db.prepare(`DELETE FROM visit_context WHERE symbol = ? AND trading_day = ?`).run(symbol, tradingDay);
  const rows = db.prepare(`SELECT level_id, close_ts FROM visit_features WHERE symbol = ? AND trading_day = ?`)
    .all(symbol, tradingDay) as any[];
  const nqC = new Map(barsNq.map((b) => [b.t, b.c])), esC = new Map(barsEs.map((b) => [b.t, b.c]));
  const ins = db.prepare(`INSERT INTO visit_context (level_id, symbol, trading_day, close_ts, tod_phase, es_agree, rs_30m_bp)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      const m = Math.floor(r.close_ts / 60_000) * 60_000;
      const cf = commonFactor(nqC, esC, m);
      ins.run(r.level_id, symbol, tradingDay, r.close_ts, todPhase(r.close_ts, tradingDay), cf.agree, cf.rsBp);
    }
    db.prepare(`UPDATE day_context SET morning_iv = ? WHERE symbol = ? AND trading_day = ?`).run(morningIv, symbol, tradingDay);
  });
  tx();
  return rows.length;
}

const TRACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS visit_features (
  level_id TEXT, symbol TEXT, trading_day TEXT, close_ts INTEGER, open_ts INTEGER,
  source TEXT, kind TEXT, level_price REAL, side TEXT, visit_index INTEGER, held INTEGER,
  band REAL, sigma_ev REAL, penetration REAL,
  ap_delta REAL, ap_vol REAL, ap_n INTEGER, ct_delta REAL, ct_vol REAL, ct_n INTEGER,
  rs_delta REAL, rs_vol REAL, rs_n INTEGER, imb_n INTEGER, absorb_ratio REAL, confluence_n INTEGER
);
CREATE INDEX IF NOT EXISTS idx_vf_day ON visit_features(symbol, trading_day);
CREATE TABLE IF NOT EXISTS visit_outcomes (
  level_id TEXT, symbol TEXT, trading_day TEXT, close_ts INTEGER,
  entry_px REAL, stop_1r_l REAL, stop_1r_s REAL, stop_src_l TEXT, stop_src_s TEXT, vert_l INTEGER, vert_s INTEGER,
  mo_1m REAL, mo_5m REAL, mo_15m REAL, mo_30m REAL,
  bl_1 TEXT, bl_15 TEXT, bl_2 TEXT, bl_3 TEXT, bs_1 TEXT, bs_15 TEXT, bs_2 TEXT, bs_3 TEXT,
  uniq_w REAL, cluster_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_vo_day ON visit_outcomes(symbol, trading_day);
CREATE TABLE IF NOT EXISTS day_context (
  symbol TEXT, trading_day TEXT, open_px REAL, close_px REAL, hi_px REAL, lo_px REAL,
  drift_pt_min REAL, dir_ratio REAL, morning_iv REAL, PRIMARY KEY (symbol, trading_day)
);
CREATE TABLE IF NOT EXISTS visit_context (
  level_id TEXT, symbol TEXT, trading_day TEXT, close_ts INTEGER,
  tod_phase TEXT, es_agree REAL, rs_30m_bp REAL
);
CREATE INDEX IF NOT EXISTS idx_vc_day ON visit_context(symbol, trading_day);
`;
export { T_CFG };
