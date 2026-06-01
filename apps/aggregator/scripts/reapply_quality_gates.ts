/**
 * reapply_quality_gates.ts
 *
 * Re-evaluates every signal in the DB against the current quality gate logic
 * and rebuilds the qualified_signals table from scratch.
 *
 * Run this whenever gate logic changes (bump GATE_VERSION below first):
 *   pnpm --filter aggregator qualify
 *
 * Idempotent — safe to re-run at any time.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySignalQuality } from '../src/quality.js';
import type { ConfluenceSignal } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.resolve(__dirname, '../../../data/trading.db');

// ─── Bump this whenever quality.ts gate logic changes ───────────────────────
const GATE_VERSION = 4;
// ────────────────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Ensure new columns exist (no-op if already added by db.ts migration)
for (const [col, type] of [['delta15_pct_rank', 'REAL'], ['delta15_caution', 'INTEGER']] as [string,string][]) {
  try { db.exec(`ALTER TABLE qualified_signals ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Returns ET minute-of-day (0–1439) for a Unix ms timestamp.
function etMinute(tsMs: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '0';
  return parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
}

// CF Long time gate: block before 09:54 ET and 14:30–16:00 ET (strategy-h.ts Stage 3).
// Applied against bar timestamp — prevents backfill-era signals from slipping through.
function isCfLongTimeAllowed(tsMs: number): boolean {
  const min = etMinute(tsMs);
  if (min < 594) return false;        // before 09:54 ET
  if (min >= 870 && min < 960) return false; // 14:30–16:00 ET
  return true;
}

function classifySession(tsMs: number): 'rth' | 'overnight' {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);
  if (isWeekday && min >= 570 && min < 960) return 'rth';
  return 'overnight';
}

function buildContextJson(sig: any): string {
  switch (sig.ruleId as string) {
    case 'absorption':
      return JSON.stringify({
        trend:               sig.trend              ?? null,
        trendAligned:        sig.trendAligned        ?? null,
        conviction:          sig.conviction          ?? null,
        tapeSpeedConfirmed:  sig.tapeSpeedConfirmed  ?? null,
        largePrintConfirmed: sig.largePrintConfirmed ?? null,
        entry:               sig.entry               ?? null,
        stopDist:            sig.stopDist            ?? null,
      });
    case 'clean-impulse':
      return JSON.stringify({
        pattern:         sig.pattern        ?? null,
        deltaT:          sig.deltaT         ?? null,
        delta5:          sig.delta5         ?? null,
        delta15:         sig.delta15        ?? null,
        deltaLast3:      sig.deltaLast3     ?? null,
        compPos:         sig.compPos        ?? null,
        entry:           sig.entry          ?? null,
        stopDist:        sig.stopDist       ?? null,
        isPositionFlip:  sig.isPositionFlip ?? null,
      });
    case 'expl':
      return JSON.stringify({
        entry:                sig.entry                         ?? null,
        stackedBidZonesCount: Array.isArray(sig.stackedBidZones)
                                ? sig.stackedBidZones.length : null,
        rangePct:             sig.rangePct                      ?? null,
      });
    default:
      return JSON.stringify({
        entry:    sig.entry    ?? null,
        stopDist: sig.stopDist ?? null,
      });
  }
}

// ── Context queries (reconstructs what state.ts had at signal time) ───────────

const EXPL_LOOKBACK_MS = 60 * 60_000;
const FLIP_LOOKBACK_MS = 60 * 60_000;

const stmtExpls = db.prepare(
  `SELECT ts, direction FROM signals
   WHERE rule_id = 'expl' AND symbol = ? AND ts >= ? AND ts < ?
   ORDER BY ts ASC`
);

const stmtLastFlip = db.prepare(
  `SELECT id, ts, direction, CAST(json_extract(payload, '$.entry') AS REAL) AS entry
   FROM signals
   WHERE strategy_version = 'H'
     AND json_extract(payload, '$.pattern') = 'FLIP'
     AND symbol = ? AND direction = ? AND ts >= ? AND ts < ?
   ORDER BY ts DESC LIMIT 1`
);

// For classifySignalQuality absorption gate, we need lastFlip without direction filter
// (quality.ts checks direction match itself).
const stmtLastFlipAny = db.prepare(
  `SELECT ts, direction, CAST(json_extract(payload, '$.entry') AS REAL) AS entry
   FROM signals
   WHERE strategy_version = 'H'
     AND json_extract(payload, '$.pattern') = 'FLIP'
     AND symbol = ? AND ts >= ? AND ts < ?
   ORDER BY ts DESC LIMIT 1`
);

// ── Upsert / delete prepared statements ─────────────────────────────────────

const stmtUpsert = db.prepare(`
  INSERT INTO qualified_signals (
    signal_id, signal_ts, symbol, rule_id, strategy_version, direction, score, session,
    gate_ver, reason, qualified_at,
    flip_signal_id, flip_ts, flip_age_min, flip_pts_drift,
    context_json,
    delta15_pct_rank, delta15_caution
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(signal_id) DO UPDATE SET
    gate_ver         = excluded.gate_ver,
    reason           = excluded.reason,
    qualified_at     = excluded.qualified_at,
    flip_signal_id   = excluded.flip_signal_id,
    flip_ts          = excluded.flip_ts,
    flip_age_min     = excluded.flip_age_min,
    flip_pts_drift   = excluded.flip_pts_drift,
    context_json     = excluded.context_json,
    delta15_pct_rank = excluded.delta15_pct_rank,
    delta15_caution  = excluded.delta15_caution
`);

const stmtDelete = db.prepare('DELETE FROM qualified_signals WHERE signal_id = ?');

// Computes the percentile rank (0–100) of a FLIP signal's delta15 within the
// trailing 60-day distribution of same-direction clean-impulse FLIP signals.
// Returns null when fewer than 5 reference signals exist (insufficient history).
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const stmtDelta15Rank = db.prepare<[string, number, number, number, string, number, number]>(`
  SELECT
    ROUND(
      CAST(
        (SELECT COUNT(*) FROM signals
         WHERE rule_id  = 'clean-impulse'
           AND direction = ?
           AND json_extract(payload, '$.pattern') = 'FLIP'
           AND json_extract(payload, '$.delta15')  IS NOT NULL
           AND ts >= ? AND ts < ?
           AND CAST(json_extract(payload, '$.delta15') AS REAL) <= ?) AS REAL
      ) * 100.0 /
      NULLIF(
        (SELECT COUNT(*) FROM signals
         WHERE rule_id  = 'clean-impulse'
           AND direction = ?
           AND json_extract(payload, '$.pattern') = 'FLIP'
           AND json_extract(payload, '$.delta15')  IS NOT NULL
           AND ts >= ? AND ts < ?),
      0),
    1
  ) AS pct_rank
`);

function computeDelta15Caution(
  direction: string, signalTs: number, delta15: number | null
): { pct_rank: number | null; caution: number } {
  if (delta15 === null || delta15 === undefined) return { pct_rank: null, caution: 0 };
  const windowStart = signalTs - SIXTY_DAYS_MS;
  const row = stmtDelta15Rank.get(
    direction, windowStart, signalTs, delta15,
    direction, windowStart, signalTs,
  ) as { pct_rank: number | null };
  const rank = row?.pct_rank ?? null;
  if (rank === null) return { pct_rank: null, caution: 0 };
  // Longs: bottom 30th percentile = extreme selling background → caution
  // Shorts: top 70th percentile   = extreme buying background  → caution
  const caution = direction === 'long' ? (rank <= 30 ? 1 : 0)
                :                        (rank >= 70 ? 1 : 0);
  return { pct_rank: rank, caution };
}

// ── Load all signals ─────────────────────────────────────────────────────────

const allSignals = db.prepare(
  `SELECT id, ts, symbol, rule_id, strategy_version, direction, score, payload,
          rs_hard_filtered, meta
   FROM signals ORDER BY ts ASC`
).all() as {
  id: number; ts: number; symbol: string; rule_id: string;
  strategy_version: string; direction: string; score: number; payload: string;
  rs_hard_filtered: number | null; meta: string | null;
}[];

console.log(`\nReapplying quality gates to ${allSignals.length} signals (gate_ver=${GATE_VERSION})...\n`);

// ── Process in a single transaction for speed ────────────────────────────────

const now = Date.now();
let qualified = 0;
let silenced  = 0;
let errors    = 0;

const run = db.transaction(() => {
  for (const row of allSignals) {
    let sig: ConfluenceSignal;
    try {
      sig = JSON.parse(row.payload) as ConfluenceSignal;
      // Ensure DB columns are reflected on the object (payload predates some columns)
      (sig as any).id              = row.id;
      (sig as any).strategyVersion = row.strategy_version;
      sig.score                    = row.score;
      sig.direction                = row.direction as 'long' | 'short';
      sig.symbol                   = row.symbol as any;
      sig.ruleId                   = row.rule_id;
      sig.ts                       = row.ts;
    } catch {
      errors++;
      continue;
    }

    // RS hard filter: signal was detected but suppressed by the RS scoring layer.
    // Stored as rs_hard_filtered=1 on the DB row — not in the payload JSON.
    // Must be excluded before classifySignalQuality (quality.ts doesn't see this column).
    if (row.rs_hard_filtered === 1) {
      stmtDelete.run(row.id);
      silenced++;
      continue;
    }

    // ORM/comp_pos filter: meta.filtered=1 means the signal was logged but gated out
    // by the position-filter (comp_pos > threshold, zone proximity, etc.) before broadcast.
    let metaFiltered = false;
    try { metaFiltered = !!JSON.parse(row.meta ?? '{}')?.filtered; } catch { /* ok */ }
    if (metaFiltered) {
      stmtDelete.run(row.id);
      silenced++;
      continue;
    }

    // CF Long time gate (Stage 3 in cf-long-reference.md): 09:54–14:30 ET only.
    // Some pre-gate-era signals have bar timestamps before 09:54 but were processed
    // after 09:54 (strategy-h.ts checks nowMs, not bar ts). Exclude them here
    // because the entry price was before 09:54 — the gate's intent was to avoid
    // that early-session volatility regardless of processing time.
    if (row.rule_id === 'clean-impulse' && row.direction === 'long') {
      if (!isCfLongTimeAllowed(row.ts)) {
        stmtDelete.run(row.id);
        silenced++;
        continue;
      }
    }

    // EXPL 14:30 time gate REMOVED 2026-06-01: original gate was calibrated
    // against a wider stop assumption (old SL). At V3's TP=80/SL=70, the same
    // post-14:30 EXPL LONGs become mildly positive expected value (+8 pt/sig,
    // 54% profitable across n=13). Re-evaluated by scripts/expl_late_day_re_eval.ts.
    // Also: the gate lived only here, not in quality.ts — so live broadcasts
    // already included these signals and the backtest was diverging from live.
    // Removing here aligns backtest with live behavior.

    // Reconstruct context that state.ts had at signal time
    const recentExpls = stmtExpls.all(
      row.symbol, row.ts - EXPL_LOOKBACK_MS, row.ts
    ) as { ts: number; direction: string }[];

    const lastFlipRow = stmtLastFlipAny.get(
      row.symbol, row.ts - FLIP_LOOKBACK_MS, row.ts
    ) as { ts: number; direction: string; entry?: number } | undefined;
    const lastFlip = lastFlipRow ?? null;

    // Note: buildRegimeContext (CVD, sessionHigh, failedExpls) is omitted here
    // because all regime-dependent gates are currently disabled in quality.ts.
    // Re-include when those gates are re-enabled.
    const decision = classifySignalQuality(sig, { recentExpls, lastFlip });

    if (decision.tier === 'gold') {
      const session    = classifySession(row.ts);
      const absEntry   = (sig as any).entry as number | undefined;

      // Find the confirming FLIP row (with DB id) for FK storage
      const flipIdRow = row.rule_id === 'absorption'
        ? (stmtLastFlip.get(
            row.symbol, row.direction,
            row.ts - FLIP_LOOKBACK_MS, row.ts
          ) as { id: number; ts: number; entry?: number } | undefined) ?? null
        : null;

      // Compute delta15 percentile rank for clean-impulse FLIP signals only.
      const isFlip = row.rule_id === 'clean-impulse' &&
                     (sig as any).pattern === 'FLIP';
      const d15raw = isFlip ? (sig as any).delta15 as number | null | undefined : undefined;
      const { pct_rank: d15PctRank, caution: d15Caution } =
        isFlip ? computeDelta15Caution(row.direction, row.ts, d15raw ?? null)
               : { pct_rank: null, caution: 0 };

      stmtUpsert.run(
        row.id,
        row.ts,
        row.symbol,
        row.rule_id,
        row.strategy_version,
        row.direction,
        row.score,
        session,
        GATE_VERSION,
        decision.reason,
        now,
        flipIdRow?.id    ?? null,
        flipIdRow?.ts    ?? null,
        flipIdRow        ? Math.round((row.ts - flipIdRow.ts) / 60_000) : null,
        (flipIdRow?.entry != null && absEntry != null)
          ? Math.abs(absEntry - flipIdRow.entry)
          : null,
        buildContextJson(sig),
        d15PctRank ?? null,
        d15Caution,
      );
      qualified++;
    } else {
      // Remove if previously qualified under an old gate version
      stmtDelete.run(row.id);
      silenced++;
    }
  }
});

