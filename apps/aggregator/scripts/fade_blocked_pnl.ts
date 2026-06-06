// fade_blocked_pnl.ts — Track outcomes for fade signals V3 blocked via CVD gate.
//
// Purpose: if these blocked trades have HIGHER WR/PnL than the ones V3 actually
// opened, the CVD floor of ±3000 is too strict for wall-broken-fade and we need
// to recalibrate.
//
// Method:
//   1. Find all v3_decisions where rule_id='wall-broken-fade' AND action='SKIP_CVD'
//   2. For each, get the corresponding signal (wall price, direction, score)
//   3. Walk forward in ticks.db simulating the same TP=20/SL=10 logic
//   4. Store the simulated outcome in fade_blocked_outcomes table
//
// Same dual-tracking as fade_shadow_pnl: theoretical and worst-case-slipped.
//
// Run after RTH close OR on-demand.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const trDb = new Database(TRADING_DB);
const tkDb = new Database(TICKS_DB, { readonly: true });

// ── CLI flags: --tp=N --sl=N --slip=N --horizon-min=N
const DEFAULTS = { tp: 20, sl: 10, slip: 3, horizonMin: 15 };
function getArg(name: string, dflt: number): number {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!m) return dflt;
  const v = parseFloat(m.split('=')[1]);
  if (!isFinite(v)) throw new Error(`Bad value for --${name}: ${m}`);
  return v;
}
const TP_PTS       = getArg('tp',          DEFAULTS.tp);
const SL_PTS       = getArg('sl',          DEFAULTS.sl);
const SLIPPAGE_PTS = getArg('slip',        DEFAULTS.slip);
const HORIZON_MIN  = getArg('horizon-min', DEFAULTS.horizonMin);
const HORIZON_MS   = HORIZON_MIN * 60_000;
const isVariantRun = TP_PTS !== DEFAULTS.tp || SL_PTS !== DEFAULTS.sl || SLIPPAGE_PTS !== DEFAULTS.slip || HORIZON_MIN !== DEFAULTS.horizonMin;
console.log(`Params: TP=${TP_PTS} SL=${SL_PTS} SLIP=${SLIPPAGE_PTS} HORIZON=${HORIZON_MIN}min  ${isVariantRun ? '(VARIANT — writes to fade_pnl_variants)' : '(BASELINE — writes to fade_blocked_outcomes)'}`);

// Create the baseline table if it doesn't exist
trDb.exec(`
  CREATE TABLE IF NOT EXISTS fade_blocked_outcomes (
    decision_id        INTEGER PRIMARY KEY,
    signal_id          INTEGER NOT NULL,
    open_ts            INTEGER NOT NULL,
    symbol             TEXT NOT NULL,
    direction          TEXT NOT NULL,
    score              INTEGER NOT NULL,
    wall_price         REAL NOT NULL,
    cvd_at_block       REAL,         -- CVD value when V3 blocked
    -- Simulated outcome
    outcome            TEXT NOT NULL,  -- WIN | LOSS | OPEN_AT_HORIZON
    exit_price         REAL,
    exit_ts            INTEGER,
    max_gain_pts       REAL,
    max_dd_pts         REAL,
    theo_pnl_pts       REAL NOT NULL,
    slip_pnl_pts       REAL NOT NULL,
    computed_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fade_blocked_open_ts ON fade_blocked_outcomes(open_ts);
  CREATE INDEX IF NOT EXISTS idx_fade_blocked_score ON fade_blocked_outcomes(score);
`);

// Variant table — holds same decision under different TP/SL/slip combos
trDb.exec(`
  CREATE TABLE IF NOT EXISTS fade_pnl_variants (
    variant_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    source         TEXT NOT NULL,           -- 'blocked' | 'shadow'
    decision_id    INTEGER NOT NULL,
    open_ts        INTEGER NOT NULL,
    symbol         TEXT NOT NULL,
    direction      TEXT NOT NULL,
    score          INTEGER,
    wall_price     REAL NOT NULL,
    -- Parameters this row was simulated under
    tp_pts         REAL NOT NULL,
    sl_pts         REAL NOT NULL,
    slippage_pts   REAL NOT NULL,
    horizon_min    INTEGER NOT NULL,
    -- Outcome
    outcome        TEXT NOT NULL,           -- WIN | LOSS | OPEN_AT_HORIZON
    exit_price     REAL,
    exit_ts        INTEGER,
    theo_pnl_pts   REAL NOT NULL,
    slip_pnl_pts   REAL NOT NULL,
    computed_at    INTEGER NOT NULL,
    UNIQUE(source, decision_id, tp_pts, sl_pts, slippage_pts, horizon_min)
  );
  CREATE INDEX IF NOT EXISTS idx_fade_variants_decision ON fade_pnl_variants(source, decision_id);
  CREATE INDEX IF NOT EXISTS idx_fade_variants_params   ON fade_pnl_variants(tp_pts, sl_pts, slippage_pts);
`);

