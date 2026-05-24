/**
 * EXPL Long Full Analysis
 * Replicates the CF long/short analysis pattern for EXPL long signals.
 * Filters match quality.ts + strategy-expl.ts gates exactly.
 *
 * Filter chain:
 *   rule_id='expl', strategy_version='EXPL', direction='long', symbol='NQ'
 *   rs_hard_filtered IS NOT 1
 *   meta.filtered IS NOT 1
 *   zones > 0 (at least one stacked bid zone)
 *   rangePct >= 0.5 OR rangePct IS NULL (bid zone not in bottom half of 60-min range)
 *
 * TP = 80 pts above entry
 * SL = 70 pts below entry
 */

import Database from 'better-sqlite3';

const TRADING_DB = '/Users/ravikumarbasker/trading-cockpit/data/trading.db';
const TICKS_DB   = '/Users/ravikumarbasker/trading-cockpit/data/ticks.db';

const TP_PTS = 80;
const SL_PTS = 70;

const tradingDb = new Database(TRADING_DB, { readonly: true });
const ticksDb   = new Database(TICKS_DB,   { readonly: true });

// ─── Pull signals ─────────────────────────────────────────────────────────────
const raw = (tradingDb.prepare(`
  SELECT
    id, ts, score,
    json_extract(payload,'$.entry')          as entry,
    json_extract(payload,'$.rangePct')       as rangePct,
    json_extract(payload,'$.profile')        as profile,
    json_extract(payload,'$.compressionAvg') as compressionAvg,
    json_extract(payload,'$.shakeout')       as shakeout,
    json_extract(payload,'$.largeLotPrice')  as largeLotPrice,
    json_extract(payload,'$.largeLotSize')   as largeLotSize,
    json_array_length(json_extract(payload,'$.stackedBidZones')) as zones,
    payload
  FROM signals
  WHERE rule_id='expl' AND direction='long' AND strategy_version='EXPL' AND symbol='NQ'
    AND rs_hard_filtered IS NOT 1
    AND json_extract(meta,'$.filtered') IS NOT 1
  ORDER BY ts
`).all() as any[])
  .filter(r => {
    const rp = parseFloat(r.rangePct);
    const zonesOk = (r.zones ?? 0) > 0;
    const rangePctOk = isNaN(rp) || rp >= 0.5;
    return zonesOk && rangePctOk;
  });

// ─── Helper: ET minute-of-day ──────────────────────────────────────────────────
function etMinute(tsMs: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const h = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
  return h * 60 + m;
}

