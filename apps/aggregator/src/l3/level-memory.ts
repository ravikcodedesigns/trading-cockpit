// level-memory.ts — SPINE (Phase 1) of the orderflow system.
//
// A persistent, lifecycle-managed registry of price levels + a running TRACE of
// every VISIT (not every tick) at each level — so when price returns we have the
// whole movie, not a snapshot.
//
// NORMALIZATION (the fix): a naive "band exit = new interaction" over-counts —
// chop with amplitude > band fragments one real visit into many (56% of raw
// interactions were <5s apart; 13 "touches" in one minute at a chopped level).
// Instead we use a VISIT MODEL with hysteresis:
//   • a visit OPENS when mid enters the level's band (|d| ≤ band),
//   • it STAYS OPEN through chop (price inside the wider DEPARTURE zone),
//   • it CLOSES only when price is beyond DEPART_K×band AND stays away ≥ MIN_AWAY,
//   • ONE interaction is recorded per visit, features aggregated over it,
//     outcome = held (left back the way it came) vs broke (went through).
//
// Built on the OrderBook + divergence math; the caller drives observe() from the
// same throttled replay/live loop as backtest_dda_swing.

import Database from 'better-sqlite3';
import type { OrderBook } from './order-book.js';
import { kyleLambda, ofiSeries, type Quote } from './divergence.js';

export type LevelSource = 'swing' | 'rs' | 'session' | 'wall' | 'hvn'
  | 'placebo-random' | 'placebo-shifted' | 'round';   // Phase-1 null/control sources (CRACKER_PLAN §1.3)

export interface RegisteredLevel {
  id: string; symbol: string; price: number; source: LevelSource; kind: string;
  firstSeenTs: number; lastTestTs: number; lastTestSession: number;
  visits: number; holds: number; breaks: number; holdPost: number; naked: boolean; retired: boolean;
}

const LM_CFG = {
  MERGE_PTS: 5,           // levels within this (same source) are the SAME level (merge across retire too)
  DEPART_K: 2.5,          // hysteresis: visit ends only when |d| > DEPART_K × band …
  MIN_AWAY_MS: 15_000,    // … and price stays beyond that zone for at least this long
  NEAR_TICKS: 16,         // tape window (±ticks) for absorbed volume
  QUOTE_CAP: 400,         // cap per-visit quote buffer (λ over recent quotes)
  // ── Cracker Phase 0.1 (frozen) ─────────────────────────────────────────────
  // Empirical-Bayes hold-rate posterior replaces the ad-hoc ±1.0/1.5 strength
  // score: posterior mean = (α₀+holds)/(α₀+β₀+visits). Prior Beta(2.6, 1.4) =
  // mean 0.65 (the global visit-normalized hold rate) worth 4 pseudo-visits —
  // a 2-visit level is shrunk toward the prior, a 20-visit level speaks for itself.
  PRIOR_ALPHA: 2.6, PRIOR_BETA: 1.4,
  // Retirement: "break accepted" = posterior < 0.35 with ≥3 real visits; OR
  // inactivity — relevance w = 2^(−Δsessions/2) (half-life 2 sessions since last
  // test) drops below 0.05 ⇔ untested for ≥9 sessions. Retired levels keep their
  // history and revive on re-approach (upsert merges across the retired boundary).
  RETIRE_POST: 0.35, RETIRE_MIN_VISITS: 3, RETIRE_AGE_SESSIONS: 9,
};
export type LmCfg = typeof LM_CFG;

/** Posterior mean hold rate under the frozen Beta prior. */
export function holdPosterior(holds: number, visits: number, cfg = LM_CFG): number {
  return (cfg.PRIOR_ALPHA + holds) / (cfg.PRIOR_ALPHA + cfg.PRIOR_BETA + visits);
}

/** Persistent level registry with lifecycle. One record per price zone per source —
 *  merges across the retire boundary so a level is never duplicated. */
