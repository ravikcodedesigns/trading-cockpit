/**
 * rescore_absorption.ts
 *
 * Rescores all NQ absorption signals in trading.db using the new
 * Speed + Purity + Context scoring model (absorption-v2).
 *
 * Old model: base 50 + volume ratio + price range + aggression binary + duration binary + trend
 * New model: speed (0-40) + purity (0-30) + context (0-30)
 *
 * Run: cd apps/aggregator && npx tsx scripts/rescore_absorption.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');

const db = new Database(TRADING_DB);

// ── New scoring functions (mirrors absorption.ts) ──────────────────────────

function speedScore(durationMs: number): number {
  if      (durationMs < 100)  return 40;
  else if (durationMs < 500)  return 30;
  else if (durationMs < 2000) return 15;
  else if (durationMs < 4000) return 5;
  else                        return 0;
}

function purityScore(aggressionPct: number): number {
  if      (aggressionPct >= 0.98) return 30;
  else if (aggressionPct >= 0.90) return 20;
  else if (aggressionPct >= 0.80) return 12;
  else if (aggressionPct >= 0.70) return 5;
  else                            return 0;
}

function isOpeningPeriod(tsMs: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const wd = parts.find(p => p.type === 'weekday')?.value ?? '';
  const h  = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0');
  const m  = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0');
  const isRTH = ['Mon','Tue','Wed','Thu','Fri'].includes(wd) && (h*60+m) >= 570 && (h*60+m) < 960;
  return isRTH && (h*60+m) < 585; // before 9:45 ET
}

// Count consecutive 1-min bars pressing into the level before signal
function countApproachBars(symbol: string, direction: string, tsMs: number): number {
  const sinceMs = tsMs - 7 * 60 * 1000;
  // GROUP BY ts: events table stores many duplicate updates per bar;
  // keep the last entry (highest rowid) per bar timestamp.
  const rows = db.prepare(`
    SELECT ts,
      json_extract(payload,'$.open')  AS open,
      json_extract(payload,'$.close') AS close
    FROM events
    WHERE rowid IN (
      SELECT MAX(rowid) FROM events
      WHERE symbol=? AND source IN ('bookmap','bookmap-es') AND type='bar'
        AND ts >= ? AND ts < ?
      GROUP BY ts
    )
    ORDER BY ts ASC
  `).all(symbol, sinceMs, tsMs) as { ts: number; open: number; close: number }[];

  const completed = rows.filter(b => tsMs - b.ts >= 60_000);
  if (!completed.length) return 0;

  let count = 0;
  for (let i = completed.length - 1; i >= 0; i--) {
    const b = completed[i]!;
    const pressing = direction === 'short' ? b.close > b.open : b.close < b.open;
    if (!pressing) break;
    count++;
  }
  return count;
}

// Check signal cluster: how many prior signals at ±5 pts within 10 min
function clusterCount(symbol: string, direction: string, price: number, tsMs: number): number {
  const rows = db.prepare(`
    SELECT ts FROM signals
    WHERE symbol=? AND rule_id='absorption' AND direction=?
      AND ts >= ? AND ts < ?
      AND ABS(CAST(COALESCE(
            json_extract(payload,'$.entry'),
            CAST(SUBSTR(payload, INSTR(payload,'absorbed at ')+12,
                 INSTR(SUBSTR(payload,INSTR(payload,'absorbed at ')+12),' ')-1) AS REAL)
          ) AS REAL) - ?) <= 5.0
  `).all(symbol, direction, tsMs - 10*60_000, tsMs, price) as { ts: number }[];
  return rows.length;
}

function newScore(
  aggressionPct: number,
  durationMs: number,
  trendAligned: boolean,
  approachBars: number,
  clusterN: number,
  opening: boolean,
): number {
  const sp = speedScore(durationMs);
  const pu = purityScore(aggressionPct);
  let ctx = 15;
  if      (approachBars >= 3) ctx += 10;
  else if (approachBars >= 1) ctx += 5;
  if (trendAligned)           ctx += 5;
  if      (clusterN >= 2)     ctx -= 20;
  else if (clusterN === 1)    ctx -= 10;
  if (opening)                ctx -= 5;
  ctx = Math.max(0, ctx);
  return Math.min(100, sp + pu + ctx);
}

// ── Parse rationale ────────────────────────────────────────────────────────

interface ParsedRationale {
  volume: number;
  price: number;
  durationMs: number;
  aggressionPct: number;
  trendAligned: boolean;
}

function parseRationale(rationale: string): ParsedRationale | null {
  const volM  = rationale.match(/(\d+) contracts of/);
  const prM   = rationale.match(/absorbed at ([0-9.]+)/);
  const durM  = rationale.match(/over (\d+)ms/);
  const aggM  = rationale.match(/Aggression: (\d+)%/);
  if (!volM || !prM || !durM || !aggM) return null;
  return {
    volume:       parseInt(volM[1]!),
    price:        parseFloat(prM[1]!),
    durationMs:   parseInt(durM[1]!),
    aggressionPct: parseInt(aggM[1]!) / 100,
    trendAligned: /TREND-ALIGNED/.test(rationale),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

interface SigRow {
  id: number; ts: number; score: number; direction: string; symbol: string;
  rationale: string | null; entry: number | null;
}

const sigs = db.prepare(`
  SELECT id, ts, score, direction, symbol,
    json_extract(payload,'$.rationale') AS rationale,
    CAST(COALESCE(
      json_extract(payload,'$.entry'),
      CAST(SUBSTR(json_extract(payload,'$.rationale'),
           INSTR(json_extract(payload,'$.rationale'),'absorbed at ')+12,
           INSTR(SUBSTR(json_extract(payload,'$.rationale'),
                 INSTR(json_extract(payload,'$.rationale'),'absorbed at ')+12),' ')-1) AS REAL)
    ) AS REAL) AS entry
  FROM signals
  WHERE rule_id='absorption'
  ORDER BY ts ASC
`).all() as SigRow[];

console.log(`Rescoring ${sigs.length} absorption signals…\n`);

const updateStmt = db.prepare(`UPDATE signals SET score=?, meta=?, payload=? WHERE id=?`);

let updated = 0, skipped = 0;
const dist: Record<string, number> = {};

// Track old vs new score bands for comparison
const comparison: { old: number; new: number; conv: string }[] = [];

for (const sig of sigs) {
  if (!sig.rationale) { skipped++; continue; }
  const parsed = parseRationale(sig.rationale);
  if (!parsed) { skipped++; continue; }
  if (!sig.entry) { skipped++; continue; }

  const approachBars = countApproachBars(sig.symbol, sig.direction, sig.ts);
  const clusterN     = clusterCount(sig.symbol, sig.direction, sig.entry, sig.ts);
  const opening      = isOpeningPeriod(sig.ts);

  const ns = newScore(
    parsed.aggressionPct, parsed.durationMs, parsed.trendAligned,
    approachBars, clusterN, opening,
  );

  const meta = JSON.stringify({
    scoringVersion: 'v2',
    speedScore: speedScore(parsed.durationMs),
    purityScore: purityScore(parsed.aggressionPct),
    approachBars,
    clusterN,
    opening,
    oldScore: sig.score,
  });

  // Also patch score inside payload JSON so classifySignalQuality reads the new value
  const updatedPayload = db.prepare(`SELECT payload FROM signals WHERE id=?`).get(sig.id) as { payload: string };
  let payloadObj: Record<string, unknown> = {};
  try { payloadObj = JSON.parse(updatedPayload.payload); } catch { /* keep empty */ }
  payloadObj['score'] = ns;
  updateStmt.run(ns, meta, JSON.stringify(payloadObj), sig.id);
  updated++;

  const band = ns >= 80 ? '80+' : ns >= 70 ? '70-79' : ns >= 60 ? '60-69' : ns >= 50 ? '50-59' : '<50';
  dist[band] = (dist[band] ?? 0) + 1;
  comparison.push({ old: sig.score, new: ns, conv: '' });
}

