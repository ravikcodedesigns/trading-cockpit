// research_wr_lift.ts — comprehensive single-pass WR-lift research over the
// 114 simulated Variant A trades. For each candidate entry-gate dimension,
// reports the "if this gate were required" subset: n / W / L / WR / total $ /
// EV/trade, plus delta vs baseline (all 114).
//
// Filter discipline (per user 2026-06-09):
//   - A gate must lift WR by ≥ 5pp to earn its sample reduction.
//   - Don't recommend gates that reduce sample below ~50 (≈ 1.5/day).
//   - Each candidate reported INDEPENDENTLY; cross-gate layering comes next.
//
// Sections:
//   A. SCORE — score, direction, score×direction, rule×direction
//   B. CONFLUENCE — same/opp direction other signals within ±5 min
//   C. PER-RULE CONFLUENCE — which other rule type is accretive
//   D. DELTA GATES — delta15 / delta5 (already on FLIP-long; what about short?)
//   E. PRE-ENTRY MICROSTRUCTURE — aggressor delta in last 30s before entry
//   F. STACKED-PRINT CLUSTERS — distinct prints at entry ±2 ticks in last 60s
//   G. CONFIRMATION BAR — 1 min after entry, direction-confirmed?
//   H. ADAPTIVE TP/SL — bucket trades by entry-bar ATR (vol regime)
//
// Source: tradable_signals where sim_pnl_pts IS NOT NULL.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb   = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const DOLLAR_PER_PT = 2;
const MIN_BUCKET_N = 10;
const TICK_SIZE = 0.25;       // NQ
const ALL_RULE_IDS = ['absorption','trap','large-print','tape-speed','reject-resistance','wall-broken-fade','expl','ala-reclaim','rs-touch','swing-pivot'];

// ── Load the 114 simulated trades ───────────────────────────────────────────
interface SimRow {
  signal_id: number;
  ts: number;
  symbol: string;
  rule_id: string;
  direction: 'long' | 'short';
  score: number;
  entry: number;
  pnl_pts: number;
  payload: string;
  ctx_mhp_res: number | null;
  ctx_is_rational: number | null;
}
const trades = tradingDb.prepare(`
  SELECT
    t.signal_id, t.signal_ts AS ts, t.symbol, t.rule_id, t.direction,
    t.score, t.entry, t.sim_pnl_pts AS pnl_pts,
    s.payload, s.ctx_mhp_res, s.ctx_is_rational
  FROM tradable_signals t
  JOIN signals s ON s.id = t.signal_id
  WHERE t.sim_pnl_pts IS NOT NULL
  ORDER BY t.signal_ts ASC
`).all() as SimRow[];

console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(`══ WR-lift research over ${trades.length} simulated Variant A trades ══`);
console.log(`══════════════════════════════════════════════════════════════════════`);

// ── Helpers ─────────────────────────────────────────────────────────────────
interface Stats { n: number; w: number; l: number; pnlPts: number; pnlUsd: number; wr: number; ev: number; }
const statsOf = (rows: SimRow[]): Stats => {
  const n = rows.length;
  const w = rows.filter(r => r.pnl_pts > 0).length;
  const l = rows.filter(r => r.pnl_pts < 0).length;
  const pnlPts = rows.reduce((s, r) => s + r.pnl_pts, 0);
  const pnlUsd = pnlPts * DOLLAR_PER_PT;
  const wr = (w + l) ? (w / (w + l)) * 100 : 0;
  const ev = n ? pnlUsd / n : 0;
  return { n, w, l, pnlPts, pnlUsd, wr, ev };
};
const pad = (s: string, n: number, right = false): string => right ? s.padStart(n) : s.padEnd(n);
const fmt = (label: string, s: Stats, base?: Stats): string => {
  const wrDelta = base ? s.wr - base.wr : 0;
  const evDelta = base ? s.ev - base.ev : 0;
  const wrStr = `${s.wr.toFixed(1)}%${base ? ` (${wrDelta >= 0 ? '+' : ''}${wrDelta.toFixed(1)}pp)` : ''}`;
  const evStr = `$${s.ev.toFixed(1)}${base ? ` (${evDelta >= 0 ? '+' : ''}$${evDelta.toFixed(1)})` : ''}`;
  const pnlStr = `${s.pnlUsd >= 0 ? '+$' : '-$'}${Math.abs(s.pnlUsd).toFixed(0)}`;
  return `${pad(label, 40)} n=${pad(String(s.n), 3, true)} W=${pad(String(s.w), 3, true)} L=${pad(String(s.l), 3, true)} WR=${pad(wrStr, 19)} PnL=${pad(pnlStr, 9, true)} EV=${pad(evStr, 18)}`;
};
const baseline = statsOf(trades);
console.log(`\n── BASELINE (all trades) ──`);
console.log(fmt('all trades', baseline));

