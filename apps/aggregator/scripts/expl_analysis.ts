import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });

interface RawSignal {
  id: number; ts: number; symbol: string; score: number;
  rangePct: number | null; zones: number;
}

const allSignals = db.prepare(`
  SELECT id, ts, symbol, score,
    CAST(json_extract(payload, '$.rangePct') AS REAL) AS rangePct,
    json_array_length(json_extract(payload, '$.stackedBidZones')) AS zones
  FROM signals
  WHERE rule_id = 'expl' AND direction = 'long'
  ORDER BY ts ASC
`).all() as RawSignal[];

console.log(`Total expl LONG signals: ${allSignals.length}`);

function isRTH(ts: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday) && min >= 570 && min < 960;
}

// Gold-tier quality gate (mirrors quality.ts logic):
//   - at least 1 stacked bid zone
//   - rangePct null/undefined (old signals before field existed) OR >= 0.5
function isGold(sig: RawSignal): boolean {
  if (!sig.zones || sig.zones === 0) return false;
  if (sig.rangePct !== null && sig.rangePct !== undefined && sig.rangePct < 0.5) return false;
  return true;
}

// Entry = first trade price at or after signal ts (the price the signal fired at)
const entryQuery = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol=? AND ts >= ? ORDER BY ts ASC LIMIT 1`
);
const fwdQuery = ticksDb.prepare(
  `SELECT price, ts FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`
);

const TARGETS = [20, 40, 60, 80, 100];
const WINDOW_MS = 240 * 60_000;  // 4h forward window

interface Result {
  id: number; ts: number; sym: string; zones: number; score: number; entry: number;
  hitAt: (number | null)[];   // time offset in minutes when target was first hit (null = not hit)
  ddAt:  (number | null)[];   // max DD (pts) accumulated before hitting each target
  maxGain: number; maxDD: number;
}

const results: Result[] = [];

for (const sig of allSignals) {
  if (!isRTH(sig.ts)) continue;
  const row = entryQuery.get(sig.symbol, sig.ts) as { price: number } | null;
  if (!row) continue;
  const entry = row.price;

  const fwd = fwdQuery.all(sig.symbol, sig.ts, sig.ts + WINDOW_MS) as { price: number; ts: number }[];

  const hitAt:  (number | null)[] = TARGETS.map(() => null);
  const ddAt:   (number | null)[] = TARGETS.map(() => null);
  let maxGain = 0, maxDD = 0, runDD = 0;

  for (const tick of fwd) {
    const g = tick.price - entry;
    const d = entry - tick.price;
    if (g > maxGain) maxGain = g;
    if (d > maxDD)   maxDD   = d;
    if (d > runDD)   runDD   = d;
    for (let i = 0; i < TARGETS.length; i++) {
      if (hitAt[i] === null && g >= TARGETS[i]) {
        hitAt[i] = (tick.ts - sig.ts) / 60_000;
        ddAt[i]  = runDD;
      }
    }
  }

  results.push({ id: sig.id, ts: sig.ts, sym: sig.symbol, zones: sig.zones, score: sig.score, entry, hitAt, ddAt, maxGain, maxDD });
}

console.log(`RTH signals with valid entry: ${results.length}\n`);

// ── table renderer ──────────────────────────────────────────────────────────

function tbl(subset: Result[], label: string) {
  const n = subset.length;
  const pct = (i: number) => {
    const h = subset.filter(r => r.hitAt[i] !== null).length;
    return `${(h / n * 100).toFixed(0)}%`.padStart(5);
  };
  const avgDD = (i: number) => {
    const v = subset.filter(r => r.hitAt[i] !== null).map(r => r.ddAt[i]!);
    return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1).padStart(6) : '   —  ';
  };
  const avgT = (i: number) => {
    const v = subset.filter(r => r.hitAt[i] !== null).map(r => r.hitAt[i]!);
    return v.length ? ((v.reduce((a, b) => a + b, 0) / v.length).toFixed(0) + 'm').padStart(6) : '   —  ';
  };
  process.stdout.write(
    `${label.padEnd(14)}` +
    `${String(n).padStart(4)}  ` +
    TARGETS.map((_, i) => pct(i)).join('') + '  ' +
    avgDD(0) + avgDD(1) + '  ' +
    avgT(0)  + avgT(1)  + '\n'
  );
}

const HDR = `${'Group'.padEnd(14)}${'n'.padStart(4)}  ` +
  TARGETS.map(t => `+${t}`.padStart(5)).join('') + '  ' +
  `${'DD@20'.padStart(6)}${'DD@40'.padStart(6)}  ${'T→20'.padStart(6)}${'T→40'.padStart(6)}`;
const SEP = '─'.repeat(HDR.length);

// ── ALL RTH signals ──────────────────────────────────────────────────────────

console.log('=== ALL RTH SIGNALS (no quality filter) ===');
console.log(HDR);
console.log(SEP);
for (const z of [5, 4, 3, 2, 1]) {
  const sub = results.filter(r => r.zones === z);
  if (sub.length) tbl(sub, `zones=${z}`);
}
tbl(results, 'ALL');

// ── GOLD TIER (quality gate applied) ─────────────────────────────────────────

const gold = results.filter(r => {
  const sig = allSignals.find(s => s.id === r.id)!;
  return isGold(sig);
});

console.log(`\n=== GOLD TIER (zones≥1, rangePct null or ≥0.50) — n=${gold.length} ===`);
console.log(HDR);
console.log(SEP);
for (const z of [5, 4, 3, 2, 1]) {
  const sub = gold.filter(r => r.zones === z);
  if (sub.length) tbl(sub, `zones=${z}`);
}
tbl(gold, 'ALL gold');

// ── BY SCORE ────────────────────────────────────────────────────────────────

console.log('\n=== ALL RTH — BY SCORE ===');
console.log(HDR);
console.log(SEP);
for (const s of [5, 4, 3]) {
  const sub = results.filter(r => r.score === s);
  if (sub.length) tbl(sub, `score=${s}`);
}

// ── PER-DAY DETAIL ──────────────────────────────────────────────────────────

console.log('\n=== GOLD — PER SIGNAL DETAIL ===');
console.log(`${'Date'.padEnd(6)} ${'Sym'.padEnd(3)} ${'Zn'} ${'Scr'} ${'Entry'.padStart(9)} ${'MaxG'.padStart(7)} ${'MaxDD'.padStart(7)}  ${TARGETS.map(t => `+${t}`).join('  ')}`);
console.log('─'.repeat(85));
for (const r of gold) {
  const etMin = (() => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(r.ts));
    return parseInt(p.find(x => x.type === 'hour')?.value ?? '0', 10) * 60 + parseInt(p.find(x => x.type === 'minute')?.value ?? '0', 10);
  })();
  const date = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit' }).format(new Date(r.ts));
  const hh = Math.floor(etMin / 60).toString().padStart(2, '0');
  const mm = (etMin % 60).toString().padStart(2, '0');
  const hits = TARGETS.map((_, i) => r.hitAt[i] !== null ? '  ✓ ' : '  ✗ ').join('');
  process.stdout.write(`${date} ${r.sym} ${String(r.zones).padStart(2)} ${String(r.score).padStart(3)} ${r.entry.toFixed(2).padStart(9)} ${('+'+r.maxGain.toFixed(0)).padStart(7)} ${('-'+r.maxDD.toFixed(0)).padStart(7)}  ${hits} (${hh}:${mm})\n`);
}

db.close();
ticksDb.close();