export class LevelRegistry {
  private levels = new Map<string, RegisteredLevel>();
  sessionIdx = 0;   // monotone trading-session counter (persisted in the meta table)
  constructor(private symbol: string, private cfg = LM_CFG) {}
  all(): RegisteredLevel[] { return [...this.levels.values()]; }
  active(): RegisteredLevel[] { return this.all().filter((l) => !l.retired); }

  /** Rehydrate from persisted rows — this is what makes the memory CROSS-SESSION.
   *  Loads ALL levels (retired included: they must stay matchable for revive). */
  hydrate(rows: RegisteredLevel[], sessionIdx: number): void {
    this.sessionIdx = sessionIdx;
    for (const r of rows) this.levels.set(r.id, r);
  }

  /** Start a new trading session: bump the counter and sweep inactivity retirement
   *  (untested for ≥ RETIRE_AGE_SESSIONS sessions ⇔ relevance 2^(−Δ/2) < 0.05). */
  beginSession(): void {
    this.sessionIdx++;
    for (const l of this.levels.values()) {
      if (!l.retired && this.sessionIdx - l.lastTestSession >= this.cfg.RETIRE_AGE_SESSIONS) l.retired = true;
    }
  }

  upsert(price: number, source: LevelSource, kind: string, now: number): RegisteredLevel {
    for (const l of this.levels.values()) {   // match ANY (incl. retired) → revive, never duplicate
      if (l.source === source && Math.abs(l.price - price) <= this.cfg.MERGE_PTS) { if (l.retired) l.retired = false; return l; }
    }
    const id = `${source}:${price.toFixed(2)}:${now}`;
    const lvl: RegisteredLevel = {
      id, symbol: this.symbol, price, source, kind, firstSeenTs: now, lastTestTs: now,
      lastTestSession: this.sessionIdx, visits: 0, holds: 0, breaks: 0,
      holdPost: holdPosterior(0, 0, this.cfg), naked: source !== 'swing', retired: false,
    };
    this.levels.set(id, lvl); return lvl;
  }
  onVisit(l: RegisteredLevel, held: boolean, now: number): void {
    l.visits++; l.lastTestTs = now; l.lastTestSession = this.sessionIdx; l.naked = false;
    if (held) l.holds++; else l.breaks++;
    l.holdPost = holdPosterior(l.holds, l.visits, this.cfg);
    // break accepted: the posterior says this level no longer holds → retire (revivable)
    if (l.visits >= this.cfg.RETIRE_MIN_VISITS && l.holdPost < this.cfg.RETIRE_POST) l.retired = true;
  }
}

interface Visit {
  startTs: number; lastInBandTs: number; approachSign: number;   // +1 tested from above (support), -1 from below (resistance)
  quotes: Quote[]; taps: number; minMid: number; maxMid: number; awaySince: number | null;
}

/** Cracker Phase-1 hooks: lets a trace engine attach per-visit feature capture
 *  without duplicating the hysteresis state machine. */
export interface LmHooks {
  onVisitOpen?: (lvl: RegisteredLevel, startTs: number, approachSign: number) => void;
  onVisitClose?: (lvl: RegisteredLevel, info: {
    startTs: number; closeTs: number; approachSign: number; held: boolean; side: string;
    visitIndex: number; taps: number; dwellMs: number; penetration: number; band: number;
  }) => void;
}

/** Wraps the registry + per-level visit state machines; persists one interaction per visit. */
export class LevelMemory {
  private db: Database.Database;
  private reg: LevelRegistry;
  private visits = new Map<string, Visit>();   // levelId → open visit
  private prevMid = NaN;
  private insInt: Database.Statement;
  private cfg = LM_CFG;

  /** Prices of levels with an OPEN visit right now (for trace zone-trade routing). */
  openVisitLevels(): { id: string; price: number }[] {
    const out: { id: string; price: number }[] = [];
    for (const id of this.visits.keys()) { const l = this.reg.all().find((x) => x.id === id); if (l) out.push({ id, price: l.price }); }
    return out;
  }