function etLabel(tsMs: number): string {
  return new Date(tsMs - 4 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
}

function rthEndMs(tsMs: number): number {
  const d = new Date(tsMs);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let end = midnight + 20 * 3600_000; // 20:00 UTC = 16:00 EDT
  if (end <= tsMs) end += 3600_000;   // EST fallback
  return end;
}

function sessionStartMs(tsMs: number): number {
  const d = new Date(tsMs);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnight + 13 * 3600_000 + 30 * 60_000; // 09:30 ET
}

// ─── Entry price ──────────────────────────────────────────────────────────────
const entryQuery = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? ORDER BY ts ASC LIMIT 1`
);

function resolveEntry(sig: any): number {
  const p = JSON.parse(sig.payload);
  if (p.entry && p.entry > 1000) return p.entry;
  const row = entryQuery.get(sig.ts) as any;
  return row?.price ?? 0;
}

// ─── Tick-by-tick resolution ──────────────────────────────────────────────────
interface TradeResult {
  id: number;
  tsMs: number;
  etLabel: string;
  etMin: number;
  entry: number;
  tpLevel: number;
  slLevel: number;
  score: number;
  zones: number;
  rangePct: number;
  profile: string;
  compressionAvg: number;
  shakeout: boolean;
  largeLotPrice: number;
  largeLotSize: number;
  outcome: 'WIN' | 'LOSS' | 'OPEN';
  pnl: number;
  mfe: number;
  mae: number;
  sessDelta: number;
  resolutionTime?: string;
  resolutionMin?: number; // minutes from entry to resolution
}

const results: TradeResult[] = [];

for (const sig of raw) {
  const entry    = resolveEntry(sig);
  if (entry <= 0) continue;

  const tpLevel  = entry + TP_PTS;
  const slLevel  = entry - SL_PTS;
  const rthEnd   = rthEndMs(sig.ts);
  const sessStart = sessionStartMs(sig.ts);

  // sessDelta: cumulative net buy−sell from 09:30 ET to signal time
  const sessRow = (ticksDb.prepare(`
    SELECT SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) as sd
    FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?
  `).get(sessStart, sig.ts)) as any;
  const sessDelta = Math.round(sessRow?.sd ?? 0);

  // Tick-by-tick scan
  const ticks = (ticksDb.prepare(`
    SELECT ts, price FROM trades
    WHERE symbol='NQ' AND ts > ? AND ts <= ?
    ORDER BY ts ASC
  `).all(sig.ts, rthEnd)) as any[];

  let outcome: 'WIN' | 'LOSS' | 'OPEN' = 'OPEN';
  let mfe = 0, mae = 0, pnl = 0;
  let resolutionTime: string | undefined;
  let resolutionMin: number | undefined;

  for (const tick of ticks) {
    const favorable = tick.price - entry; // positive = price went up (good for long)
    const adverse   = entry - tick.price; // positive = price went down (bad for long)
    if (favorable > mfe) mfe = favorable;
    if (adverse   > mae) mae = adverse;

    if (tick.price >= tpLevel) {
      outcome = 'WIN';
      pnl = TP_PTS;
      resolutionTime = etLabel(tick.ts);
      resolutionMin = Math.round((tick.ts - sig.ts) / 60_000);
      break;
    }
    if (tick.price <= slLevel) {
      outcome = 'LOSS';
      pnl = -SL_PTS;
      resolutionTime = etLabel(tick.ts);
      resolutionMin = Math.round((tick.ts - sig.ts) / 60_000);
      break;
    }
  }

  results.push({
    id: sig.id,
    tsMs: sig.ts,
    etLabel: etLabel(sig.ts),
    etMin: etMinute(sig.ts),
    entry,
    tpLevel,
    slLevel,
    score: sig.score,
    zones: sig.zones ?? 0,
    rangePct: parseFloat(sig.rangePct) || 0,
    profile: sig.profile ?? '—',
    compressionAvg: parseFloat(sig.compressionAvg) || 0,
    shakeout: sig.shakeout === 1 || sig.shakeout === true,
    largeLotPrice: parseFloat(sig.largeLotPrice) || 0,
    largeLotSize: parseFloat(sig.largeLotSize) || 0,
    outcome,
    pnl,
    mfe: Math.round(mfe * 10) / 10,
    mae: Math.round(mae * 10) / 10,
    sessDelta,
    resolutionTime,
    resolutionMin,
  });
}

// ─── Individual trade table ───────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
console.log(' EXPL LONG — Individual Trades  (TP=80 / SL=70)');
console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
console.log(
  'Signal Time (ET)'.padEnd(18),
  'Entry'.padStart(8),
  'Sc'.padStart(3),
  'Zones'.padStart(6),
  'rPct'.padStart(6),
  'Prof'.padStart(5),
  'Shk'.padStart(4),
  'sessDelta'.padStart(10),
  'MFE'.padStart(6),
  'MAE'.padStart(6),
  'Result'.padStart(7),
  'Mins'.padStart(5),
);
console.log('─'.repeat(110));

for (const r of results) {
  console.log(
    r.etLabel.padEnd(18),
    r.entry.toFixed(2).padStart(8),
    r.score.toString().padStart(3),
    r.zones.toString().padStart(6),
    r.rangePct.toFixed(2).padStart(6),
    (r.profile || '—').padStart(5),
    (r.shakeout ? 'Y' : 'N').padStart(4),
    r.sessDelta.toString().padStart(10),
    r.mfe.toFixed(0).padStart(6),
    r.mae.toFixed(0).padStart(6),
    (r.outcome === 'WIN' ? '✓ WIN' : r.outcome === 'LOSS' ? '✗ LOSS' : '○ OPEN').padStart(7),
    (r.resolutionMin?.toString() ?? '—').padStart(5),
  );
}

// ─── Overall stats ────────────────────────────────────────────────────────────
const resolved = results.filter(r => r.outcome !== 'OPEN');
const wins     = results.filter(r => r.outcome === 'WIN');
const losses   = results.filter(r => r.outcome === 'LOSS');
const open     = results.filter(r => r.outcome === 'OPEN');

const pnls   = resolved.map(r => r.pnl);
const mean   = pnls.reduce((a, b) => a + b, 0) / pnls.length;
const variance = pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / pnls.length;
const std    = Math.sqrt(variance);
const sharpe = mean / std;
const pnl100 = mean * 100 * 20;
const wr     = wins.length / resolved.length;

console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════');
console.log(' OVERALL STATISTICS  (TP=80 / SL=70)');
console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
console.log(`Total signals   : ${results.length}`);
console.log(`Resolved        : ${resolved.length}  (wins=${wins.length}, losses=${losses.length})`);
console.log(`Open at EOD     : ${open.length}`);
console.log(`Win rate        : ${(wr * 100).toFixed(1)}%`);
console.log(`Mean PnL/trade  : ${mean.toFixed(1)} pts`);
console.log(`Std deviation   : ${std.toFixed(2)} pts`);
console.log(`Sharpe          : ${sharpe.toFixed(3)}`);
console.log(`PnL / 100 trades: $${Math.round(pnl100).toLocaleString()} (at $20/pt NQ)`);

// ─── Time window WR ──────────────────────────────────────────────────────────
const WINDOWS = [
  { label: '09:30–09:59', lo: 570, hi: 600 },
  { label: '10:00–10:29', lo: 600, hi: 630 },
  { label: '10:30–11:29', lo: 630, hi: 690 },
  { label: '11:30–12:59', lo: 690, hi: 780 },
  { label: '13:00–14:29', lo: 780, hi: 870 },
  { label: '14:30–15:59', lo: 870, hi: 960 },
];

console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════');
console.log(' WIN RATE BY TIME WINDOW');
console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
console.log('Window'.padEnd(16), 'WR'.padStart(10), 'W'.padStart(4), 'L'.padStart(4), 'Open'.padStart(6), '  Losses detail');
console.log('─'.repeat(80));

for (const w of WINDOWS) {
  const inWin = results.filter(r => r.etMin >= w.lo && r.etMin < w.hi);
  const wWins = inWin.filter(r => r.outcome === 'WIN');
  const wLoss = inWin.filter(r => r.outcome === 'LOSS');
  const wOpen = inWin.filter(r => r.outcome === 'OPEN');
  const wRes  = inWin.filter(r => r.outcome !== 'OPEN');
  const wrStr = wRes.length > 0
    ? `${Math.round(wWins.length / wRes.length * 100)}% (n=${wRes.length})` + (wWins.length / wRes.length < 0.6 ? ' ⚠' : '')
    : '—';

  const lossLabels = wLoss.map(r => r.etLabel.slice(8)).join(', ');
  console.log(
    w.label.padEnd(16),
    wrStr.padStart(14),
    wWins.length.toString().padStart(4),
    wLoss.length.toString().padStart(4),
    wOpen.length.toString().padStart(6),
    lossLabels ? `  ← losses: ${lossLabels}` : '',
  );
}

// ─── Loss detail ─────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════');
console.log(` LOSS DETAIL  (${losses.length} total losses)`);
console.log('═══════════════════════════════════════════════════════════════════════════════════════════');

// Group by time window for analysis
for (const w of WINDOWS) {
  const wLoss = losses.filter(r => r.etMin >= w.lo && r.etMin < w.hi);
  if (wLoss.length === 0) continue;
  console.log(`\n  [${w.label}]  — ${wLoss.length} loss(es)`);
  for (const r of wLoss) {
    console.log(`    ${r.etLabel}  entry=${r.entry.toFixed(2)}  MFE=${r.mfe}  MAE=${r.mae}`);
    console.log(`      score=${r.score}  zones=${r.zones}  rangePct=${r.rangePct.toFixed(3)}  profile=${r.profile}  sessDelta=${r.sessDelta}`);
  }
}

// ─── MFE distribution ─────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════');
console.log(' MFE DISTRIBUTION (all resolved signals)');
console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
const mfeBuckets = [0, 10, 20, 30, 40, 50, 60, 70, 80, 100, 999];
for (let i = 0; i < mfeBuckets.length - 1; i++) {
  const lo = mfeBuckets[i], hi = mfeBuckets[i + 1];
  const sigs = resolved.filter(r => r.mfe >= lo && r.mfe < hi);
  const bar = '█'.repeat(sigs.length);
  const label = hi === 999 ? '∞' : hi.toString();
  console.log(`  MFE ${lo.toString().padStart(3)}–${label.padStart(3)} pts : ${bar} (n=${sigs.length})`);
}

// ─── WR by score ─────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════');
console.log(' WIN RATE BY SCORE  (confluence count)');
console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
for (const sc of [3, 4, 5]) {
  const inScore = resolved.filter(r => r.score === sc);
  const wScore  = inScore.filter(r => r.outcome === 'WIN');
  const wrStr   = inScore.length > 0 ? `${Math.round(wScore.length / inScore.length * 100)}% (n=${inScore.length})` : '—';
  console.log(`  Score ${sc}: ${wrStr}`);
}

// ─── WR by profile ────────────────────────────────────────────────────────────
console.log('\n WIN RATE BY CUM DELTA PROFILE');
console.log('─'.repeat(40));
for (const prof of ['A', 'B', null]) {
  const label = prof ?? '(none)';
  const inProf = resolved.filter(r => (prof === null ? !r.profile || r.profile === '—' : r.profile === prof));
  const wProf  = inProf.filter(r => r.outcome === 'WIN');
  const wrStr  = inProf.length > 0 ? `${Math.round(wProf.length / inProf.length * 100)}% (n=${inProf.length})` : '—';
  console.log(`  Profile ${label}: ${wrStr}`);
}

// ─── Time-to-resolution distribution ─────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════');
console.log(' TIME TO RESOLUTION  (minutes from signal to TP/SL hit)');
console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
const timeBuckets = [0, 5, 10, 20, 30, 60, 120, 999];
for (let i = 0; i < timeBuckets.length - 1; i++) {
  const lo = timeBuckets[i], hi = timeBuckets[i + 1];
  const sigs = resolved.filter(r => (r.resolutionMin ?? 0) >= lo && (r.resolutionMin ?? 0) < hi);
  const wCount = sigs.filter(r => r.outcome === 'WIN').length;
  const bar = '█'.repeat(sigs.length);
  const hiLabel = hi === 999 ? '∞' : hi.toString();
  console.log(`  ${lo.toString().padStart(3)}–${hiLabel.padStart(3)} min : ${bar} (n=${sigs.length}, ${wCount}W/${sigs.length - wCount}L)`);
}

// ─── Afternoon window deep-dive ───────────────────────────────────────────────
const afternoon = results.filter(r => r.etMin >= 780); // 13:00+
const pm1 = results.filter(r => r.etMin >= 780 && r.etMin < 870);
const pm2 = results.filter(r => r.etMin >= 870);

console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════');
console.log(' AFTERNOON WINDOW DEEP-DIVE  (the low-WR windows)');
console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
console.log(`13:00–14:29 (n=${pm1.length}):`);
pm1.forEach(r => {
  const tag = r.outcome === 'WIN' ? '✓' : r.outcome === 'LOSS' ? '✗' : '○';
  console.log(`  ${tag} ${r.etLabel}  MFE=${r.mfe}  MAE=${r.mae}  score=${r.score}  rPct=${r.rangePct.toFixed(2)}  sessΔ=${r.sessDelta}`);
});
console.log(`\n14:30–15:59 (n=${pm2.length}):`);
pm2.forEach(r => {
  const tag = r.outcome === 'WIN' ? '✓' : r.outcome === 'LOSS' ? '✗' : '○';
  console.log(`  ${tag} ${r.etLabel}  MFE=${r.mfe}  MAE=${r.mae}  score=${r.score}  rPct=${r.rangePct.toFixed(2)}  sessΔ=${r.sessDelta}`);
});

console.log('\nDone.');
