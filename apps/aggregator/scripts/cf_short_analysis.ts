/**
 * CF Short Full Analysis
 * Replicates the CF long analysis for CF short signals (strategy H, FLIP, direction=short, NQ only)
 * Filters: rs_hard_filtered=0, meta.filtered=0, pattern=FLIP, delta5>=1000
 * Backtests: TP=80 pts below entry, SL=105 pts above entry
 */

import Database from 'better-sqlite3';

const TRADING_DB = '/Users/ravikumarbasker/trading-cockpit/data/trading.db';
const TICKS_DB   = '/Users/ravikumarbasker/trading-cockpit/data/ticks.db';

const TP_PTS = 80;
const SL_PTS = 105;
const RTH_END_OFFSET_MS = 6 * 3600_000 + 30 * 60_000; // 16:00 ET = 20:30 UTC

const tradingDb = new Database(TRADING_DB, { readonly: true });
const ticksDb   = new Database(TICKS_DB,   { readonly: true });

// ─── Pull all CF short signals ────────────────────────────────────────────────
const signals = tradingDb.prepare(`
  SELECT
    id, ts, symbol,
    json_extract(payload,'$.entry')     as entry,
    json_extract(payload,'$.stopLevel') as stopLevel,
    json_extract(payload,'$.stopDist')  as stopDist,
    json_extract(payload,'$.delta5')    as delta5,
    json_extract(payload,'$.delta15')   as delta15,
    json_extract(payload,'$.deltaT')    as deltaT,
    json_extract(payload,'$.deltaLast3') as deltaLast3,
    json_extract(payload,'$.compPos')   as compPos,
    payload
  FROM signals
  WHERE rule_id='clean-impulse' AND direction='short' AND strategy_version='H' AND symbol='NQ'
    AND rs_hard_filtered IS NOT 1
    AND json_extract(meta,'$.filtered') IS NOT 1
    AND json_extract(payload,'$.pattern') = 'FLIP'
    AND CAST(json_extract(payload,'$.delta5') AS REAL) >= 1000
  ORDER BY ts
`).all() as any[];

// ─── Tick-by-tick resolution ──────────────────────────────────────────────────
interface TradeResult {
  id: number;
  tsMs: number;
  etLabel: string;
  entry: number;
  tpLevel: number;
  slLevel: number;
  stopLevel: number; // bar high (actual)
  stopDist: number;
  delta5: number;
  delta15: number;
  deltaT: number;
  deltaLast3: number;
  compPos: number;
  outcome: 'WIN' | 'LOSS' | 'OPEN';
  pnl: number; // in pts
  mfe: number; // max favorable (pts below entry)
  mae: number; // max adverse (pts above entry)
  sessDelta: number;
  resolutionTime?: string;
}

function rthEndMs(signalTs: number): number {
  // 09:30 ET = 13:30 UTC, 16:00 ET = 20:00 UTC
  // signal ts is in UTC ms
  const d = new Date(signalTs);
  // Get midnight UTC of the signal day then add 20:00 UTC
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnight + 20 * 3600_000; // 20:00 UTC = 16:00 ET
}

function sessionStartMs(signalTs: number): number {
  const d = new Date(signalTs);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnight + 13 * 3600_000 + 30 * 60_000; // 09:30 ET
}

const results: TradeResult[] = [];

