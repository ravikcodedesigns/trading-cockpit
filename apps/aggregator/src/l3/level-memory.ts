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

export type LevelSource = 'swing' | 'rs' | 'session' | 'wall' | 'hvn';

export interface RegisteredLevel {
  id: string; symbol: string; price: number; source: LevelSource; kind: string;
  firstSeenTs: number; lastTestTs: number;
  visits: number; holds: number; breaks: number; strength: number; naked: boolean; retired: boolean;
}

const LM_CFG = {
  MERGE_PTS: 5,           // levels within this (same source) are the SAME level (merge across retire too)
  DEPART_K: 2.5,          // hysteresis: visit ends only when |d| > DEPART_K × band …
  MIN_AWAY_MS: 15_000,    // … and price stays beyond that zone for at least this long
  NEAR_TICKS: 16,         // tape window (±ticks) for absorbed volume
  QUOTE_CAP: 400,         // cap per-visit quote buffer (λ over recent quotes)
  STRENGTH_HOLD: 1.0, STRENGTH_BREAK: 1.5,
};
export type LmCfg = typeof LM_CFG;

/** Persistent level registry with lifecycle. One record per price zone per source —
 *  merges across the retire boundary so a level is never duplicated. */
export class LevelRegistry {
  private levels = new Map<string, RegisteredLevel>();
  constructor(private symbol: string, private cfg = LM_CFG) {}
  all(): RegisteredLevel[] { return [...this.levels.values()]; }
  active(): RegisteredLevel[] { return this.all().filter((l) => !l.retired); }

  upsert(price: number, source: LevelSource, kind: string, now: number): RegisteredLevel {
    for (const l of this.levels.values()) {   // match ANY (incl. retired) → revive, never duplicate
      if (l.source === source && Math.abs(l.price - price) <= this.cfg.MERGE_PTS) { if (l.retired) l.retired = false; return l; }
    }
    const id = `${source}:${price.toFixed(2)}:${now}`;
    const lvl: RegisteredLevel = { id, symbol: this.symbol, price, source, kind, firstSeenTs: now, lastTestTs: now, visits: 0, holds: 0, breaks: 0, strength: 0, naked: source !== 'swing', retired: false };
    this.levels.set(id, lvl); return lvl;
  }
  onVisit(l: RegisteredLevel, held: boolean, now: number): void {
    l.visits++; l.lastTestTs = now; l.naked = false;
    if (held) { l.holds++; l.strength += this.cfg.STRENGTH_HOLD; } else { l.breaks++; l.strength -= this.cfg.STRENGTH_BREAK; }
  }
}

interface Visit {
  startTs: number; lastInBandTs: number; approachSign: number;   // +1 tested from above (support), -1 from below (resistance)
  quotes: Quote[]; taps: number; minMid: number; maxMid: number; awaySince: number | null;
}

/** Wraps the registry + per-level visit state machines; persists one interaction per visit. */
export class LevelMemory {
  private db: Database.Database;
  private reg: LevelRegistry;
  private visits = new Map<string, Visit>();   // levelId → open visit
  private prevMid = NaN;
  private insInt: Database.Statement;
  private cfg = LM_CFG;

  constructor(dbPath: string, private symbol: string, private tradingDay: string) {
    this.db = new Database(dbPath); this.db.pragma('journal_mode = WAL'); this.db.exec(SCHEMA);
    this.reg = new LevelRegistry(symbol);
    this.insInt = this.db.prepare(`INSERT INTO interactions
      (level_id,symbol,trading_day,ts_ms,source,kind,level_price,side,visit_index,held,taps,dwell_ms,penetration,absorbed_vol,lambda,ofi_net)
      VALUES (@level_id,@symbol,@trading_day,@ts_ms,@source,@kind,@level_price,@side,@visit_index,@held,@taps,@dwell_ms,@penetration,@absorbed_vol,@lambda,@ofi_net)`);
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
        } else continue;
      }
      // update open visit
      v.minMid = Math.min(v.minMid, mid); v.maxMid = Math.max(v.maxMid, mid);
      if (q) { v.quotes.push(q); if (v.quotes.length > this.cfg.QUOTE_CAP) v.quotes.shift(); }
      if (ad <= band) { v.taps++; v.lastInBandTs = now; v.awaySince = null; }
      else if (ad > depart) {   // beyond departure zone → candidate close (needs dwell)
        if (v.awaySince == null) v.awaySince = now;
        if (now - v.awaySince >= this.cfg.MIN_AWAY_MS) this.closeVisit(book, lvl, v, mid, d, now);
      } else v.awaySince = null;   // in the hysteresis band — still the same visit
    }
    this.prevMid = mid;
  }

  private closeVisit(book: OrderBook, lvl: RegisteredLevel, v: Visit, mid: number, d: number, now: number): void {
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
      level_id: lvl.id, symbol: this.symbol, trading_day: this.tradingDay, ts_ms: now, source: lvl.source, kind: lvl.kind,
      level_price: lvl.price, side, visit_index: lvl.visits, held: held ? 1 : 0, taps: v.taps,
      dwell_ms: v.lastInBandTs - v.startTs, penetration, absorbed_vol: absorbed,
      lambda: lam ? Math.abs(lam.lambda) : null, ofi_net: ofiSeries(v.quotes).reduce((s, x) => s + x, 0),
    });
  }

  flush(): void {
    const ins = this.db.prepare(`INSERT OR REPLACE INTO levels
      (id,symbol,trading_day,price,source,kind,first_seen_ts,last_test_ts,visits,holds,breaks,strength,naked,retired)
      VALUES (@id,@symbol,@trading_day,@price,@source,@kind,@first_seen_ts,@last_test_ts,@visits,@holds,@breaks,@strength,@naked,@retired)`);
    this.db.transaction((ls: RegisteredLevel[]) => ls.forEach((l) => ins.run({
      id: l.id, symbol: l.symbol, trading_day: this.tradingDay, price: l.price, source: l.source, kind: l.kind,
      first_seen_ts: l.firstSeenTs, last_test_ts: l.lastTestTs, visits: l.visits, holds: l.holds, breaks: l.breaks,
      strength: l.strength, naked: l.naked ? 1 : 0, retired: l.retired ? 1 : 0,
    })))(this.reg.all());
  }
  close(): void { this.db.close(); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS levels (
  id TEXT PRIMARY KEY, symbol TEXT, trading_day TEXT, price REAL, source TEXT, kind TEXT,
  first_seen_ts INTEGER, last_test_ts INTEGER, visits INTEGER, holds INTEGER, breaks INTEGER,
  strength REAL, naked INTEGER, retired INTEGER
);
CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY, level_id TEXT, symbol TEXT, trading_day TEXT, ts_ms INTEGER,
  source TEXT, kind TEXT, level_price REAL, side TEXT, visit_index INTEGER, held INTEGER,
  taps INTEGER, dwell_ms INTEGER, penetration REAL, absorbed_vol REAL, lambda REAL, ofi_net REAL
);
CREATE INDEX IF NOT EXISTS idx_int_level ON interactions(level_id);
CREATE INDEX IF NOT EXISTS idx_int_day ON interactions(symbol, trading_day);
`;
export { LM_CFG };
