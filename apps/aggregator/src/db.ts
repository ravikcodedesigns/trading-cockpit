import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import type { AggregatorEvent, ConfluenceSignal } from '@trading/contracts';
import type { RSScoreResult } from './rules-v2/rs-level-scorer.js';
import type { RSContext } from './rs-context.js';

// Ensure data directory exists
const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const _db = new Database(config.dbPath);
_db.pragma('journal_mode = WAL');
_db.pragma('synchronous = NORMAL');

_db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    source TEXT NOT NULL,
    type TEXT NOT NULL,
    symbol TEXT,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_source_type ON events(source, type);
  CREATE INDEX IF NOT EXISTS idx_events_symbol ON events(symbol);

  CREATE TABLE IF NOT EXISTS signals (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                  INTEGER NOT NULL,
    symbol              TEXT    NOT NULL,
    rule_id             TEXT    NOT NULL,
    score               INTEGER NOT NULL,
    direction           TEXT    NOT NULL,
    strategy_version    TEXT,
    rule_version        TEXT,
    payload             TEXT    NOT NULL,
    -- RS score components
    rs_score            INTEGER,
    rs_tier             TEXT,
    rs_level_score      INTEGER,
    rs_context_score    INTEGER,
    rs_confirm_score    INTEGER,
    -- Matched level
    rs_matched_level    TEXT,
    rs_matched_level_type TEXT,
    rs_dist_pts         REAL,
    rs_nearest_level_pts REAL,
    rs_is_est           INTEGER,
    rs_level_test_count INTEGER,
    -- Alignment flags
    rs_gm_aligned       INTEGER,
    rs_dd_aligned       INTEGER,
    rs_lm_aligned       INTEGER,
    rs_break_and_return INTEGER,
    rs_hard_filtered    INTEGER,
    rs_filter_reason    TEXT,
    rs_is_rational      INTEGER,
    -- Exit targets
    rs_tp1_label        TEXT,
    rs_tp1_price        REAL,
    rs_tp1_pts          INTEGER,
    rs_tp2_label        TEXT,
    rs_tp2_price        REAL,
    rs_tp2_pts          INTEGER,
    rs_label_line       TEXT,
    -- Context snapshot at signal time
    ctx_gm              TEXT,
    ctx_dd_ratio        REAL,
    ctx_lm_code         TEXT,
    ctx_mhp_res         INTEGER,
    ctx_hp_res          INTEGER,
    ctx_redist_res      INTEGER,
    ctx_vx              REAL,
    ctx_bbb             REAL,
    ctx_vvix            REAL,
    ctx_vx_above_bbb    INTEGER,
    ctx_vvix_elevated   INTEGER,
    ctx_vvix_golden     INTEGER,
    ctx_is_rational     INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
  CREATE INDEX IF NOT EXISTS idx_signals_rule ON signals(rule_id);

  CREATE TABLE IF NOT EXISTS expl_short_observations (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    detected_ts         INTEGER NOT NULL,
    peak_ts             INTEGER NOT NULL UNIQUE,
    peak_price          REAL    NOT NULL,
    trough_price        REAL    NOT NULL,
    drop_pts            REAL    NOT NULL,
    mins_to_trough      INTEGER NOT NULL,
    symbol              TEXT    NOT NULL DEFAULT 'NQ',
    approach_up_bars    INTEGER,
    approach_net_pts    REAL,
    approach_range_pts  REAL,
    approach_vol        INTEGER,
    approach_buy_vol    INTEGER,
    approach_sell_vol   INTEGER,
    approach_delta      INTEGER,
    compression_range   REAL,
    compression_delta   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_expl_short_obs_peak_ts ON expl_short_observations(peak_ts);
`);

// --- Migration: add RS analysis columns to existing signals tables ---
// Each ALTER TABLE is wrapped in try/catch so it's a no-op if the column
// already exists (better-sqlite3 throws on "duplicate column name").
const _signalsMigrationColumns: [string, string][] = [
  ['strategy_version',     'TEXT'],
  ['rule_version',         'TEXT'],
  ['rs_score',             'INTEGER'],
  ['rs_tier',              'TEXT'],
  ['rs_level_score',       'INTEGER'],
  ['rs_context_score',     'INTEGER'],
  ['rs_confirm_score',     'INTEGER'],
  ['rs_matched_level',     'TEXT'],
  ['rs_matched_level_type','TEXT'],
  ['rs_dist_pts',          'REAL'],
  ['rs_nearest_level_pts', 'REAL'],
  ['rs_is_est',            'INTEGER'],
  ['rs_level_test_count',  'INTEGER'],
  ['rs_gm_aligned',        'INTEGER'],
  ['rs_dd_aligned',        'INTEGER'],
  ['rs_lm_aligned',        'INTEGER'],
  ['rs_break_and_return',  'INTEGER'],
  ['rs_hard_filtered',     'INTEGER'],
  ['rs_filter_reason',     'TEXT'],
  ['rs_is_rational',       'INTEGER'],
  ['rs_tp1_label',         'TEXT'],
  ['rs_tp1_price',         'REAL'],
  ['rs_tp1_pts',           'INTEGER'],
  ['rs_tp2_label',         'TEXT'],
  ['rs_tp2_price',         'REAL'],
  ['rs_tp2_pts',           'INTEGER'],
  ['rs_label_line',        'TEXT'],
  ['ctx_gm',               'TEXT'],
  ['ctx_dd_ratio',         'REAL'],
  ['ctx_lm_code',          'TEXT'],
  ['ctx_mhp_res',          'INTEGER'],
  ['ctx_hp_res',           'INTEGER'],
  ['ctx_redist_res',       'INTEGER'],
  ['ctx_vx',               'REAL'],
  ['ctx_bbb',              'REAL'],
  ['ctx_vvix',             'REAL'],
  ['ctx_vx_above_bbb',     'INTEGER'],
  ['ctx_vvix_elevated',    'INTEGER'],
  ['ctx_vvix_golden',      'INTEGER'],
  ['ctx_is_rational',      'INTEGER'],
];
for (const [col, type] of _signalsMigrationColumns) {
  try { _db.exec(`ALTER TABLE signals ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
}
// Add new indexes (IF NOT EXISTS is safe to re-run)
_db.exec(`
  CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
  CREATE INDEX IF NOT EXISTS idx_signals_rs_tier ON signals(rs_tier);
  CREATE INDEX IF NOT EXISTS idx_signals_rs_score ON signals(rs_score);
  CREATE INDEX IF NOT EXISTS idx_signals_rs_matched_level ON signals(rs_matched_level);
  CREATE INDEX IF NOT EXISTS idx_signals_ctx_gm ON signals(ctx_gm);
  CREATE INDEX IF NOT EXISTS idx_signals_ctx_lm_code ON signals(ctx_lm_code);
`);

// Migration: add delta15 percentile columns to qualified_signals.
// These are observational flags — signals are never removed based on them.
for (const [col, type] of [
  ['delta15_pct_rank', 'REAL'],
  ['delta15_caution',  'INTEGER'],
] as [string, string][]) {
  try { _db.exec(`ALTER TABLE qualified_signals ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
}

// ── V3 tables ──────────────────────────────────────────────────────────────
//
// open_trades: one row per symbol with an active V3 trade.
//   - signal_id  : the signal that opened the trade (FK → signals.id)
//   - rule_id    : 'absorption' | 'clean-impulse' | 'expl'
//   - pattern    : 'FLIP' for clean-impulse FLIPs; NULL otherwise
//   - tp_pts/sl_pts : configured at trade-open time (per-rule, per-direction)
//
// v3_decisions: append-only audit log. Every signal that runs through the V3
// pipeline (shadow OR live) writes one row here. Used by the daily diff script
// to verify the live decisions exactly match the offline backtest.
//
// Both tables are V3-only. If V3 is later removed, drop these two tables and
// no other system is affected.
_db.exec(`
  CREATE TABLE IF NOT EXISTS open_trades (
    symbol      TEXT    PRIMARY KEY,
    signal_id   INTEGER NOT NULL,
    rule_id     TEXT    NOT NULL,
    pattern     TEXT,
    direction   TEXT    NOT NULL,
    entry       REAL    NOT NULL,
    tp_pts      REAL    NOT NULL,
    sl_pts      REAL    NOT NULL,
    open_ts     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS v3_decisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    symbol      TEXT    NOT NULL,
    signal_id   INTEGER,
    rule_id     TEXT    NOT NULL,
    pattern     TEXT,
    direction   TEXT    NOT NULL,
    qualified   INTEGER NOT NULL,
    active_mode TEXT    NOT NULL,    -- 'shadow' | 'live'
    action      TEXT    NOT NULL,    -- 'OPEN' | 'CLOSE' | 'SKIP_COOLDOWN' | 'SKIP_FLIP_SHORT' | 'SKIP_CVD' | 'SKIP_SILENCED' | 'SKIP_NOT_V3_RULE' | 'SKIP_FORCE_SHADOW'
    reason      TEXT    NOT NULL,
    cvd_session REAL,
    entry       REAL,
    exit_price  REAL,                -- set on CLOSE rows
    exit_outcome TEXT,               -- 'WIN' | 'LOSS' | 'OPP_SIG_EXIT' | 'CLOSE_AT_BELL'
    pnl_pts     REAL,
    open_trade_id INTEGER            -- the open_trades row this acted on (CLOSE/SKIP_COOLDOWN)
  );
  CREATE INDEX IF NOT EXISTS idx_v3_decisions_ts        ON v3_decisions(ts);
  CREATE INDEX IF NOT EXISTS idx_v3_decisions_symbol_ts ON v3_decisions(symbol, ts);
  CREATE INDEX IF NOT EXISTS idx_v3_decisions_action    ON v3_decisions(action);

  -- tradable_signals: PR #2 of the signal-pipeline refactor.
  -- One row per signal that ran through evaluateActionability() (i.e. every
  -- raw signal that's a V3-eligible rule, in a tradable symbol). Stores the
  -- pipeline's decision — OPEN or SKIP_X — and whether it was a shadow rule.
  --
  -- Parallel-observer mode: today the trader still acts on the original V3
  -- bus broadcast; this table is for divergence detection and acceptance
  -- testing. After cutover, the trader will subscribe to action='OPEN' rows
  -- here and shadow=0 (live trades only).
  --
  -- One row per signal_id (PK), upserted. Lets the row reflect the most
  -- recent evaluation if signal payloads change shape mid-day.
  CREATE TABLE IF NOT EXISTS tradable_signals (
    signal_id    INTEGER PRIMARY KEY REFERENCES signals(id),
    signal_ts    INTEGER NOT NULL,
    symbol       TEXT    NOT NULL,
    rule_id      TEXT    NOT NULL,
    pattern      TEXT,                 -- FLIP for clean-impulse FLIPs; NULL otherwise
    direction    TEXT    NOT NULL,
    score        INTEGER NOT NULL,
    qualified    INTEGER NOT NULL,    -- 1 if evaluateTechnical returned gold
    action       TEXT    NOT NULL,    -- 'OPEN' | 'SKIP_NOT_V3_RULE' | 'SKIP_SILENCED' | 'SKIP_FORCE_SHADOW' | 'SKIP_FLIP_SHORT' | 'SKIP_CVD' | 'SKIP_COOLDOWN'
    reason       TEXT    NOT NULL,
    shadow       INTEGER NOT NULL DEFAULT 0,  -- 1 = logged for analysis, not traded (force-shadow rules)
    cvd_session  REAL,
    entry        REAL,
    evaluated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tradable_ts            ON tradable_signals(signal_ts);
  CREATE INDEX IF NOT EXISTS idx_tradable_symbol_ts     ON tradable_signals(symbol, signal_ts);
  CREATE INDEX IF NOT EXISTS idx_tradable_action        ON tradable_signals(action);
  CREATE INDEX IF NOT EXISTS idx_tradable_symbol_action ON tradable_signals(symbol, action);
`);

const stmtInsertEvent = _db.prepare(
  'INSERT INTO events (ts, source, type, symbol, payload) VALUES (?, ?, ?, ?, ?)'
);
const stmtInsertSignal = _db.prepare(`
  INSERT INTO signals (
    ts, symbol, rule_id, score, direction, strategy_version, rule_version, payload,
    rs_score, rs_tier, rs_level_score, rs_context_score, rs_confirm_score,
    rs_matched_level, rs_matched_level_type, rs_dist_pts, rs_nearest_level_pts,
    rs_is_est, rs_level_test_count,
    rs_gm_aligned, rs_dd_aligned, rs_lm_aligned, rs_break_and_return,
    rs_hard_filtered, rs_filter_reason, rs_is_rational,
    rs_tp1_label, rs_tp1_price, rs_tp1_pts,
    rs_tp2_label, rs_tp2_price, rs_tp2_pts,
    rs_label_line,
    ctx_gm, ctx_dd_ratio, ctx_lm_code,
    ctx_mhp_res, ctx_hp_res, ctx_redist_res,
    ctx_vx, ctx_bbb, ctx_vvix,
    ctx_vx_above_bbb, ctx_vvix_elevated, ctx_vvix_golden, ctx_is_rational
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?
  )
`);
const stmtCountEvents = _db.prepare('SELECT COUNT(*) AS c FROM events');
const stmtRecentSignals = _db.prepare(
  // Pre-filter to gold-tier candidate rules before applying the limit.
  // This prevents high-frequency silenced rules (tape-speed, sweep) from
  // crowding out low-frequency gold rules (absorption, divergence, expl) in the
  // snapshot window. The quality gate still applies in state.ts.
  // Signals marked meta.filtered=1 are suppressed by the ORM/comp_pos/zone-proximity
  // filters added 2026-05-18 — they stay in the DB for outcome analysis but
  // are excluded from the cockpit display.
  `SELECT payload FROM signals
   WHERE (rule_id IN ('absorption', 'delta-divergence', 'large-print', 'expl', 'clean-impulse', 'trap')
      OR (rule_id = 'sweep' AND score >= 60))
     AND json_extract(meta, '$.filtered') IS NOT 1
     AND rs_hard_filtered IS NOT 1
   ORDER BY ts DESC LIMIT ?`
);
const stmtRecentEvents = _db.prepare(
  'SELECT payload FROM events ORDER BY ts DESC LIMIT ?'
);
const stmtExplInWindow = _db.prepare(
  `SELECT ts, direction FROM signals
   WHERE rule_id = 'expl' AND symbol = ? AND ts >= ? AND ts < ?
   ORDER BY ts ASC`
);
// Returns the most recent H FLIP signal for a symbol in [fromTs, beforeTs).
const stmtLastFlipInWindow = _db.prepare(
  `SELECT ts, direction, CAST(json_extract(payload, '$.entry') AS REAL) as entry FROM signals
   WHERE strategy_version = 'H'
     AND json_extract(payload, '$.pattern') = 'FLIP'
     AND symbol = ? AND ts >= ? AND ts < ?
   ORDER BY ts DESC LIMIT 1`
);

// Returns final bars for a symbol, deduplicated by bar-start timestamp.
// The addon emits partial bars every second AND a final bar at minute close.
// We pick MAX(ts) per bucket which prefers the LAST emit per bar (the most
// complete version). Since both partial and final bars share the same
// bucket-start in their payload, but different ts values, we use payload's
// open timestamp as the bucket key.
const stmtRecentBars = _db.prepare(`
  SELECT payload FROM events
  WHERE source IN ('bookmap', 'bookmap-es')
    AND type = 'bar'
    AND symbol = ?
    AND ts >= ?
  ORDER BY ts ASC
`);

const stmtBarsBetween = _db.prepare(`
  SELECT payload FROM events
  WHERE source IN ('bookmap', 'bookmap-es')
    AND type = 'bar'
    AND symbol = ?
    AND ts >= ?
    AND ts <  ?
  ORDER BY ts ASC
`);

export const db = {
  logEvent(evt: AggregatorEvent): number {
    const result = stmtInsertEvent.run(
      evt.ts,
      evt.source,
      evt.type,
      (evt as { symbol?: string }).symbol ?? null,
      JSON.stringify(evt)
    );
    return Number(result.lastInsertRowid);
  },

  logSignal(sig: ConfluenceSignal): number {
    const rs  = (sig as any)._rsResult  as RSScoreResult | undefined;
    const ctx = (sig as any)._rsContext as RSContext      | undefined;

    const b = (v: boolean | null | undefined): number | null =>
      v === null || v === undefined ? null : v ? 1 : 0;

    const result = stmtInsertSignal.run(
      // core signal fields
      sig.ts,
      sig.symbol,
      sig.ruleId,
      sig.score,
      sig.direction,
      sig.strategyVersion ?? 'A',
      sig.ruleVersion ?? (sig.ruleId + '-v1'),
      JSON.stringify(sig),
      // RS score components
      rs?.score                         ?? null,
      rs?.tier                          ?? null,
      rs?.components.level              ?? null,
      rs?.components.context            ?? null,
      rs?.components.confirm            ?? null,
      // matched level
      rs?.matchedLevel?.label           ?? null,
      rs?.matchedLevel?.type            ?? null,
      rs?.matchedLevel?.distancePts     ?? null,
      rs?.nearestLevelPts               ?? null,
      b(rs?.isEST),
      rs?.levelTestCount                ?? null,
      // alignment flags
      b(rs?.gmAligned),
      b(rs?.ddAligned),
      rs?.lmCodeAligned === null || rs?.lmCodeAligned === undefined ? null : b(rs.lmCodeAligned),
      b(rs?.breakAndReturn),
      b(rs?.hardFiltered),
      rs?.filterReason                  ?? null,
      b(rs?.isRational),
      // exit targets
      rs?.tp1?.label                    ?? null,
      rs?.tp1?.price                    ?? null,
      rs?.tp1?.pts                      ?? null,
      rs?.tp2?.label                    ?? null,
      rs?.tp2?.price                    ?? null,
      rs?.tp2?.pts                      ?? null,
      rs?.labelLine                     ?? null,
      // context snapshot
      ctx?.greaterMarket                ?? null,
      ctx?.ddRatio                      ?? null,
      rs?.lmCode                        ?? null,
      ctx?.mhpResilience                ?? null,
      ctx?.hpResilience                 ?? null,
      ctx?.redistResilience             ?? null,
      ctx?.vx                           ?? null,
      ctx?.bbb                          ?? null,
      ctx?.vvix                         ?? null,
      b(ctx?.vxAboveBBB),
      b(ctx?.vvixElevated),
      b(ctx?.vvixGolden),
      b(ctx?.isRational),
    );
    return Number(result.lastInsertRowid);
  },

  eventCount(): number {
    return (stmtCountEvents.get() as { c: number }).c;
  },

  lastSignalTs(ruleId: string): number {
    const row = _db.prepare('SELECT MAX(ts) AS ts FROM signals WHERE rule_id = ?').get(ruleId) as { ts: number | null };
    return row?.ts ?? 0;
  },

  lastSignalTsFor(ruleId: string, symbol: string, direction: string): number {
    const row = _db.prepare('SELECT MAX(ts) AS ts FROM signals WHERE rule_id = ? AND symbol = ? AND direction = ?').get(ruleId, symbol, direction) as { ts: number | null };
    return row?.ts ?? 0;
  },

  // Returns the most recent approved-parent trigger signal for the given
  // symbol+direction within the last `withinMs` ms. Used by strategy-CONT to
  // establish the parent trend signal and its entry price.
  //
  // Approved parents (explicit, in order of historical contribution):
  //   - strategy_version='H'                          → clean-impulse FLIP
  //   - strategy_version='EXPL', direction='long'     → EXPL long
  //   - strategy_version='B',   score >= 80           → absorption-tier B rules
  //   - strategy_version='WBF'                        → wall-broken-fade (any score)
  recentGoldTriggerFor(
    symbol: string,
    direction: string,
    withinMs: number,
    nowMs: number,
  ): { ts: number; entry: number } | null {
    const sinceTs = nowMs - withinMs;
    const row = _db.prepare(`
      SELECT ts, json_extract(payload, '$.entry') AS entry
      FROM signals
      WHERE symbol = ? AND direction = ?
        AND ts >= ? AND ts <= ?
        AND rs_hard_filtered IS NOT 1
        AND (
          (strategy_version = 'H')
          OR (strategy_version = 'EXPL' AND direction = 'long')
          OR (strategy_version = 'B' AND score >= 80)
          OR (strategy_version = 'WBF')
        )
      ORDER BY ts DESC
      LIMIT 1
    `).get(symbol, direction, sinceTs, nowMs) as { ts: number; entry: number | null } | undefined;
    if (!row || row.entry === null) return null;
    return { ts: row.ts, entry: row.entry };
  },

  recentSignals(n: number): ConfluenceSignal[] {
    return stmtRecentSignals
      .all(n)
      .map((r) => JSON.parse((r as { payload: string }).payload));
  },

  // Returns full ConfluenceSignal payloads for every signal that passed the
  // quality gate (= was written into qualified_signals) since `sinceMs`.
  // Used by the cockpit snapshot so signal cards survive cockpit reloads
  // and aggregator restarts — qualified_signals is the persisted record of
  // "this was gold at fire time", no in-memory re-classification needed.
  qualifiedSignalsSince(sinceMs: number, limit: number): ConfluenceSignal[] {
    return _db.prepare(`
      SELECT s.payload
      FROM qualified_signals q
      JOIN signals s ON s.id = q.signal_id
      WHERE q.signal_ts >= ?
      ORDER BY q.signal_ts DESC
      LIMIT ?
    `).all(sinceMs, limit).map((r) => JSON.parse((r as { payload: string }).payload));
  },

  // Symbol-scoped qualified-signal feed for the chart's QUALIFIED button.
  // Reads from tradable_signals WHERE qualified=1 (LIVE, written on every
  // signal by the pipeline) instead of the legacy qualified_signals table
  // (STALE — only refreshed by `pnpm qualify` script runs).
  //
  // Migrated 2026-06-09. The old qualified_signals table still exists and is
  // still populated by reapply_quality_gates.ts for re-evaluation work
  // (GATE_VERSION bumps), but is no longer the read source for the live chart.
  //
  // excludeRules is preserved for back-compat — e.g. wall-broken-fade is
  // technically qualified but the chart UI hides it (visual-monitor only).
  qualifiedSignalsForSymbol(symbol: string, sinceMs: number, limit: number, excludeRules: string[]): ConfluenceSignal[] {
    const exclPlaceholders = excludeRules.length > 0
      ? `AND t.rule_id NOT IN (${excludeRules.map(() => '?').join(',')})`
      : '';
    return _db.prepare(`
      SELECT s.payload
      FROM tradable_signals t
      JOIN signals s ON s.id = t.signal_id
      WHERE t.qualified = 1 AND t.symbol = ? AND t.signal_ts >= ?
        ${exclPlaceholders}
      ORDER BY t.signal_ts DESC
      LIMIT ?
    `).all(symbol, sinceMs, ...excludeRules, limit)
      .map((r) => JSON.parse((r as { payload: string }).payload));
  },

  // Returns full ConfluenceSignal payloads for every signal V3 actually OPENed
  // on a symbol since `sinceMs`. Used by /signals/marks so V3-mode renders
  // rich markers (FLIP↑/↓+score etc.) for historical V3 OPENs, not just dots.
  v3OpenSignalsForSymbol(symbol: string, sinceMs: number, limit: number): ConfluenceSignal[] {
    return _db.prepare(`
      SELECT s.payload
      FROM v3_decisions v
      JOIN signals s ON s.id = v.signal_id
      WHERE v.symbol = ? AND v.ts >= ? AND v.action = 'OPEN'
      ORDER BY v.ts DESC
      LIMIT ?
    `).all(symbol, sinceMs, limit)
      .map((r) => JSON.parse((r as { payload: string }).payload));
  },

  // Returns full ConfluenceSignal payloads for every signal the new pipeline
  // would have OPENed (action='OPEN' AND shadow=0). This is what the trader
  // would auto-trade under pipeline.activeMode='live'. Used by /signals/marks
  // to render the TRADABLE button's markers on the chart.
  tradableOpenSignalsForSymbol(symbol: string, sinceMs: number, limit: number): ConfluenceSignal[] {
    return _db.prepare(`
      SELECT s.payload
      FROM tradable_signals t
      JOIN signals s ON s.id = t.signal_id
      WHERE t.symbol = ? AND t.signal_ts >= ? AND t.action = 'OPEN' AND t.shadow = 0
      ORDER BY t.signal_ts DESC
      LIMIT ?
    `).all(symbol, sinceMs, limit)
      .map((r) => JSON.parse((r as { payload: string }).payload));
  },

  // Returns signals from rules that are in force-shadow (logged but never
  // traded — e.g. es-flip, expl). action='OPEN' but shadow=1 OR
  // action='SKIP_FORCE_SHADOW'. Used by /signals/marks to render the
  // EXPERIMENTAL toggle's markers, so the user can see what shadowed rules
  // would have done without committing capital.
  experimentalSignalsForSymbol(symbol: string, sinceMs: number, limit: number): ConfluenceSignal[] {
    return _db.prepare(`
      SELECT s.payload
      FROM tradable_signals t
      JOIN signals s ON s.id = t.signal_id
      WHERE t.symbol = ? AND t.signal_ts >= ?
        AND (t.shadow = 1 OR t.action = 'SKIP_FORCE_SHADOW')
      ORDER BY t.signal_ts DESC
      LIMIT ?
    `).all(symbol, sinceMs, limit)
      .map((r) => JSON.parse((r as { payload: string }).payload));
  },

  recentEvents(n: number): AggregatorEvent[] {
    return stmtRecentEvents
      .all(n)
      .map((r) => JSON.parse((r as { payload: string }).payload));
  },

  // Returns one bar per minute-bucket for the given symbol, deduplicated
  // by the bar's own ts (bucket start) field. When the addon emits both
  // partial and final bars for the same minute, the most recently inserted
  // wins (which will be the final/most-complete bar).
  recentBars(symbol: string, sinceMs: number): unknown[] {
    const rows = stmtRecentBars.all(symbol, sinceMs) as { payload: string }[];
    const byBucket = new Map<number, unknown>();
    for (const r of rows) {
      const bar = JSON.parse(r.payload) as { ts: number };
      // ts on the bar IS the bucket-start; later inserts overwrite earlier
      // ones, leaving us with the most recent payload per bucket.
      byBucket.set(bar.ts, bar);
    }
    return Array.from(byBucket.values()).sort(
      (a, b) => (a as { ts: number }).ts - (b as { ts: number }).ts
    );
  },

  barsBetween(symbol: string, fromMs: number, toMs: number): unknown[] {
    const rows = stmtBarsBetween.all(symbol, fromMs, toMs) as { payload: string }[];
    const byBucket = new Map<number, unknown>();
    for (const r of rows) {
      const bar = JSON.parse(r.payload) as { ts: number };
      byBucket.set(bar.ts, bar);
    }
    return Array.from(byBucket.values()).sort(
      (a, b) => (a as { ts: number }).ts - (b as { ts: number }).ts
    );
  },

  logExplShortObs(obs: {
    detectedTs: number; peakTs: number; peakPrice: number; troughPrice: number;
    dropPts: number; minsToTrough: number; symbol: string;
    approachUpBars: number; approachNetPts: number; approachRangePts: number;
    approachVol: number; approachBuyVol: number; approachSellVol: number; approachDelta: number;
    compressionRange: number; compressionDelta: number;
  }): void {
    _db.prepare(`
      INSERT OR IGNORE INTO expl_short_observations
        (detected_ts, peak_ts, peak_price, trough_price, drop_pts, mins_to_trough, symbol,
         approach_up_bars, approach_net_pts, approach_range_pts,
         approach_vol, approach_buy_vol, approach_sell_vol, approach_delta,
         compression_range, compression_delta)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      obs.detectedTs, obs.peakTs, obs.peakPrice, obs.troughPrice,
      obs.dropPts, obs.minsToTrough, obs.symbol,
      obs.approachUpBars, obs.approachNetPts, obs.approachRangePts,
      obs.approachVol, obs.approachBuyVol, obs.approachSellVol, obs.approachDelta,
      obs.compressionRange, obs.compressionDelta,
    );
  },

  // Returns EXPL signals for a symbol in a half-open window [fromTs, beforeTs).
  // Used by the quality gate to detect active opposing EXPL context.
  explInWindow(symbol: string, fromTs: number, beforeTs: number): { ts: number; direction: string }[] {
    return stmtExplInWindow.all(symbol, fromTs, beforeTs) as { ts: number; direction: string }[];
  },

  // Returns the most recent H FLIP signal for a symbol in [fromTs, beforeTs), or null.
  // Used by the absorption quality gate to require same-direction FLIP context.
  lastFlipInWindow(symbol: string, fromTs: number, beforeTs: number): { ts: number; direction: string; entry?: number } | null {
    return (stmtLastFlipInWindow.get(symbol, fromTs, beforeTs) as { ts: number; direction: string; entry?: number } | undefined) ?? null;
  },

  close() {
    _db.close();
  },

  // Generic read-only query for ad-hoc SQL in server routes.
  // Use sparingly — prefer named prepared statements for hot paths.
  query<T = unknown>(sql: string, params: unknown[] = []): T[] {
    return _db.prepare(sql).all(...params) as T[];
  },

  // ── V3 helpers ───────────────────────────────────────────────────────────
  v3: {
    upsertOpenTrade(t: V3OpenTrade): void {
      stmtV3UpsertOpenTrade.run(
        t.symbol, t.signalId, t.ruleId, t.pattern ?? null,
        t.direction, t.entry, t.tpPts, t.slPts, t.openTs,
      );
    },
    getOpenTrade(symbol: string): V3OpenTrade | null {
      const row = stmtV3GetOpenTrade.get(symbol) as any;
      if (!row) return null;
      return {
        symbol: row.symbol, signalId: row.signal_id, ruleId: row.rule_id,
        pattern: row.pattern, direction: row.direction, entry: row.entry,
        tpPts: row.tp_pts, slPts: row.sl_pts, openTs: row.open_ts,
      };
    },
    getAllOpenTrades(): V3OpenTrade[] {
      const rows = stmtV3GetAllOpenTrades.all() as any[];
      return rows.map(row => ({
        symbol: row.symbol, signalId: row.signal_id, ruleId: row.rule_id,
        pattern: row.pattern, direction: row.direction, entry: row.entry,
        tpPts: row.tp_pts, slPts: row.sl_pts, openTs: row.open_ts,
      }));
    },
    deleteOpenTrade(symbol: string): void {
      stmtV3DeleteOpenTrade.run(symbol);
    },
    logDecision(d: V3Decision): number {
      const res = stmtV3InsertDecision.run(
        d.ts, d.symbol, d.signalId ?? null, d.ruleId, d.pattern ?? null,
        d.direction, d.qualified ? 1 : 0, d.activeMode, d.action, d.reason,
        d.cvdSession ?? null, d.entry ?? null,
        d.exitPrice ?? null, d.exitOutcome ?? null, d.pnlPts ?? null,
        d.openTradeId ?? null,
      );
      return Number(res.lastInsertRowid);
    },
  },

  // ── tradable_signals helpers (PR #2 of signal-pipeline refactor) ────────
  tradable: {
    upsert(row: TradableSignalRow): void {
      stmtTradableUpsert.run(
        row.signal_id, row.signal_ts, row.symbol, row.rule_id,
        row.pattern ?? null, row.direction, row.score,
        row.qualified ? 1 : 0, row.action, row.reason, row.shadow ? 1 : 0,
        row.cvd_session ?? null, row.entry ?? null, row.evaluated_at,
      );
    },
  },
};

// V3 types and prepared statements
export interface V3OpenTrade {
  symbol: string;
  signalId: number;
  ruleId: string;
  pattern: string | null;
  direction: 'long' | 'short';
  entry: number;
  tpPts: number;
  slPts: number;
  openTs: number;
}

// Row shape for the tradable_signals table (PR #2 refactor).
export interface TradableSignalRow {
  signal_id:    number;
  signal_ts:    number;
  symbol:       string;
  rule_id:      string;
  pattern:      string | null;
  direction:    'long' | 'short';
  score:        number;
  qualified:    boolean;
  action:       'OPEN' | 'SKIP_NOT_V3_RULE' | 'SKIP_SILENCED' | 'SKIP_FORCE_SHADOW' | 'SKIP_FLIP_SHORT' | 'SKIP_CVD' | 'SKIP_COOLDOWN';
  reason:       string;
  shadow:       boolean;
  cvd_session?: number;
  entry?:       number;
  evaluated_at: number;
}

export interface V3Decision {
  ts: number;
  symbol: string;
  signalId: number | null;
  ruleId: string;
  pattern: string | null;
  direction: 'long' | 'short';
  qualified: boolean;
  activeMode: 'shadow' | 'live';
  action: 'OPEN' | 'CLOSE' | 'SKIP_COOLDOWN' | 'SKIP_FLIP_SHORT' | 'SKIP_CVD' | 'SKIP_SILENCED' | 'SKIP_NOT_V3_RULE' | 'SKIP_FORCE_SHADOW';
  reason: string;
  cvdSession?: number;
  entry?: number;
  exitPrice?: number;
  exitOutcome?: 'WIN' | 'LOSS' | 'OPP_SIG_EXIT' | 'CLOSE_AT_BELL';
  pnlPts?: number;
  openTradeId?: number;
}

const stmtV3UpsertOpenTrade = _db.prepare(`
  INSERT INTO open_trades (symbol, signal_id, rule_id, pattern, direction, entry, tp_pts, sl_pts, open_ts)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(symbol) DO UPDATE SET
    signal_id = excluded.signal_id,
    rule_id   = excluded.rule_id,
    pattern   = excluded.pattern,
    direction = excluded.direction,
    entry     = excluded.entry,
    tp_pts    = excluded.tp_pts,
    sl_pts    = excluded.sl_pts,
    open_ts   = excluded.open_ts
`);
const stmtV3GetOpenTrade     = _db.prepare(`SELECT * FROM open_trades WHERE symbol = ?`);
const stmtV3GetAllOpenTrades = _db.prepare(`SELECT * FROM open_trades`);
const stmtV3DeleteOpenTrade  = _db.prepare(`DELETE FROM open_trades WHERE symbol = ?`);
const stmtV3InsertDecision   = _db.prepare(`
  INSERT INTO v3_decisions (
    ts, symbol, signal_id, rule_id, pattern, direction, qualified,
    active_mode, action, reason, cvd_session, entry,
    exit_price, exit_outcome, pnl_pts, open_trade_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// tradable_signals upsert — one row per signal_id, overwrites on conflict.
const stmtTradableUpsert = _db.prepare(`
  INSERT INTO tradable_signals (
    signal_id, signal_ts, symbol, rule_id, pattern, direction, score,
    qualified, action, reason, shadow, cvd_session, entry, evaluated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(signal_id) DO UPDATE SET
    signal_ts    = excluded.signal_ts,
    symbol       = excluded.symbol,
    rule_id      = excluded.rule_id,
    pattern      = excluded.pattern,
    direction    = excluded.direction,
    score        = excluded.score,
    qualified    = excluded.qualified,
    action       = excluded.action,
    reason       = excluded.reason,
    shadow       = excluded.shadow,
    cvd_session  = excluded.cvd_session,
    entry        = excluded.entry,
    evaluated_at = excluded.evaluated_at
`);

logger.info({ path: config.dbPath }, 'database ready');