for (const sig of signals) {
  const entry  = parseFloat(sig.entry);
  const tpLevel = entry - TP_PTS;
  const slLevel = entry + SL_PTS;
  const rthEnd  = rthEndMs(sig.ts);
  const sessStart = sessionStartMs(sig.ts);

  // Compute sessDelta: cumulative (bid_aggressor=1 → buy, =0 → sell) from 09:30 to signal ts
  const sessRow = ticksDb.prepare(`
    SELECT SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) as sd
    FROM trades
    WHERE symbol='NQ' AND ts >= ? AND ts < ?
  `).get(sessStart, sig.ts) as any;
  const sessDelta = Math.round(sessRow?.sd ?? 0);

  // Tick-by-tick from signal ts to 16:00 ET
  const ticks = ticksDb.prepare(`
    SELECT ts, price FROM trades
    WHERE symbol='NQ' AND ts > ? AND ts <= ?
    ORDER BY ts ASC
  `).all(sig.ts, rthEnd) as any[];

  let outcome: 'WIN' | 'LOSS' | 'OPEN' = 'OPEN';
  let mfe = 0; // pts below entry (favorable for short)
  let mae = 0; // pts above entry (adverse for short)
  let pnl = 0;
  let resolutionTime: string | undefined;

  for (const tick of ticks) {
    const favorable = entry - tick.price; // positive = price went down (good for short)
    const adverse   = tick.price - entry; // positive = price went up (bad for short)
    if (favorable > mfe) mfe = favorable;
    if (adverse   > mae) mae = adverse;

    if (tick.price <= tpLevel) {
      outcome = 'WIN';
      pnl = TP_PTS;
      const et = new Date(tick.ts - 4 * 3600_000);
      resolutionTime = et.toISOString().replace('T', ' ').slice(0, 16);
      break;
    }
    if (tick.price >= slLevel) {
      outcome = 'LOSS';
      pnl = -SL_PTS;
      const et = new Date(tick.ts - 4 * 3600_000);
      resolutionTime = et.toISOString().replace('T', ' ').slice(0, 16);
      break;
    }
  }

  const etLabel = new Date(sig.ts - 4 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);

  results.push({
    id: sig.id,
    tsMs: sig.ts,
    etLabel,
    entry,
    tpLevel,
    slLevel,
    stopLevel: parseFloat(sig.stopLevel),
    stopDist: parseFloat(sig.stopDist),
    delta5: parseFloat(sig.delta5),
    delta15: parseFloat(sig.delta15),
    deltaT: parseFloat(sig.deltaT),
    deltaLast3: parseFloat(sig.deltaLast3),
    compPos: parseFloat(sig.compPos),
    outcome,
    pnl,
    mfe: Math.round(mfe * 10) / 10,
    mae: Math.round(mae * 10) / 10,
    sessDelta,
    resolutionTime,
  });
}

// ─── Statistics ───────────────────────────────────────────────────────────────
const resolved = results.filter(r => r.outcome !== 'OPEN');
const wins     = results.filter(r => r.outcome === 'WIN');
const losses   = results.filter(r => r.outcome === 'LOSS');
const open     = results.filter(r => r.outcome === 'OPEN');

const wr = wins.length / resolved.length;
const pnls = resolved.map(r => r.pnl);
const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
const variance = pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / pnls.length;
const std = Math.sqrt(variance);
const sharpe = mean / std;
const pnl100 = mean * 100 * 20; // 1 NQ pt = $20

// ─── Print individual trades ───────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log(' CF SHORT — Individual Trades  (TP=80 / SL=105)');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log(
  'Signal Time (ET)'.padEnd(18),
  'Entry'.padStart(8),
  'StpDst'.padStart(8),
  'd5'.padStart(7),
  'd15'.padStart(7),
  'dT'.padStart(7),
  'sessDelta'.padStart(11),
  'compPos'.padStart(9),
  'MFE'.padStart(7),
  'MAE'.padStart(7),
  'Result'.padStart(7),
  'Resolved'.padStart(16),
);
console.log('─'.repeat(120));

for (const r of results) {
  const compStr = r.compPos.toFixed(3);
  console.log(
    r.etLabel.padEnd(18),
    r.entry.toFixed(2).padStart(8),
    r.stopDist.toFixed(1).padStart(8),
    r.delta5.toFixed(0).padStart(7),
    r.delta15.toFixed(0).padStart(7),
    r.deltaT.toFixed(0).padStart(7),
    r.sessDelta.toString().padStart(11),
    compStr.padStart(9),
    r.mfe.toFixed(1).padStart(7),
    r.mae.toFixed(1).padStart(7),
    (r.outcome === 'WIN' ? '✓ WIN' : r.outcome === 'LOSS' ? '✗ LOSS' : '○ OPEN').padStart(7),
    (r.resolutionTime ?? '(open)').padStart(16),
  );
}

