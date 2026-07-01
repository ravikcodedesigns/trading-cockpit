// RS Context time-series logger.
//
// The live rs-feed overwrites data/rs-context.json every ~5s, so the per-day TRACE of the values
// that drive direction/bias/size (greater-market, DD ratio, the three resiliences, LM code, MM bias,
// vol environment) is otherwise lost — only the latest snapshot survives. This appends a row per
// symbol every time the context actually updates (deduped on `setAt`), so we can later backtest and
// re-run scripts against the exact context the engines saw at any minute of any day.
//
// Single-writer by design: started ONCE from the aggregator's main process (index.ts). It only READS
// getContext(); it never writes rs-context.json or touches the engine path. All DB work is wrapped so
// a logging failure can never perturb live reads.
//
// Query example (NQ MHP-resilience trace for a day):
//   sqlite3 data/rs-context-history.db \
//     "SELECT set_at, mhp_res, dd_ratio, gm FROM rs_context_ts
//        WHERE trading_day='2026-06-25' AND symbol='NQ' ORDER BY ts_ms;"

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getContext } from './rs-context.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.resolve(__dirname, '../../../data/rs-context-history.db');

let _db: Database.Database | null = null;
let _insert: Database.Statement | null = null;
let _lastSetAt = '';
let _timer: NodeJS.Timeout | null = null;

function open(): void {
  const db = new Database(HISTORY_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rs_context_ts (
      id INTEGER PRIMARY KEY,
      ts_ms INTEGER NOT NULL,        -- wall-clock ms when this row was logged
      set_at TEXT,                   -- context.setAt: when the rs-feed produced these values
      trading_day TEXT,
      symbol TEXT NOT NULL,          -- NQ / ES / CL / GC (per-symbol overlaid context)
      gm TEXT,                       -- greater-market for this symbol (bull/bear/neutral)
      dd_ratio REAL,                 -- >0.5 bullish
      lm_code TEXT,
      mm_bullish INTEGER,            -- monthly-map bias (nullable)
      mhp_res REAL,                  -- orange — MHP resilience (sign = direction at MHP)
      hp_res REAL,                   -- cyan   — HP/weekly resilience
      redist_res REAL,               -- white  — half-gap/redistribution resilience
      vx REAL, bbb REAL, vvix REAL,
      vx_above_bbb INTEGER, vvix_elevated INTEGER, vvix_golden INTEGER, is_rational INTEGER,
      vx_vol_state TEXT,             -- pinned / above-hp / above-mhp
      qqq_spy_rs REAL,               -- QQQ%chg - SPY%chg (Nasdaq RS)
      spy REAL, qqq REAL,
      dyn_hp_etf REAL, dyn_mhp_etf REAL, dyn_close_etf REAL,
      raw_json TEXT                  -- full per-symbol snapshot for anything not columnized
    );
    CREATE INDEX IF NOT EXISTS idx_rsctx_day_sym_ts ON rs_context_ts(trading_day, symbol, ts_ms);
  `);
  _db = db;
  _insert = db.prepare(`
    INSERT INTO rs_context_ts (
      ts_ms, set_at, trading_day, symbol, gm, dd_ratio, lm_code, mm_bullish,
      mhp_res, hp_res, redist_res, vx, bbb, vvix,
      vx_above_bbb, vvix_elevated, vvix_golden, is_rational, vx_vol_state,
      qqq_spy_rs, spy, qqq, dyn_hp_etf, dyn_mhp_etf, dyn_close_etf, raw_json
    ) VALUES (
      @ts_ms, @set_at, @trading_day, @symbol, @gm, @dd_ratio, @lm_code, @mm_bullish,
      @mhp_res, @hp_res, @redist_res, @vx, @bbb, @vvix,
      @vx_above_bbb, @vvix_elevated, @vvix_golden, @is_rational, @vx_vol_state,
      @qqq_spy_rs, @spy, @qqq, @dyn_hp_etf, @dyn_mhp_etf, @dyn_close_etf, @raw_json
    )`);
}

function snapshot(): void {
  const base = getContext();              // flat context (for setAt / bySymbol keys / macro fields)
  if (!base.setAt || base.setAt === _lastSetAt) return;   // dedup: only on a real feed update
  const symbols = Object.keys(base.bySymbol ?? {});
  if (symbols.length === 0) symbols.push('_all_');         // pre-bySymbol fallback
  const tsMs = Date.now();
  const b01 = (v: boolean | undefined) => (v == null ? null : v ? 1 : 0);

  // Global (non-per-symbol) fields — irrational[], spyMhp/qqqMhp, spyPrev/qqqPrev, uvxy, vxGammaHp/Mhp,
  // etc. — folded into raw_json below so NO data point is missed (columns hold only the derived outputs).
  const { bySymbol: _omitBySymbol, ...globalFields } = base;
  const tx = _db!.transaction(() => {
    for (const sym of symbols) {
      const c = sym === '_all_' ? base : getContext(sym);  // per-symbol overlaid context the engines see
      const sc = base.bySymbol?.[sym];
      _insert!.run({
        ts_ms: tsMs,
        set_at: base.setAt,
        trading_day: base.tradingDay ?? null,
        symbol: sym,
        gm: c.greaterMarket ?? null,
        dd_ratio: c.ddRatio ?? null,
        lm_code: c.lmCode ?? null,
        mm_bullish: b01(sc?.mmBullish),
        mhp_res: c.mhpResilience ?? null,
        hp_res: c.hpResilience ?? null,
        redist_res: c.redistResilience ?? null,
        vx: c.vx ?? null,
        bbb: c.bbb ?? null,
        vvix: c.vvix ?? null,
        vx_above_bbb: b01(c.vxAboveBBB),
        vvix_elevated: b01(c.vvixElevated),
        vvix_golden: b01(c.vvixGolden),
        is_rational: b01(c.isRational),
        vx_vol_state: c.vxVolState ?? null,
        qqq_spy_rs: c.qqqSpyRs ?? null,
        spy: c.spy ?? null,
        qqq: c.qqq ?? null,
        dyn_hp_etf: sc?.dynHpEtf ?? null,
        dyn_mhp_etf: sc?.dynMhpEtf ?? null,
        dyn_close_etf: sc?.dynCloseEtf ?? null,
        raw_json: JSON.stringify(sc ? { ...globalFields, ...sc } : base),  // globals + per-symbol = everything
      });
    }
  });
  tx();
  _lastSetAt = base.setAt;
}

/** Start the per-day RS-context time-series logger. Call ONCE from the aggregator main process. */
export function startContextHistoryLogger(intervalMs = 5_000): void {
  if (_timer) return;
  try {
    open();
  } catch (err) {
    logger.warn({ err }, 'rs-context-history: failed to open DB — time-series logging disabled');
    return;
  }
  const tick = () => {
    try { snapshot(); } catch (err) { logger.warn({ err }, 'rs-context-history: snapshot failed'); }
  };
  tick();                                  // capture immediately on boot
  _timer = setInterval(tick, intervalMs);
  if (typeof _timer.unref === 'function') _timer.unref();
  logger.info({ path: HISTORY_PATH, intervalMs }, 'rs-context-history: time-series logging started');
}
