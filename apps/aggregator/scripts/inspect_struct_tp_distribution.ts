// Diagnostic: for each qualified FLIP/CONT, show the structural-TP distance
// distribution + verify "TPs are mostly 20-30pt" assumption.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const REPO_ROOT = path.resolve(__dirname, '../../..');

interface LevelEntry { price: number; label: string; }
interface DayLevels { NQ: LevelEntry[]; ES: LevelEntry[]; }
const allDayLevels = new Map<string, DayLevels>();
function loadLevelsFile(file: string) {
  if (!fs.existsSync(file)) return;
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as any;
  for (const [date, day] of Object.entries(data.days ?? {})) {
    const d = day as any;
    const existing = allDayLevels.get(date) ?? { NQ: [], ES: [] };
    for (const block of d.levels ?? []) {
      const sym = block.symbol as 'NQ' | 'ES';
      const arr = existing[sym];
      if (block.hedgePressure) arr.push({ price: block.hedgePressure, label: 'HP' });
      if (block.mhp)           arr.push({ price: block.mhp, label: 'MHP' });
      if (block.ddBands?.upper) arr.push({ price: block.ddBands.upper, label: 'DD↑' });
      if (block.ddBands?.lower) arr.push({ price: block.ddBands.lower, label: 'DD↓' });
      if (block.bullZone?.low)  arr.push({ price: block.bullZone.low,  label: 'BullL' });
      if (block.bullZone?.high) arr.push({ price: block.bullZone.high, label: 'BullH' });
      if (block.bearZone?.low)  arr.push({ price: block.bearZone.low,  label: 'BearL' });
      if (block.bearZone?.high) arr.push({ price: block.bearZone.high, label: 'BearH' });
      for (const lvl of block.additionalLevels ?? []) {
        if (typeof lvl.price === 'number') arr.push({ price: lvl.price, label: lvl.label });
      }
      existing[sym] = arr;
    }
    allDayLevels.set(date, existing);
  }
}
loadLevelsFile(path.join(REPO_ROOT, 'daily_levels.json'));
loadLevelsFile(path.join(REPO_ROOT, 'daily_levels_es.json'));

const fmtEtDate = (tsMs: number) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = p.split('/');
  return `${yyyy}-${mm}-${dd}`;
};

function nearestStructTp(symbol: 'NQ'|'ES', etDate: string, entry: number, direction: 'long'|'short', minPt: number, maxPt: number): { distPts: number; label: string } | null {
  const day = allDayLevels.get(etDate);
  if (!day) return null;
  const levels = day[symbol];
  if (!levels || levels.length === 0) return null;
  let best: { distPts: number; label: string } | null = null;
  for (const lvl of levels) {
    const distPts = direction === 'long' ? lvl.price - entry : entry - lvl.price;
    if (distPts < minPt || distPts > maxPt) continue;
    if (!best || distPts < best.distPts) best = { distPts, label: lvl.label };
  }
  return best;
}

interface Sig { signal_id: number; ts: number; symbol: 'NQ'|'ES'; rule_id: string; direction: 'long'|'short'; entry: number; sim_pnl_pts: number; }
const sigs = tradingDb.prepare(`
  SELECT s.id AS signal_id, s.ts, s.symbol, s.rule_id, s.direction,
         CAST(json_extract(s.payload, '$.entry') AS REAL) AS entry,
         t.sim_pnl_pts
  FROM signals s
  JOIN tradable_signals t ON t.signal_id = s.id
  WHERE s.rule_id IN ('clean-impulse','cont-reentry') AND s.symbol = 'NQ'
    AND t.qualified = 1 AND t.sim_pnl_pts IS NOT NULL
    AND CAST(json_extract(s.payload, '$.entry') AS REAL) IS NOT NULL
  ORDER BY s.ts ASC
`).all() as Sig[];

console.log(`\n══ Structural-TP distribution for ${sigs.length} simulated FLIP/CONT trades ══\n`);

const tpBuckets = new Map<string, { count: number; wins: number; losses: number }>();
const tpDistances: number[] = [];
const fellBack: number[] = [];
const usedLabels = new Map<string, number>();

for (const s of sigs) {
  const tp = nearestStructTp(s.symbol, fmtEtDate(s.ts), s.entry, s.direction, 20, 200);
  if (tp == null) { fellBack.push(s.signal_id); continue; }
  tpDistances.push(tp.distPts);
  usedLabels.set(tp.label, (usedLabels.get(tp.label) ?? 0) + 1);
  const bucket = tp.distPts < 30 ? '20-30' :
                 tp.distPts < 40 ? '30-40' :
                 tp.distPts < 50 ? '40-50' :
                 tp.distPts < 60 ? '50-60' :
                 tp.distPts < 80 ? '60-80' :
                 tp.distPts < 100 ? '80-100' :
                 tp.distPts < 150 ? '100-150' :
                 '150-200';
  const b = tpBuckets.get(bucket) ?? { count: 0, wins: 0, losses: 0 };
  b.count++;
  if (s.sim_pnl_pts > 0) b.wins++;
  else if (s.sim_pnl_pts < 0) b.losses++;
  tpBuckets.set(bucket, b);
}

console.log(`Fell back to 80pt (no level in 20-200 range): ${fellBack.length} / ${sigs.length}`);
console.log(`Got structural TP:                            ${sigs.length - fellBack.length} / ${sigs.length}\n`);

console.log(`Distribution of structural-TP distances:`);
console.log(`  min   : ${Math.min(...tpDistances).toFixed(1)}pt`);
console.log(`  max   : ${Math.max(...tpDistances).toFixed(1)}pt`);
console.log(`  median: ${tpDistances.sort((a,b)=>a-b)[Math.floor(tpDistances.length/2)]!.toFixed(1)}pt`);
console.log(`  mean  : ${(tpDistances.reduce((a,b)=>a+b,0)/tpDistances.length).toFixed(1)}pt`);

console.log(`\nBy distance bucket (structural TP only — fallback excluded):`);
console.log(`  bucket    n      W      L      WR`);
for (const bucket of ['20-30','30-40','40-50','50-60','60-80','80-100','100-150','150-200']) {
  const b = tpBuckets.get(bucket);
  if (!b) continue;
  const wr = (b.wins + b.losses) ? (100 * b.wins / (b.wins + b.losses)).toFixed(1) : '—';
  console.log(`  ${bucket.padEnd(8)} ${String(b.count).padStart(3)}    ${String(b.wins).padStart(3)}    ${String(b.losses).padStart(3)}    ${wr}%`);
}

console.log(`\nWhich level labels were the nearest (TP picked):`);
const sortedLabels = [...usedLabels.entries()].sort((a,b) => b[1] - a[1]);
for (const [label, count] of sortedLabels) console.log(`  ${label.padEnd(12)} ${count}`);