// ─── Summary stats ────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log(' SUMMARY STATISTICS');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log(`Total signals : ${results.length}`);
console.log(`Resolved      : ${resolved.length}  (wins=${wins.length}, losses=${losses.length})`);
console.log(`Open/pending  : ${open.length}`);
console.log(`Win rate      : ${(wr * 100).toFixed(1)}%`);
console.log(`Mean PnL/trade: ${mean.toFixed(1)} pts`);
console.log(`Std dev       : ${std.toFixed(2)} pts`);
console.log(`Sharpe        : ${sharpe.toFixed(3)}`);
console.log(`PnL / 100 trades: $${Math.round(pnl100).toLocaleString()} (at $20/pt)`);

// ─── Loss analysis ────────────────────────────────────────────────────────────
if (losses.length > 0) {
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(' LOSS DETAIL');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  for (const r of losses) {
    console.log(`\n  ${r.etLabel}  entry=${r.entry}  (MFE before loss: ${r.mfe} pts)`);
    console.log(`    delta5=${r.delta5}  delta15=${r.delta15}  deltaT=${r.deltaT}  sessDelta=${r.sessDelta}  compPos=${r.compPos.toFixed(3)}`);
    console.log(`    StopDist=${r.stopDist}  MAE=${r.mae}`);
  }
}

// ─── MFE distribution ─────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log(' MFE DISTRIBUTION (max favorable excursion = max downside seen for short)');
console.log('═══════════════════════════════════════════════════════════════════════════════');
const mfeBuckets = [0, 20, 40, 60, 70, 80, 100, 120, 150, 999];
for (let i = 0; i < mfeBuckets.length - 1; i++) {
  const lo = mfeBuckets[i], hi = mfeBuckets[i + 1];
  const cnt = resolved.filter(r => r.mfe >= lo && r.mfe < hi).length;
  const bar = '█'.repeat(cnt);
  console.log(`  MFE ${lo.toString().padStart(3)}–${(hi === 999 ? '∞' : hi).toString().padStart(3)} pts : ${bar} (n=${cnt})`);
}

// ─── TP sensitivity: try TP=60,70,80,90 fixed SL=105 ─────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log(' TP SENSITIVITY  (SL=105 fixed, resolved signals only)');
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('TP'.padEnd(6), 'WR'.padStart(8), 'Mean'.padStart(8), 'Std'.padStart(8), 'Sharpe'.padStart(10), 'PnL/100'.padStart(12));
for (const tp of [60, 70, 80, 90]) {
  const sl = 105;
  const tpPnls = resolved.map(r => {
    if (r.mfe >= tp) return tp;
    if (r.mae >= sl) return -sl;
    // check which hit first from MFE/MAE proxy — can't tell exact order from summary
    // re-scan needed for exact, but use conservative: if mfe >= tp, WIN; if mae >= sl, LOSS
    // For signals that are WIN (tp=80): mfe >= 80, so definitely mfe >= 60 or 70
    // For losses: mfe < 80 so they'd also lose with lower tp unless mfe >= tp
    if (r.outcome === 'WIN' && r.mfe >= tp) return tp;
    if (r.outcome === 'WIN' && r.mfe < tp)  return -sl; // would have been loss
    if (r.outcome === 'LOSS') {
      if (r.mfe >= tp) return tp; // would have been win with tighter tp
      return -sl;
    }
    return 0;
  });
  const tpWins = tpPnls.filter(p => p > 0).length;
  const tpWr = tpWins / tpPnls.length;
  const tpMean = tpPnls.reduce((a, b) => a + b, 0) / tpPnls.length;
  const tpVar = tpPnls.reduce((a, b) => a + (b - tpMean) ** 2, 0) / tpPnls.length;
  const tpStd = Math.sqrt(tpVar);
  const tpSharpe = tpMean / tpStd;
  const tpPnl100 = tpMean * 100 * 20;
  console.log(
    tp.toString().padEnd(6),
    (tpWr * 100).toFixed(1).padStart(7) + '%',
    tpMean.toFixed(1).padStart(8),
    tpStd.toFixed(2).padStart(8),
    tpSharpe.toFixed(3).padStart(10),
    ('$' + Math.round(tpPnl100).toLocaleString()).padStart(12),
  );
}