run();

const total = db.prepare('SELECT COUNT(*) AS c FROM qualified_signals').get() as { c: number };

console.log('─'.repeat(55));
console.log(`  Total signals evaluated : ${allSignals.length}`);
console.log(`  Qualified (gold)        : ${qualified}`);
console.log(`  Silenced (not stored)   : ${silenced}`);
console.log(`  Parse errors skipped    : ${errors}`);
console.log(`  Rows in qualified_signals: ${total.c}`);
console.log('─'.repeat(55));

// ── Breakdown by rule + direction ────────────────────────────────────────────

const breakdown = db.prepare(`
  SELECT rule_id, strategy_version, direction, session, COUNT(*) AS n
  FROM qualified_signals
  GROUP BY rule_id, strategy_version, direction, session
  ORDER BY rule_id, strategy_version, direction, session
`).all() as { rule_id: string; strategy_version: string; direction: string; session: string; n: number }[];

console.log('\nBreakdown of qualified_signals:\n');
console.log(
  'rule'.padEnd(22) + 'strat'.padEnd(8) + 'dir'.padEnd(8) +
  'session'.padEnd(12) + 'n'
);
console.log('─'.repeat(55));
for (const r of breakdown) {
  console.log(
    r.rule_id.padEnd(22) +
    r.strategy_version.padEnd(8) +
    r.direction.padEnd(8) +
    r.session.padEnd(12) +
    r.n
  );
}

db.close();
