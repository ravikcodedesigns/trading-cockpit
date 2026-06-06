// fade_shadow_pnl.ts — V3 shadow trade performance for wall-broken-fade.
//
// Reads v3_decisions (where V3 logs OPEN/CLOSE actions for fade trades) and
// produces TWO views per closed trade:
//
//   1. THEORETICAL — entry at wall price, exit at TP/SL price exactly.
//      This is what V3 logs natively. Assumes zero slippage.
//
//   2. WORST-CASE SLIPPED (3pt each side) — realistic execution model:
//        - Entry market order slips 3pt UNFAVORABLY (price moved past wall)
//        - TP limit order fills at exact TP price (limit guarantee, no slip)
//        - SL stop-market order slips 3pt past stop (worst-case stop fill)
//        - Opposing-signal exit slips 3pt unfavorably (market order to flatten)
//
//   For LONG fade:
//      entry_slip  = wall + 3   (had to chase higher)
//      tp_filled   = wall + TP  (limit fills at TP)
//      sl_filled   = wall - SL - 3  (stop slips 3pt below SL price)
//   For SHORT fade:
//      entry_slip  = wall - 3   (had to chase lower)
//      tp_filled   = wall - TP
//      sl_filled   = wall + SL + 3
//
//   PnL_slipped = direction × (exit_filled - entry_slip)
//      WIN  (TP):  +TP - 3  = +17 pts (vs theoretical +20)
//      LOSS (SL):  -SL - 6  = -16 pts (vs theoretical -10)
//      Effective R: 17:16 = 1.06:1 instead of 2:1
//
// Stores results in a new `fade_shadow_pnl` table for persistent comparison.
// Re-run idempotent (uses INSERT OR REPLACE).

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');
const db = new Database(TRADING_DB);

// ── CLI flags: --tp=N --sl=N --slip=N --horizon-min=N
//   Defaults match V3's runtime config. With defaults, we derive directly from
//   V3's logged exits (theo_exit_price). With non-default TP/SL, we ignore V3's
//   exit and walk forward in ticks.db from open_ts to simulate a new stop.
const DEFAULTS = { tp: 20, sl: 10, slip: 3, horizonMin: 60 };
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
const tpSlChanged  = TP_PTS !== DEFAULTS.tp || SL_PTS !== DEFAULTS.sl;
const isVariantRun = tpSlChanged || SLIPPAGE_PTS !== DEFAULTS.slip || HORIZON_MIN !== DEFAULTS.horizonMin;
console.log(`Params: TP=${TP_PTS} SL=${SL_PTS} SLIP=${SLIPPAGE_PTS} HORIZON=${HORIZON_MIN}min  ${isVariantRun ? '(VARIANT — writes to fade_pnl_variants)' : '(BASELINE — writes to fade_shadow_pnl)'}`);
if (tpSlChanged) console.log(`  NOTE: TP/SL differ from V3 runtime — walking ticks.db forward from open_ts to simulate new stops`);

// Create the baseline table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS fade_shadow_pnl (
    decision_id        INTEGER PRIMARY KEY,
    open_ts            INTEGER NOT NULL,
    close_ts           INTEGER NOT NULL,
    symbol             TEXT NOT NULL,
    direction          TEXT NOT NULL,
    open_trade_id      INTEGER,
    -- Theoretical (V3 native — zero slippage)
    wall_price         REAL NOT NULL,
    theo_exit_price    REAL NOT NULL,
    theo_pnl_pts       REAL NOT NULL,
    outcome            TEXT NOT NULL,  -- WIN | LOSS | OPP_SIG_EXIT | CLOSE_AT_BELL | OTHER
    -- Worst-case 3pt slippage model
    slip_entry_price   REAL NOT NULL,
    slip_exit_price    REAL NOT NULL,
    slip_pnl_pts       REAL NOT NULL,
    -- Provenance
    computed_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fade_shadow_open_ts ON fade_shadow_pnl(open_ts);