// ─── SL sensitivity: try SL=60,80,105 fixed TP=80 ───────────────────────────
console.log('\n SL SENSITIVITY  (TP=80 fixed, resolved signals only)');
console.log('─'.repeat(70));
console.log('SL'.padEnd(6), 'WR'.padStart(8), 'Mean'.padStart(8), 'Std'.padStart(8), 'Sharpe'.padStart(10), 'PnL/100'.padStart(12));
for (const sl of [60, 80, 105, 120]) {
  const tp = 80;
  const slPnls = resolved.map(r => {
    if (r.outcome === 'WIN') return tp;
    // LOSS: mfe didn't reach tp. Was mae >= sl?
    if (r.mae >= sl) return -sl;
    // mae < sl → trade would be open (count as break-even for simplicity)
    return 0;
  });
  const slWins = slPnls.filter(p => p > 0).length;
  const slResolved2 = slPnls.filter(p => p !== 0).length;
  const slWr = slResolved2 > 0 ? slWins / slResolved2 : 0;
  const slPnlsResolved = slPnls.filter(p => p !== 0);
  const slMean = slPnlsResolved.length > 0 ? slPnlsResolved.reduce((a, b) => a + b, 0) / slPnlsResolved.length : 0;
  const slVar  = slPnlsResolved.reduce((a, b) => a + (b - slMean) ** 2, 0) / (slPnlsResolved.length || 1);
  const slStd  = Math.sqrt(slVar);
  const slSharpe = slStd > 0 ? slMean / slStd : 0;
  const slPnl100 = slMean * 100 * 20;
  console.log(
    sl.toString().padEnd(6),
    (slWr * 100).toFixed(1).padStart(7) + '%',
    slMean.toFixed(1).padStart(8),
    slStd.toFixed(2).padStart(8),
    slSharpe.toFixed(3).padStart(10),
    ('$' + Math.round(slPnl100).toLocaleString()).padStart(12),
  );
}

// ─── Time window WR ──────────────────────────────────────────────────────────
const WINDOWS = [
  { label: '09:30–09:59', loMins: 9*60+30, hiMins: 10*60 },
  { label: '10:00–10:29', loMins: 10*60,   hiMins: 10*60+30 },
  { label: '10:30–11:29', loMins: 10*60+30, hiMins: 11*60+30 },
  { label: '11:30–12:59', loMins: 11*60+30, hiMins: 13*60 },
  { label: '13:00–14:29', loMins: 13*60,   hiMins: 14*60+30 },
  { label: '14:30–15:59', loMins: 14*60+30, hiMins: 16*60 },
];

console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log(' WIN RATE BY TIME WINDOW');
console.log('═══════════════════════════════════════════════════════════════════════════════');
for (const w of WINDOWS) {
  const inWindow = results.filter(r => {
    const et = new Date(r.tsMs - 4 * 3600_000);
    const mins = et.getUTCHours() * 60 + et.getUTCMinutes();
    return mins >= w.loMins && mins < w.hiMins;
  });
  const resolvedW = inWindow.filter(r => r.outcome !== 'OPEN');
  const winsW = inWindow.filter(r => r.outcome === 'WIN');
  const wrStr = resolvedW.length > 0 ? `${Math.round(winsW.length / resolvedW.length * 100)}% (n=${resolvedW.length})` : '—';
  console.log(`  ${w.label} : ${wrStr}${resolvedW.length > 0 && winsW.length / resolvedW.length < 0.6 ? ' ⚠' : ''}`);
}

console.log('\nDone.');