// Pull all SKIP_CVD wall-broken-fade decisions joined with signal details
const blocked = trDb.prepare(`
  SELECT
    v.id           as decision_id,
    v.ts           as open_ts,
    v.signal_id,
    v.symbol,
    v.direction,
    v.cvd_session,
    s.score,
    json_extract(s.payload,'$.entry')    as wall_price,
    json_extract(s.payload,'$.peakSize') as peak_size
  FROM v3_decisions v
  JOIN signals s ON s.id = v.signal_id
  WHERE v.rule_id = 'wall-broken-fade'
    AND v.action  = 'SKIP_CVD'
  ORDER BY v.ts ASC
`).all() as Array<{
  decision_id: number; open_ts: number; signal_id: number;
  symbol: string; direction: string; cvd_session: number;
  score: number; wall_price: number; peak_size: number;
}>;

console.log(`\n══ Fade Blocked-by-CVD Outcomes ══`);
console.log(`Found ${blocked.length} CVD-blocked fade signals to simulate\n`);

if (blocked.length === 0) {
  console.log('No CVD-blocked fade signals yet.');
  process.exit(0);
}

const tradesStmt = tkDb.prepare(`
  SELECT ts, price FROM trades WHERE symbol = ? AND ts > ? AND ts <= ? ORDER BY ts ASC
`);
const upsertBaseline = trDb.prepare(`
  INSERT OR REPLACE INTO fade_blocked_outcomes
    (decision_id, signal_id, open_ts, symbol, direction, score,
     wall_price, cvd_at_block, outcome, exit_price, exit_ts,
     max_gain_pts, max_dd_pts, theo_pnl_pts, slip_pnl_pts, computed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const upsertVariant = trDb.prepare(`
  INSERT INTO fade_pnl_variants
    (source, decision_id, open_ts, symbol, direction, score,
     wall_price, tp_pts, sl_pts, slippage_pts, horizon_min,
     outcome, exit_price, exit_ts, theo_pnl_pts, slip_pnl_pts, computed_at)
  VALUES ('blocked', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source, decision_id, tp_pts, sl_pts, slippage_pts, horizon_min)
  DO UPDATE SET outcome=excluded.outcome, exit_price=excluded.exit_price,
                exit_ts=excluded.exit_ts, theo_pnl_pts=excluded.theo_pnl_pts,
                slip_pnl_pts=excluded.slip_pnl_pts, computed_at=excluded.computed_at
`);

let totalWins = 0, totalLosses = 0, totalOpen = 0;
let theoNet = 0, slipNet = 0;
const byScoreBand: Record<string, {n:number; w:number; l:number; theo:number; slip:number}> = {};

for (const b of blocked) {
  if (!b.wall_price || b.wall_price <= 0) continue;
  const dir = b.direction === 'long' ? 1 : -1;
  const entry = b.wall_price;
  const tpPrice = entry + dir * TP_PTS;
  const slPrice = entry - dir * SL_PTS;
  const horizonTs = b.open_ts + HORIZON_MS;
  const trades = tradesStmt.all(b.symbol, b.open_ts, horizonTs) as Array<{ts:number;price:number}>;

  let outcome: 'WIN' | 'LOSS' | 'OPEN_AT_HORIZON' = 'OPEN_AT_HORIZON';
  let exitPrice: number | null = null;
  let exitTs: number | null = null;
  let maxGain = 0, maxDd = 0;
  for (const t of trades) {
    const move = dir * (t.price - entry);
    if (move > maxGain) maxGain = move;
    if (move < maxDd) maxDd = move;
    const hitTP = dir === 1 ? t.price >= tpPrice : t.price <= tpPrice;
    const hitSL = dir === 1 ? t.price <= slPrice : t.price >= slPrice;
    if (hitTP) { outcome = 'WIN'; exitPrice = t.price; exitTs = t.ts; break; }
    if (hitSL) { outcome = 'LOSS'; exitPrice = t.price; exitTs = t.ts; break; }
  }

  // Theoretical PnL
  let theoPnl = 0;
  if (outcome === 'WIN')  theoPnl = TP_PTS;
  if (outcome === 'LOSS') theoPnl = -SL_PTS;

  // Slipped PnL — entry +3 unfavorable, exit: SL +3 unfav (TP exact)
  const slipEntry = entry + dir * SLIPPAGE_PTS;
  let slipPnl = 0;
  if (outcome === 'WIN')  slipPnl = dir * (tpPrice - slipEntry);                          // TP at limit
  if (outcome === 'LOSS') slipPnl = dir * ((slPrice + (-dir)*SLIPPAGE_PTS) - slipEntry);  // SL slipped

  if (isVariantRun) {
    upsertVariant.run(
      b.decision_id, b.open_ts, b.symbol, b.direction, b.score,
      entry, TP_PTS, SL_PTS, SLIPPAGE_PTS, HORIZON_MIN,
      outcome, exitPrice, exitTs, theoPnl, slipPnl, Date.now(),
    );
  } else {
    upsertBaseline.run(
      b.decision_id, b.signal_id, b.open_ts, b.symbol, b.direction, b.score,
      entry, b.cvd_session ?? null,
      outcome, exitPrice, exitTs,
      maxGain, maxDd,
      theoPnl, slipPnl,
      Date.now(),
    );
  }

  if (outcome === 'WIN')  { totalWins++; theoNet += theoPnl; slipNet += slipPnl; }
  if (outcome === 'LOSS') { totalLosses++; theoNet += theoPnl; slipNet += slipPnl; }
  if (outcome === 'OPEN_AT_HORIZON') totalOpen++;

  const band = b.score >= 90 ? '90+' : b.score >= 80 ? '80-89' : '70-79';
  if (!byScoreBand[band]) byScoreBand[band] = { n: 0, w: 0, l: 0, theo: 0, slip: 0 };
  byScoreBand[band].n++;
  if (outcome === 'WIN')  byScoreBand[band].w++;
  if (outcome === 'LOSS') byScoreBand[band].l++;
  byScoreBand[band].theo += theoPnl;
  byScoreBand[band].slip += slipPnl;
}

const closed = totalWins + totalLosses;
const wr = closed > 0 ? totalWins/closed*100 : 0;

console.log(`── If V3 had NOT blocked these fades, simulated outcomes (TP=20/SL=10): ──`);
console.log(`  Total signals:         ${blocked.length}`);
console.log(`  WIN:                   ${totalWins}`);
console.log(`  LOSS:                  ${totalLosses}`);
console.log(`  OPEN at 15min horizon: ${totalOpen}`);
console.log(`  WR (W/W+L):            ${wr.toFixed(1)}%`);
console.log(`  Theoretical PnL:       ${theoNet > 0 ? '+' : ''}${theoNet.toFixed(0)} pts`);
console.log(`  Slipped PnL (3pt):     ${slipNet > 0 ? '+' : ''}${slipNet.toFixed(0)} pts`);
console.log(``);
console.log(`── By score band ──`);
console.log(`  band     n   W   L   WR     theo_pnl   slip_pnl`);
for (const band of ['70-79','80-89','90+']) {
  const b = byScoreBand[band];
  if (!b) continue;
  const c = b.w + b.l;
  const w = c > 0 ? (b.w/c*100).toFixed(1) : '—';
  console.log(`  ${band.padEnd(7)} ${String(b.n).padStart(3)} ${String(b.w).padStart(3)} ${String(b.l).padStart(3)}  ${(w+'%').padStart(6)}  ${(b.theo>0?'+':'')+b.theo.toFixed(0).padStart(7)}   ${(b.slip>0?'+':'')+b.slip.toFixed(0).padStart(7)}`);
}

// Comparison vs fade_shadow_pnl (actual V3-traded fades)
console.log(``);
console.log(`── Comparison to V3-traded fades (from fade_shadow_pnl table) ──`);
const tradedRow = trDb.prepare(`
  SELECT COUNT(*) as n,
    SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses,
    SUM(theo_pnl_pts) as theo,
    SUM(slip_pnl_pts) as slip
  FROM fade_shadow_pnl
`).get() as { n: number; wins: number; losses: number; theo: number; slip: number };

const tradedClosed = (tradedRow.wins ?? 0) + (tradedRow.losses ?? 0);
const tradedWR = tradedClosed > 0 ? tradedRow.wins/tradedClosed*100 : 0;
console.log(`  V3 actually OPENED:    ${tradedRow.n} | W=${tradedRow.wins} L=${tradedRow.losses} | WR=${tradedWR.toFixed(1)}% | theo=${(tradedRow.theo ?? 0).toFixed(0)} slip=${(tradedRow.slip ?? 0).toFixed(0)}`);
console.log(`  V3 CVD-BLOCKED:        ${blocked.length} | W=${totalWins} L=${totalLosses} | WR=${wr.toFixed(1)}% | theo=${theoNet.toFixed(0)} slip=${slipNet.toFixed(0)}`);
console.log(``);
console.log(`  → Verdict: ${wr > tradedWR + 5 ? 'CVD floor may be TOO STRICT (blocked fades performed BETTER than traded)' : wr < tradedWR - 5 ? 'CVD floor is HELPING (blocked fades performed WORSE — gate validated)' : 'inconclusive (similar performance)'}`);

trDb.close(); tkDb.close();