  constructor(dbPath: string, private symbol: string, private tradingDay: string, private hooks: LmHooks = {}) {
    this.db = new Database(dbPath); this.db.pragma('journal_mode = WAL');
    // schema v2 (Cracker 0.1): hold_post/last_test_session replace strength; meta
    // table added. v1 DBs are regenerable research output → drop and recreate.
    const ver = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
    if (ver < 2) { this.db.exec(`DROP TABLE IF EXISTS levels; DROP TABLE IF EXISTS interactions; DROP TABLE IF EXISTS meta;`); this.db.exec(SCHEMA); this.db.pragma('user_version = 2'); }
    else this.db.exec(SCHEMA);
    this.reg = new LevelRegistry(symbol);

    // ── TAIL-ONLY GUARD — re-running a day is only coherent if no LATER days
    // exist (later lifecycle state depends on this day's replay). Enforce it.
    const later = this.db.prepare(`SELECT MAX(trading_day) d FROM interactions WHERE symbol = ?`).get(symbol) as any;
    if (later?.d && later.d > tradingDay) throw new Error(`level-memory: cannot re-run ${tradingDay} — interactions exist through ${later.d} (tail-only re-runs)`);

    // ── DAY-SCOPED DELETE (fix B3) — wipe this day's interactions AND the levels
    // BORN this day: a re-run must re-discover its own levels at their confirmTs,
    // not inherit them from 09:30 (caught by cracker_p01_accept: re-run produced
    // 94 visits where the original pass had 47 — pre-existing own-day levels were
    // being visited before the swings that create them had confirmed).
    const dayLo = Date.parse(`${tradingDay}T00:00:00-04:00`), dayHi = dayLo + 24 * 3600_000;
    this.db.prepare(`DELETE FROM interactions WHERE symbol = ? AND trading_day = ?`).run(symbol, tradingDay);
    this.db.prepare(`DELETE FROM levels WHERE symbol = ? AND first_seen_ts >= ? AND first_seen_ts < ?`).run(symbol, dayLo, dayHi);

    // ── REHYDRATION (fix B4) — the memory is only cross-session if we load it.
    // Previously each day constructed a fresh registry: every level restarted
    // life daily and "persistent level memory" did not actually exist in replay.
    const rows = this.db.prepare(`SELECT * FROM levels WHERE symbol = ?`).all(symbol) as any[];
    const meta = new Map((this.db.prepare(`SELECT k, v FROM meta`).all() as any[]).map((r) => [r.k, r.v]));
    this.reg.hydrate(rows.map((r) => ({
      id: r.id, symbol: r.symbol, price: r.price, source: r.source, kind: r.kind,
      firstSeenTs: r.first_seen_ts, lastTestTs: r.last_test_ts, lastTestSession: r.last_test_session ?? 0,
      visits: r.visits, holds: r.holds, breaks: r.breaks,
      holdPost: r.hold_post ?? holdPosterior(r.holds, r.visits), naked: !!r.naked, retired: !!r.retired,
    })), Number(meta.get(`session_idx:${symbol}`) ?? 0));

    // ── SESSION + IDEMPOTENCY (fixes B1 sweep + B3) — a NEW trading day bumps the
    // session counter (triggering the inactivity-retirement sweep); re-running the
    // SAME day does not double-bump, and that day's interactions are wiped first
    // so a re-run can never duplicate rows.
    const lastDay = meta.get(`session_day:${symbol}`);
    if (lastDay !== tradingDay) {
      this.reg.beginSession();
      const put = this.db.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`);
      put.run(`session_day:${symbol}`, tradingDay); put.run(`session_idx:${symbol}`, String(this.reg.sessionIdx));
    }

    // ── COUNTER REBUILD (fix B3, part 2) — the interactions table is the single
    // source of truth; per-level counters are DERIVED from it. Without this, a
    // same-day re-run added its visits on top of counters that already included
    // that day (caught by cracker_p01_accept: visits 344→303 with corrupt levels).
    // Retirement is likewise fully derived: break-accepted (posterior) OR age.
    const agg = new Map((this.db.prepare(
      `SELECT level_id, COUNT(*) v, SUM(held) h, MAX(ts_ms) lt, MAX(session_idx) ls FROM interactions WHERE symbol = ? GROUP BY level_id`,
    ).all(symbol) as any[]).map((r) => [r.level_id, r]));
    for (const l of this.reg.all()) {
      const a = agg.get(l.id);
      l.visits = a?.v ?? 0; l.holds = a?.h ?? 0; l.breaks = (a?.v ?? 0) - (a?.h ?? 0);
      if (a) { l.lastTestTs = a.lt; l.lastTestSession = a.ls ?? l.lastTestSession; }
      l.holdPost = holdPosterior(l.holds, l.visits);
      l.naked = l.visits === 0 && l.source !== 'swing';
      l.retired = (l.visits >= LM_CFG.RETIRE_MIN_VISITS && l.holdPost < LM_CFG.RETIRE_POST)
        || (this.reg.sessionIdx - l.lastTestSession >= LM_CFG.RETIRE_AGE_SESSIONS);
    }

    this.insInt = this.db.prepare(`INSERT INTO interactions
      (level_id,symbol,trading_day,ts_ms,session_idx,source,kind,level_price,side,visit_index,held,taps,dwell_ms,penetration,absorbed_vol,lambda,ofi_net)
      VALUES (@level_id,@symbol,@trading_day,@ts_ms,@session_idx,@source,@kind,@level_price,@side,@visit_index,@held,@taps,@dwell_ms,@penetration,@absorbed_vol,@lambda,@ofi_net)`);
  }

  /** Drive on each throttled book update. `mid`/`band` supplied by the caller (same as the swing loop). */
  observe(book: OrderBook, sources: { price: number; source: LevelSource; kind: string }[], mid: number, band: number, now: number): void {
    for (const s of sources) this.reg.upsert(s.price, s.source, s.kind, now);
    if (band <= 0) { this.prevMid = mid; return; }
    const bbI = book.bestBid(), baI = book.bestAsk();
    const q: Quote | null = bbI != null && baI != null
      ? { bidPx: book.priceFromInt(bbI), bidSz: book.depthNear(bbI, 0, 'bid').size, askPx: book.priceFromInt(baI), askSz: book.depthNear(baI, 0, 'ask').size } : null;
    const depart = this.cfg.DEPART_K * band;

    for (const lvl of this.reg.active()) {
      const d = mid - lvl.price, ad = Math.abs(d);
      let v = this.visits.get(lvl.id);
      if (!v) {
        if (ad <= band) {   // OPEN a visit — approach side = which side price came from
          v = { startTs: now, lastInBandTs: now, approachSign: Math.sign((isFinite(this.prevMid) ? this.prevMid : mid) - lvl.price) || Math.sign(d) || 1, quotes: [], taps: 0, minMid: mid, maxMid: mid, awaySince: null };
          this.visits.set(lvl.id, v);
          this.hooks.onVisitOpen?.(lvl, now, v.approachSign);
        } else continue;
      }
      // update open visit
      v.minMid = Math.min(v.minMid, mid); v.maxMid = Math.max(v.maxMid, mid);
      if (q) { v.quotes.push(q); if (v.quotes.length > this.cfg.QUOTE_CAP) v.quotes.shift(); }
      if (ad <= band) { v.taps++; v.lastInBandTs = now; v.awaySince = null; }
      else if (ad > depart) {   // beyond departure zone → candidate close (needs dwell)
        if (v.awaySince == null) v.awaySince = now;
        if (now - v.awaySince >= this.cfg.MIN_AWAY_MS) this.closeVisit(book, lvl, v, mid, d, now, band);
      } else v.awaySince = null;   // in the hysteresis band — still the same visit
    }
    this.prevMid = mid;
  }

  private closeVisit(book: OrderBook, lvl: RegisteredLevel, v: Visit, mid: number, d: number, now: number, band = 0): void {
    this.visits.delete(lvl.id);
    const exitSign = Math.sign(d);
    const held = exitSign === v.approachSign;   // left back the way it came = held; through = broke
    const side = v.approachSign > 0 ? 'support' : 'resistance';
    const penetration = v.approachSign > 0 ? Math.max(0, lvl.price - v.minMid) : Math.max(0, v.maxMid - lvl.price);
    const lvInt = book.intFromPrice(lvl.price);
    let absorbed = 0; for (const p of book.tapeNear(lvInt, this.cfg.NEAR_TICKS, v.startTs)) absorbed += p.size;
    const lam = kyleLambda(v.quotes);
    this.reg.onVisit(lvl, held, now);
    this.insInt.run({
      level_id: lvl.id, symbol: this.symbol, trading_day: this.tradingDay, ts_ms: now, session_idx: this.reg.sessionIdx,
      source: lvl.source, kind: lvl.kind,
      level_price: lvl.price, side, visit_index: lvl.visits, held: held ? 1 : 0, taps: v.taps,
      dwell_ms: v.lastInBandTs - v.startTs, penetration, absorbed_vol: absorbed,
      lambda: lam ? Math.abs(lam.lambda) : null, ofi_net: ofiSeries(v.quotes).reduce((s, x) => s + x, 0),
    });
    this.hooks.onVisitClose?.(lvl, {
      startTs: v.startTs, closeTs: now, approachSign: v.approachSign, held, side,
      visitIndex: lvl.visits, taps: v.taps, dwellMs: v.lastInBandTs - v.startTs, penetration, band,
    });
  }

  flush(): void {
    const ins = this.db.prepare(`INSERT OR REPLACE INTO levels
      (id,symbol,trading_day,price,source,kind,first_seen_ts,last_test_ts,last_test_session,visits,holds,breaks,hold_post,naked,retired)
      VALUES (@id,@symbol,@trading_day,@price,@source,@kind,@first_seen_ts,@last_test_ts,@last_test_session,@visits,@holds,@breaks,@hold_post,@naked,@retired)`);
    this.db.transaction((ls: RegisteredLevel[]) => ls.forEach((l) => ins.run({
      id: l.id, symbol: l.symbol, trading_day: this.tradingDay, price: l.price, source: l.source, kind: l.kind,
      first_seen_ts: l.firstSeenTs, last_test_ts: l.lastTestTs, last_test_session: l.lastTestSession,
      visits: l.visits, holds: l.holds, breaks: l.breaks,
      hold_post: l.holdPost, naked: l.naked ? 1 : 0, retired: l.retired ? 1 : 0,
    })))(this.reg.all());
  }
  close(): void { this.db.close(); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS levels (
  id TEXT PRIMARY KEY, symbol TEXT, trading_day TEXT, price REAL, source TEXT, kind TEXT,
  first_seen_ts INTEGER, last_test_ts INTEGER, last_test_session INTEGER, visits INTEGER, holds INTEGER, breaks INTEGER,
  hold_post REAL, naked INTEGER, retired INTEGER
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY, level_id TEXT, symbol TEXT, trading_day TEXT, ts_ms INTEGER, session_idx INTEGER,
  source TEXT, kind TEXT, level_price REAL, side TEXT, visit_index INTEGER, held INTEGER,
  taps INTEGER, dwell_ms INTEGER, penetration REAL, absorbed_vol REAL, lambda REAL, ofi_net REAL
);
CREATE INDEX IF NOT EXISTS idx_int_level ON interactions(level_id);
CREATE INDEX IF NOT EXISTS idx_int_day ON interactions(symbol, trading_day);
`;
export { LM_CFG };