db.close();

console.log(`Updated: ${updated}  Skipped: ${skipped}\n`);
console.log('New score distribution:');
for (const [band, count] of Object.entries(dist).sort()) {
  console.log(`  ${band}: ${count}`);
}

// Show shift in distribution
const oldDist: Record<string, number> = {};
const newDist: Record<string, number> = {};
for (const c of comparison) {
  const ob = c.old >= 80?'80+': c.old>=70?'70-79': c.old>=60?'60-69': c.old>=50?'50-59':'<50';
  const nb = c.new >= 80?'80+': c.new>=70?'70-79': c.new>=60?'60-69': c.new>=50?'50-59':'<50';
  oldDist[ob] = (oldDist[ob] ?? 0) + 1;
  newDist[nb] = (newDist[nb] ?? 0) + 1;
}
console.log('\nBand comparison (old → new):');
for (const band of ['<50','50-59','60-69','70-79','80+']) {
  const o = oldDist[band] ?? 0;
  const n = newDist[band] ?? 0;
  if (o || n) console.log(`  ${band}: ${o} → ${n}`);
}

// Score shift summary
const shifts = comparison.map(c => c.new - c.old);
const avg = (shifts.reduce((a,b) => a+b, 0) / shifts.length).toFixed(1);
const up   = shifts.filter(s => s > 0).length;
const down = shifts.filter(s => s < 0).length;
const same = shifts.filter(s => s === 0).length;
console.log(`\nScore shift: avg ${avg}pts  up=${up}  down=${down}  unchanged=${same}`);