// Extract delta15/delta5 from each signal's payload
const decorated = trades.map(t => {
  let delta15: number | null = null, delta5: number | null = null;
  try {
    const p = JSON.parse(t.payload);
    delta15 = p.delta15 ?? null;
    delta5  = p.delta5  ?? null;
  } catch { /* ignore */ }
  return { ...t, delta15, delta5 };
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION A: SCORE / DIRECTION
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n────────── A. SCORE / DIRECTION ──────────`);
console.log(`\n  A1. SCORE bucket`);
const scoreBands: [string, (s: number) => boolean][] = [
  ['score = 100',  s => s === 100],
  ['score 90-99',  s => s >= 90 && s < 100],
  ['score 80-89',  s => s >= 80 && s < 90],
];
for (const [label, fn] of scoreBands) {
  const sub = trades.filter(t => fn(t.score));
  if (sub.length >= MIN_BUCKET_N) console.log('  ' + fmt(label, statsOf(sub), baseline));
}

console.log(`\n  A2. DIRECTION split`);
for (const dir of ['long', 'short'] as const) {
  const sub = trades.filter(t => t.direction === dir);
  if (sub.length >= MIN_BUCKET_N) console.log('  ' + fmt(`direction=${dir}`, statsOf(sub), baseline));
}

console.log(`\n  A3. RULE × DIRECTION`);
for (const rule of ['clean-impulse', 'cont-reentry']) {
  for (const dir of ['long', 'short'] as const) {
    const sub = trades.filter(t => t.rule_id === rule && t.direction === dir);
    if (sub.length >= MIN_BUCKET_N) console.log('  ' + fmt(`${rule} ${dir}`, statsOf(sub), baseline));
  }
}

console.log(`\n  A4. SCORE × DIRECTION`);
for (const dir of ['long', 'short'] as const) {
  for (const [scoreLabel, scoreFn] of scoreBands) {
    const sub = trades.filter(t => t.direction === dir && scoreFn(t.score));
    if (sub.length >= MIN_BUCKET_N) console.log('  ' + fmt(`${dir} ${scoreLabel}`, statsOf(sub), baseline));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION B: CONFLUENCE — same/opp direction other signals
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n────────── B. CONFLUENCE (other rules ±5 min) ──────────`);
const stmtNearbyByDir = tradingDb.prepare(`
  SELECT COUNT(DISTINCT rule_id) AS c
  FROM signals
  WHERE symbol = ?
    AND direction = ?
    AND rule_id NOT IN ('clean-impulse','cont-reentry')
    AND ABS(ts - ?) <= 5 * 60 * 1000
    AND id != ?
`);

console.log(`\n  B1. SAME-DIR confluence count ≥ N`);
const confluenceSameDir = trades.map(t => ({
  trade: t,
  c: (stmtNearbyByDir.get(t.symbol, t.direction, t.ts, t.signal_id) as { c: number }).c,
}));
for (const minC of [1, 2, 3]) {
  const sub = confluenceSameDir.filter(x => x.c >= minC).map(x => x.trade);
  if (sub.length >= MIN_BUCKET_N) console.log('  ' + fmt(`same-dir confluence ≥${minC} rules`, statsOf(sub), baseline));
}

console.log(`\n  B2. OPP-DIR anti-confluence count ≤ N`);
const stmtNearbyOppDir = tradingDb.prepare(`
  SELECT COUNT(DISTINCT rule_id) AS c
  FROM signals
  WHERE symbol = ?
    AND direction != ?
    AND rule_id NOT IN ('clean-impulse','cont-reentry')
    AND ABS(ts - ?) <= 5 * 60 * 1000
    AND id != ?
`);
const antiConfOppDir = trades.map(t => ({
  trade: t,
  c: (stmtNearbyOppDir.get(t.symbol, t.direction, t.ts, t.signal_id) as { c: number }).c,
}));
for (const maxC of [0, 1, 2]) {
  const sub = antiConfOppDir.filter(x => x.c <= maxC).map(x => x.trade);
  if (sub.length >= MIN_BUCKET_N) console.log('  ' + fmt(`opp-dir anti-confluence ≤${maxC} rules`, statsOf(sub), baseline));
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION C: PER-RULE CONFLUENCE — which other rule is most accretive?
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n────────── C. PER-RULE CONFLUENCE (which other rule lifts/hurts WR) ──────────`);
const stmtHasSameDirRule = tradingDb.prepare(`
  SELECT COUNT(*) AS c FROM signals
  WHERE symbol = ? AND direction = ? AND rule_id = ?
    AND ABS(ts - ?) <= 5 * 60 * 1000 AND id != ?
`);
for (const other of ALL_RULE_IDS) {
  const withRule = trades.filter(t => (stmtHasSameDirRule.get(t.symbol, t.direction, other, t.ts, t.signal_id) as { c: number }).c > 0);
  if (withRule.length < MIN_BUCKET_N) continue;
  const without = trades.filter(t => (stmtHasSameDirRule.get(t.symbol, t.direction, other, t.ts, t.signal_id) as { c: number }).c === 0);
  const sw = statsOf(withRule), swo = statsOf(without);
  const wrDelta = sw.wr - swo.wr;
  if (Math.abs(wrDelta) < 3) continue;
  console.log(`  with ${pad(other, 18)} n=${pad(String(sw.n),3,true)} WR=${sw.wr.toFixed(1)}% EV=$${sw.ev.toFixed(1)}  │ without n=${swo.n} WR=${swo.wr.toFixed(1)}% EV=$${swo.ev.toFixed(1)}  │  Δ WR=${wrDelta >= 0 ? '+' : ''}${wrDelta.toFixed(1)}pp`);
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION D: DELTA GATES — delta15 / delta5 buckets per direction
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n────────── D. DELTA15 / DELTA5 by direction ──────────`);

console.log(`\n  D1. FLIP-LONG by delta15 (current gate: delta15 < 500)`);
const flipLong = decorated.filter(t => t.rule_id === 'clean-impulse' && t.direction === 'long' && t.delta15 != null);
for (const [label, fn] of [
  ['delta15 < -500', (d: number) => d < -500],
  ['delta15 -500..0', (d: number) => d >= -500 && d < 0],
  ['delta15 0..500', (d: number) => d >= 0 && d < 500],
] as [string, (d: number) => boolean][]) {
  const sub = flipLong.filter(t => fn(t.delta15!));
  if (sub.length >= MIN_BUCKET_N) console.log('  ' + fmt(label, statsOf(sub), baseline));
}

console.log(`\n  D2. FLIP-SHORT by delta15 (NO gate today — does adding one help?)`);
const flipShort = decorated.filter(t => t.rule_id === 'clean-impulse' && t.direction === 'short' && t.delta15 != null);
for (const [label, fn] of [
  ['delta15 > 500',  (d: number) => d > 500],
  ['delta15 0..500', (d: number) => d > 0 && d <= 500],
  ['delta15 -500..0', (d: number) => d <= 0 && d >= -500],
  ['delta15 < -500', (d: number) => d < -500],
] as [string, (d: number) => boolean][]) {
  const sub = flipShort.filter(t => fn(t.delta15!));
  if (sub.length >= MIN_BUCKET_N) console.log('  ' + fmt(label, statsOf(sub), baseline));
}

console.log(`\n  D3. FLIP by delta5 magnitude (gate today: |delta5| ≥ 1000)`);
const flips = decorated.filter(t => t.rule_id === 'clean-impulse' && t.delta5 != null);
for (const [label, fn] of [
  ['|delta5| 1000-1500',  (d: number) => Math.abs(d) >= 1000 && Math.abs(d) < 1500],
  ['|delta5| 1500-2500',  (d: number) => Math.abs(d) >= 1500 && Math.abs(d) < 2500],
  ['|delta5| ≥ 2500',     (d: number) => Math.abs(d) >= 2500],
] as [string, (d: number) => boolean][]) {
  const sub = flips.filter(t => fn(t.delta5!));
  if (sub.length >= MIN_BUCKET_N) console.log('  ' + fmt(label, statsOf(sub), baseline));
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION E: PRE-ENTRY AGGRESSOR DELTA (last 30s)
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n────────── E. PRE-ENTRY AGGRESSOR DELTA (30s before entry) ──────────`);
const tickWindow = ticksDb.prepare(`
  SELECT ts, price, size, is_bid_aggressor FROM trades
  WHERE symbol = ? AND ts > ? AND ts <= ?
`);
const preEntryDelta = decorated.map(t => {
  const win = tickWindow.all(t.symbol, t.ts - 30_000, t.ts) as { ts: number; price: number; size: number; is_bid_aggressor: number }[];
  let d = 0;
  for (const r of win) d += (r.is_bid_aggressor ? -r.size : r.size);
  return { trade: t, preDelta: d };
});
const preDeltaAligned = preEntryDelta.filter(x => (x.trade.direction === 'long' ? x.preDelta > 0 : x.preDelta < 0));
const preDeltaAgainst = preEntryDelta.filter(x => (x.trade.direction === 'long' ? x.preDelta < 0 : x.preDelta > 0));
const preDeltaFlat    = preEntryDelta.filter(x => x.preDelta === 0);
console.log('  ' + fmt('pre-entry delta ALIGNED w/ direction', statsOf(preDeltaAligned.map(x => x.trade)), baseline));
console.log('  ' + fmt('pre-entry delta AGAINST direction',    statsOf(preDeltaAgainst.map(x => x.trade)), baseline));
if (preDeltaFlat.length >= MIN_BUCKET_N) console.log('  ' + fmt('pre-entry delta FLAT (=0)', statsOf(preDeltaFlat.map(x => x.trade)), baseline));

// Magnitude bucket
console.log(`\n  E2. Pre-entry aligned-delta magnitude (size of confirming flow)`);
for (const [label, lo, hi] of [
  ['aligned |Δ| 0-50',    0,    50  ],
  ['aligned |Δ| 50-200',  50,   200 ],
  ['aligned |Δ| ≥ 200',   200,  Infinity],
] as [string, number, number][]) {
  const sub = preDeltaAligned.filter(x => {
    const m = Math.abs(x.preDelta);
    return m >= lo && m < hi;
  }).map(x => x.trade);
  if (sub.length >= MIN_BUCKET_N) console.log('  ' + fmt(label, statsOf(sub), baseline));
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION F: STACKED-PRINT CLUSTERS at entry level (last 60s)
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n────────── F. STACKED PRINTS at entry level (60s pre-entry, ±2 ticks) ──────────`);
const stackedCounts = decorated.map(t => {
  const lo = t.entry - 2 * TICK_SIZE;
  const hi = t.entry + 2 * TICK_SIZE;
  const win = tickWindow.all(t.symbol, t.ts - 60_000, t.ts) as { ts: number; price: number; size: number; is_bid_aggressor: number }[];
  const atLevel = win.filter(r => r.price >= lo && r.price <= hi);
  return { trade: t, prints: atLevel.length, totalSize: atLevel.reduce((s,r) => s+r.size, 0) };
});
for (const [label, lo, hi] of [
  ['stacked prints 0-5',     0,    5  ],
  ['stacked prints 5-20',    5,    20 ],
  ['stacked prints 20-50',   20,   50 ],
  ['stacked prints ≥ 50',    50,   Infinity],
] as [string, number, number][]) {
  const sub = stackedCounts.filter(x => x.prints >= lo && x.prints < hi).map(x => x.trade);
  if (sub.length >= MIN_BUCKET_N) console.log('  ' + fmt(label, statsOf(sub), baseline));
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION G: CONFIRMATION BAR (1-min after entry direction)
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n────────── G. CONFIRMATION BAR (1-min after entry direction) ──────────`);
const confirmStmt = ticksDb.prepare(`
  SELECT price FROM trades WHERE symbol = ? AND ts > ? AND ts <= ? ORDER BY ts DESC LIMIT 1
`);
const confirmed = decorated.map(t => {
  const r = confirmStmt.get(t.symbol, t.ts, t.ts + 60_000) as { price: number } | undefined;
  if (!r) return { trade: t, conf: null as null };
  const move = r.price - t.entry;
  const aligned = (t.direction === 'long' ? move > 0 : move < 0);
  return { trade: t, conf: aligned, move };
});
const confSub  = confirmed.filter(x => x.conf === true).map(x => x.trade);
const noConfSub = confirmed.filter(x => x.conf === false).map(x => x.trade);
console.log('  ' + fmt('1-min CONFIRMED direction', statsOf(confSub), baseline));
console.log('  ' + fmt('1-min DID NOT confirm',     statsOf(noConfSub), baseline));

// Tighter: 1-min closed at least 5 pts in direction
console.log(`\n  G2. 1-min strong confirm (≥ 5 pts in direction)`);
const strongConf = decorated.map(t => {
  const r = confirmStmt.get(t.symbol, t.ts, t.ts + 60_000) as { price: number } | undefined;
  if (!r) return { trade: t, ok: false };
  const move = (t.direction === 'long' ? r.price - t.entry : t.entry - r.price);
  return { trade: t, ok: move >= 5 };
});
const strongOk = strongConf.filter(x => x.ok).map(x => x.trade);
const strongNo = strongConf.filter(x => !x.ok).map(x => x.trade);
console.log('  ' + fmt('1-min ≥ 5pt direction-confirm', statsOf(strongOk), baseline));
console.log('  ' + fmt('1-min NO strong confirm',       statsOf(strongNo), baseline));

// ════════════════════════════════════════════════════════════════════════════
// SECTION H: ADAPTIVE TP/SL — bucket trades by entry-bar volatility (ATR proxy)
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n────────── H. VOL REGIME at entry (1-min range last 20 bars proxy) ──────────`);
const atrStmt = ticksDb.prepare(`
  SELECT MIN(price) AS lo, MAX(price) AS hi FROM trades
  WHERE symbol = ? AND ts > ? AND ts <= ?
`);
// Compute 20-min range as proxy (sum range / 20 ≈ avg per-min range)
const atrs = decorated.map(t => {
  const win = atrStmt.get(t.symbol, t.ts - 20 * 60_000, t.ts) as { lo: number | null; hi: number | null };
  if (win.lo == null || win.hi == null) return { trade: t, atr: 0 };
  const atr = (win.hi - win.lo) / 20;   // crude proxy
  return { trade: t, atr };
});
for (const [label, lo, hi] of [
  ['ATR-proxy < 1 pt/min (low vol)',    0,    1  ],
  ['ATR-proxy 1-2 pt/min',              1,    2  ],
  ['ATR-proxy 2-4 pt/min',              2,    4  ],
  ['ATR-proxy ≥ 4 pt/min (high vol)',   4,    Infinity],
] as [string, number, number][]) {
  const sub = atrs.filter(x => x.atr >= lo && x.atr < hi).map(x => x.trade);
  if (sub.length >= MIN_BUCKET_N) console.log('  ' + fmt(label, statsOf(sub), baseline));
}

// ════════════════════════════════════════════════════════════════════════════
// END
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(`══ DONE — eyeball each section for gates with Δ WR ≥ +5pp AND n ≥ 50 ══`);
console.log(`══════════════════════════════════════════════════════════════════════\n`);