`);

// 2026-06-02: discovered the theoretical/slipped numbers carry look-ahead bias
// — fade signals fire AFTER the wall break + reversal has already happened, so
// wall_price is typically 20-25pts AWAY from real market when V3 logs "open".
// Add realistic_* columns that re-simulate using actual at-open tick price.
// ALTER TABLE doesn't support IF NOT EXISTS in SQLite, so we probe + add.
const existingCols = (db.prepare(`PRAGMA table_info(fade_shadow_pnl)`).all() as Array<{name: string}>).map(r => r.name);
for (const [col, type] of [
  ['realistic_entry_price', 'REAL'],
  ['realistic_exit_price',  'REAL'],
  ['realistic_outcome',     'TEXT'],   // WIN | LOSS | OPEN_AT_HORIZON
  ['realistic_pnl_pts',     'REAL'],
  ['realistic_slip_pnl_pts','REAL'],
  ['wall_gap_pts',          'REAL'],   // wall_price vs at-open mkt price (favorable direction); large gap = strong look-ahead
] as const) {
  if (!existingCols.includes(col)) db.exec(`ALTER TABLE fade_shadow_pnl ADD COLUMN ${col} ${type}`);
}

// Variant table — shared with fade_blocked_pnl.ts; created here too for safety
db.exec(`
  CREATE TABLE IF NOT EXISTS fade_pnl_variants (
    variant_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    source         TEXT NOT NULL,
    decision_id    INTEGER NOT NULL,
    open_ts        INTEGER NOT NULL,
    symbol         TEXT NOT NULL,
    direction      TEXT NOT NULL,
    score          INTEGER,
    wall_price     REAL NOT NULL,
    tp_pts         REAL NOT NULL,
    sl_pts         REAL NOT NULL,
    slippage_pts   REAL NOT NULL,
    horizon_min    INTEGER NOT NULL,
    outcome        TEXT NOT NULL,
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

// Pull all CLOSE rows for wall-broken-fade with the corresponding OPEN
const closes = db.prepare(`
  SELECT
    c.id           as decision_id,
    c.ts           as close_ts,
    c.symbol,
    c.direction,
    c.entry        as wall_price,
    c.exit_price   as theo_exit_price,
    c.exit_outcome as outcome,
    c.pnl_pts      as theo_pnl_pts,
    c.open_trade_id,
    (
      SELECT MAX(o.ts)
      FROM v3_decisions o
      WHERE o.symbol = c.symbol
        AND o.rule_id = 'wall-broken-fade'
        AND o.action = 'OPEN'
        AND o.ts <= c.ts
        AND o.entry = c.entry
    ) as open_ts
  FROM v3_decisions c
  WHERE c.rule_id = 'wall-broken-fade'
    AND c.action  = 'CLOSE'
    AND c.exit_price IS NOT NULL
  ORDER BY c.ts ASC
`).all() as Array<{
  decision_id: number; close_ts: number; symbol: string; direction: string;
  wall_price: number; theo_exit_price: number; outcome: string | null;
  theo_pnl_pts: number; open_trade_id: number | null; open_ts: number | null;
}>;

console.log(`\n══ Fade Shadow PnL — theoretical vs worst-case-slipped (3pt each side) ══`);
console.log(`Found ${closes.length} closed fade shadow trades\n`);

if (closes.length === 0) {
  console.log('No closed fade trades in v3_decisions yet.');
  process.exit(0);
}

const upsertBaseline = db.prepare(`
  INSERT OR REPLACE INTO fade_shadow_pnl
    (decision_id, open_ts, close_ts, symbol, direction, open_trade_id,
     wall_price, theo_exit_price, theo_pnl_pts, outcome,
     slip_entry_price, slip_exit_price, slip_pnl_pts, computed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const upsertVariant = db.prepare(`
  INSERT INTO fade_pnl_variants
    (source, decision_id, open_ts, symbol, direction, wall_price,
     tp_pts, sl_pts, slippage_pts, horizon_min,
     outcome, exit_price, exit_ts, theo_pnl_pts, slip_pnl_pts, computed_at)
  VALUES ('shadow', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source, decision_id, tp_pts, sl_pts, slippage_pts, horizon_min)
  DO UPDATE SET outcome=excluded.outcome, exit_price=excluded.exit_price,
                exit_ts=excluded.exit_ts, theo_pnl_pts=excluded.theo_pnl_pts,
                slip_pnl_pts=excluded.slip_pnl_pts, computed_at=excluded.computed_at
`);

// Tape walk-forward for variant TP/SL — opens ticks.db lazily.
// Also used by the REALISTIC re-simulation (always runs in baseline mode now).
let tkDb: Database.Database | null = null;
let tradesStmt: Database.Statement | null = null;
let atOpenStmt: Database.Statement | null = null;
function ensureTicks() {
  if (!tkDb) {
    tkDb = new Database(TICKS_DB, { readonly: true });
    tradesStmt = tkDb.prepare(`
      SELECT ts, price FROM trades WHERE symbol = ? AND ts > ? AND ts <= ? ORDER BY ts ASC
    `);
    atOpenStmt = tkDb.prepare(`
      SELECT price FROM trades WHERE symbol = ? AND ABS(ts - ?) < 200
      ORDER BY ABS(ts - ?) ASC LIMIT 1
    `);
  }
}
function priceAtOpen(symbol: string, ts: number): number | null {
  ensureTicks();
  const row = atOpenStmt!.get(symbol, ts, ts) as { price: number } | undefined;
  return row?.price ?? null;
}
function walkFromPrice(symbol: string, openTs: number, entry: number, dir: 1 | -1, tpPts: number, slPts: number): {
  outcome: 'WIN' | 'LOSS' | 'OPEN_AT_HORIZON';
  exitPrice: number | null;
} {
  ensureTicks();
  const tp = entry + dir * tpPts;
  const sl = entry - dir * slPts;
  const ticks = tradesStmt!.all(symbol, openTs, openTs + HORIZON_MS) as Array<{ts:number;price:number}>;
  for (const t of ticks) {
    const hitTP = dir === 1 ? t.price >= tp : t.price <= tp;
    const hitSL = dir === 1 ? t.price <= sl : t.price >= sl;
    if (hitTP) return { outcome: 'WIN',  exitPrice: t.price };
    if (hitSL) return { outcome: 'LOSS', exitPrice: t.price };
  }
  return { outcome: 'OPEN_AT_HORIZON', exitPrice: null };
}
function walkForward(symbol: string, openTs: number, wallPrice: number, dir: 1 | -1): {
  outcome: 'WIN' | 'LOSS' | 'OPEN_AT_HORIZON';
  exitPrice: number | null;
  exitTs: number | null;
} {
  ensureTicks();
  const tpPrice = wallPrice + dir * TP_PTS;
  const slPrice = wallPrice - dir * SL_PTS;
  const trades = tradesStmt!.all(symbol, openTs, openTs + HORIZON_MS) as Array<{ts:number;price:number}>;
  for (const t of trades) {
    const hitTP = dir === 1 ? t.price >= tpPrice : t.price <= tpPrice;
    const hitSL = dir === 1 ? t.price <= slPrice : t.price >= slPrice;
    if (hitTP) return { outcome: 'WIN',  exitPrice: t.price, exitTs: t.ts };
    if (hitSL) return { outcome: 'LOSS', exitPrice: t.price, exitTs: t.ts };
  }
  return { outcome: 'OPEN_AT_HORIZON', exitPrice: null, exitTs: null };
}

let theoNet = 0, slipNet = 0;
let realisticNet = 0, realisticSlipNet = 0;
let wins = 0, losses = 0, oppExits = 0, other = 0;
let realWins = 0, realLosses = 0, realOpen = 0;
const rows: any[] = [];
const updRealistic = db.prepare(`
  UPDATE fade_shadow_pnl
  SET realistic_entry_price=?, realistic_exit_price=?, realistic_outcome=?,
      realistic_pnl_pts=?, realistic_slip_pnl_pts=?, wall_gap_pts=?
  WHERE decision_id=?
`);

for (const c of closes) {
  const dir = (c.direction === 'long' ? 1 : -1) as 1 | -1;
  const slipEntry = c.wall_price + dir * SLIPPAGE_PTS;

  // Resolve outcome + theo_exit + theo_pnl for the requested params
  let outcome: string;
  let theoExitPrice: number;
  let theoPnl: number;
  let exitTs: number | null = c.close_ts;

  if (tpSlChanged) {
    // V3's logged exit doesn't apply — walk the tape with new TP/SL
    if (c.open_ts == null) continue;  // no matching OPEN row
    const w = walkForward(c.symbol, c.open_ts, c.wall_price, dir);
    outcome = w.outcome;
    if (outcome === 'WIN')      { theoExitPrice = c.wall_price + dir * TP_PTS;  theoPnl =  TP_PTS; }
    else if (outcome === 'LOSS'){ theoExitPrice = c.wall_price - dir * SL_PTS;  theoPnl = -SL_PTS; }
    else                        { theoExitPrice = w.exitPrice ?? c.wall_price;  theoPnl = 0;        }
    exitTs = w.exitTs;
  } else {
    // Defaults — derive from V3's logged exit
    outcome = c.outcome ?? 'OTHER';
    theoExitPrice = c.theo_exit_price;
    theoPnl = c.theo_pnl_pts;
  }

  // Slipped exit model
  let slipExit: number;
  if (outcome === 'WIN') {
    slipExit = theoExitPrice;                                    // limit guarantee
    wins++;
  } else if (outcome === 'LOSS') {
    slipExit = theoExitPrice + (-dir) * SLIPPAGE_PTS;            // 3pt past stop
    losses++;
  } else if (outcome === 'OPP_SIG_EXIT' || outcome === 'CLOSE_AT_BELL') {
    slipExit = theoExitPrice + (-dir) * SLIPPAGE_PTS;
    if (outcome === 'OPP_SIG_EXIT') oppExits++; else other++;
  } else {
    slipExit = theoExitPrice + (-dir) * SLIPPAGE_PTS;
    other++;
  }
  const slipPnl = dir * (slipExit - slipEntry);

  if (isVariantRun) {
    upsertVariant.run(
      c.decision_id, c.open_ts ?? c.close_ts, c.symbol, c.direction, c.wall_price,
      TP_PTS, SL_PTS, SLIPPAGE_PTS, HORIZON_MIN,
      outcome, theoExitPrice, exitTs, theoPnl, slipPnl, Date.now(),
    );
  } else {
    upsertBaseline.run(
      c.decision_id, c.open_ts ?? c.close_ts, c.close_ts, c.symbol, c.direction, c.open_trade_id,
      c.wall_price, theoExitPrice, theoPnl, outcome,
      slipEntry, slipExit, slipPnl, Date.now(),
    );
  }

  theoNet += theoPnl;
  slipNet += slipPnl;

  const rowObj: any = { c, slipEntry, slipExit, slipPnl, theoExitPrice, theoPnl, outcome };

  // ── REALISTIC re-simulation (look-ahead-free) ───────────────────────────
  // Uses the actual NQ tick price at open_ts as the entry, walks forward with
  // TP=TP_PTS / SL=SL_PTS. This is the executable view — what a real trader
  // receiving the signal in real time would book. Only meaningful in BASELINE
  // mode (TP/SL unchanged from V3 runtime).
  if (!tpSlChanged && c.open_ts != null) {
    const mkt = priceAtOpen(c.symbol, c.open_ts);
    if (mkt != null) {
      const w = walkFromPrice(c.symbol, c.open_ts, mkt, dir, TP_PTS, SL_PTS);
      let realPnl = 0;
      let realExit: number = mkt;
      if (w.outcome === 'WIN')  { realPnl = TP_PTS;  realExit = mkt + dir * TP_PTS;  realWins++;   }
      if (w.outcome === 'LOSS') { realPnl = -SL_PTS; realExit = mkt - dir * SL_PTS;  realLosses++; }
      if (w.outcome === 'OPEN_AT_HORIZON') { realPnl = 0; realExit = w.exitPrice ?? mkt; realOpen++; }
      const realSlipEntry = mkt + dir * SLIPPAGE_PTS;
      let realSlipExit = realExit;
      if (w.outcome === 'LOSS') realSlipExit = (mkt - dir * SL_PTS) + (-dir) * SLIPPAGE_PTS;
      if (w.outcome === 'OPEN_AT_HORIZON') realSlipExit = (w.exitPrice ?? mkt) + (-dir) * SLIPPAGE_PTS;
      const realSlipPnl = dir * (realSlipExit - realSlipEntry);
      realisticNet += realPnl;
      realisticSlipNet += realSlipPnl;
      const wallGap = dir * (c.wall_price - mkt);  // positive = wall favorable for this direction
      updRealistic.run(mkt, realExit, w.outcome, realPnl, realSlipPnl, wallGap, c.decision_id);
      rowObj.realMkt = mkt;
      rowObj.realOutcome = w.outcome;
      rowObj.realPnl = realPnl;
      rowObj.realSlipPnl = realSlipPnl;
      rowObj.wallGap = wallGap;
    }
  }

  rows.push(rowObj);
}

const closed = wins + losses;
const wr = closed > 0 ? wins / closed * 100 : 0;
const realClosed = realWins + realLosses;
const realWr = realClosed > 0 ? realWins / realClosed * 100 : 0;

console.log(`\n══ THREE-VIEW COMPARISON ══`);
console.log(`  view                           W    L  OPEN/OPP   WR      pts`);
console.log(`  THEO (wall-price, no slip)    ${String(wins).padStart(3)}  ${String(losses).padStart(3)}     ${String(oppExits + other).padStart(3)}   ${wr.toFixed(1).padStart(5)}%  ${(theoNet >= 0 ? '+' : '') + theoNet.toFixed(1).padStart(6)}`);
console.log(`  THEO + 3pt slip               ${String(wins).padStart(3)}  ${String(losses).padStart(3)}     ${String(oppExits + other).padStart(3)}   ${wr.toFixed(1).padStart(5)}%  ${(slipNet >= 0 ? '+' : '') + slipNet.toFixed(1).padStart(6)}`);
console.log(`  REALISTIC (mkt @ signal-ts)   ${String(realWins).padStart(3)}  ${String(realLosses).padStart(3)}     ${String(realOpen).padStart(3)}   ${realWr.toFixed(1).padStart(5)}%  ${(realisticNet >= 0 ? '+' : '') + realisticNet.toFixed(1).padStart(6)}`);
console.log(`  REALISTIC + 3pt slip          ${String(realWins).padStart(3)}  ${String(realLosses).padStart(3)}     ${String(realOpen).padStart(3)}   ${realWr.toFixed(1).padStart(5)}%  ${(realisticSlipNet >= 0 ? '+' : '') + realisticSlipNet.toFixed(1).padStart(6)}`);
console.log(`\n  ⚠ THEO views carry LOOK-AHEAD BIAS: wall_price is typically 20-25pts away from real market`);
console.log(`     at signal-emission time, so the move was already booked before V3 'opened'. The REALISTIC`);
console.log(`     view is what an executing trader would actually capture.\n`);

console.log(`── Summary (theoretical) ──`);
console.log(`  Total closes:          ${closes.length}`);
console.log(`  WIN (TP hit):          ${wins}`);
console.log(`  LOSS (SL hit):         ${losses}`);
console.log(`  OPP_SIG_EXIT (V3 close on opposing): ${oppExits}`);
console.log(`  CLOSE_AT_BELL / other: ${other}`);
console.log(`  WR (W/W+L):            ${wr.toFixed(1)}%`);
console.log(`\n  Theoretical PnL (zero slip):     ${theoNet > 0 ? '+' : ''}${theoNet.toFixed(1)} pts`);
console.log(`  Worst-case slipped PnL (3pt):    ${slipNet > 0 ? '+' : ''}${slipNet.toFixed(1)} pts`);
console.log(`  Slippage drag:                   ${(theoNet - slipNet).toFixed(1)} pts (= ${slipNet > 0 ? '-' : '+'}${Math.abs((theoNet - slipNet) / Math.max(1, Math.abs(theoNet)) * 100).toFixed(1)}% of theoretical)`);
console.log(`\n  At MNQ ($2/pt):  theoretical $${(theoNet * 2).toFixed(0)}  |  slipped $${(slipNet * 2).toFixed(0)}`);
console.log(`  At NQ  ($20/pt): theoretical $${(theoNet * 20).toFixed(0)}  |  slipped $${(slipNet * 20).toFixed(0)}`);

// Show last 20 trades
console.log(`\n── Most recent 20 closes ──`);
console.log(`  time(ET)  dir   wall    exit       outcome     theo_pnl  slip_entry  slip_exit  slip_pnl`);
const last20 = rows.slice(-20);
for (const r of last20) {
  const et = new Date(r.c.close_ts - 4*60*60_000).toISOString().substring(11, 19);
  const dir = r.c.direction === 'long' ? 'L' : 'S';
  const oc = (r.outcome ?? '—').padEnd(13);
  console.log(
    `  ${et}    ${dir}   ${r.c.wall_price.toFixed(2).padStart(8)}  ${r.theoExitPrice.toFixed(2).padStart(9)}  ${oc} ${(r.theoPnl > 0 ? '+' : '') + r.theoPnl.toFixed(1).padStart(6)}    ${r.slipEntry.toFixed(2).padStart(8)}   ${r.slipExit.toFixed(2).padStart(8)}   ${(r.slipPnl > 0 ? '+' : '') + r.slipPnl.toFixed(1).padStart(6)}`
  );
}

const targetTable = isVariantRun ? 'fade_pnl_variants' : 'fade_shadow_pnl';
console.log(`\n  → Data persisted to ${targetTable} (${closes.length} rows, params TP=${TP_PTS} SL=${SL_PTS} SLIP=${SLIPPAGE_PTS})`);
db.close();
if (tkDb) tkDb.close();
