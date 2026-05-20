import Database from 'better-sqlite3';

const tradingDb = new Database('/Users/ravikumarbasker/trading-cockpit/data/trading.db', { readonly: true });
const ticksDb   = new Database('/Users/ravikumarbasker/trading-cockpit/data/ticks.db',   { readonly: true });

const signals = tradingDb.prepare(`
  SELECT ts, score, direction,
    json_extract(payload,'$.entry') as entry
  FROM signals
  WHERE rule_id='absorption' AND symbol='NQ'
    AND rule_version='absorption-v2'
    AND json_extract(payload,'$.entry') IS NOT NULL
  ORDER BY ts
`).all();

console.log(`absorption-v2 signals with entry: ${signals.length}`);

const getTicks = ticksDb.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol='NQ' AND ts >= ? AND ts <= ?
  ORDER BY ts ASC
`);

tradingDb.close();

function scoreBand(score) {
  if (score >= 90) return '90+';
  if (score >= 80) return '80-89';
  if (score >= 70) return '70-79';
  if (score >= 60) return '60-69';
  if (score >= 50) return '50-59';
  return '<50';
}

const buckets = {};
const init = () => ({
  wins: 0, fails: 0, open: 0,
  winMaxGains: [], winDdBefore: [],
  failMaxGains: [], failMaxDd: [],
});

for (const sig of signals) {
  const fireTs = sig.ts + 60000;
  const endTs  = fireTs + 4 * 60 * 60 * 1000;
  const band   = scoreBand(sig.score);
  if (!buckets[band]) buckets[band] = init();

  const ticks = getTicks.all(fireTs, endTs);
  if (ticks.length === 0) { buckets[band].open++; continue; }

  const isLong = sig.direction === 'long';
  let maxGain = 0, maxDd = 0, ddAtWin = null, winTs = null, ddTs = null;

  for (const t of ticks) {
    const pnl = isLong ? t.price - sig.entry : sig.entry - t.price;
    const dd  = isLong ? sig.entry - t.price : t.price - sig.entry;

    if (dd > maxDd)   maxDd   = dd;
    if (pnl > maxGain) maxGain = pnl;

    if (pnl >= 40 && winTs === null) {
      winTs   = t.ts;
      ddAtWin = maxDd;
    }
    if (dd >= 20 && ddTs === null) ddTs = t.ts;

    if (winTs !== null && ddTs !== null) break;
    if (winTs !== null && dd >= 20)      break;
  }

  let outcome;
  if (!winTs && !ddTs)              outcome = 'open';
  else if (!winTs)                  outcome = 'fail';
  else if (!ddTs || winTs <= ddTs)  outcome = 'win';
  else                              outcome = 'fail';

  const b = buckets[band];
  if (outcome === 'win') {
    b.wins++;
    b.winMaxGains.push(maxGain);
    b.winDdBefore.push(ddAtWin ?? 0);
  } else if (outcome === 'fail') {
    b.fails++;
    b.failMaxGains.push(maxGain);
    b.failMaxDd.push(maxDd);
  } else {
    b.open++;
  }
}

ticksDb.close();

const avg = arr => arr.length === 0 ? '   -' : (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1).padStart(6);
const mx  = arr => arr.length === 0 ? '   -' : Math.max(...arr).toFixed(1).padStart(6);

const ORDER = ['90+','80-89','70-79','60-69','50-59','<50'];

console.log('\n=== ABSORPTION NQ v2 scoring — T1=+40pts, Stop=20pts, window=4h ===');
console.log('');
console.log('Band     n     Win rate      MaxGain(W)  AvgDD→win  MaxDD→win   MaxGain(F)  AvgDD(F)  MaxDD(F)');
console.log('------------------------------------------------------------------------------------------------');

for (const band of ORDER) {
  const b = buckets[band];
  if (!b) continue;
  const closed = b.wins + b.fails;
  const n = closed + b.open;
  if (n === 0) continue;
  const wr = closed === 0 ? 'n/a' : `${b.wins}/${closed} (${Math.round(b.wins/closed*100)}%)`;

  console.log(
    `${band.padEnd(7)}  ${String(n).padStart(4)}  ${wr.padEnd(14)}` +
    `  ${mx(b.winMaxGains)}` +
    `  ${avg(b.winDdBefore)}` +
    `  ${mx(b.winDdBefore)}` +
    `  ${mx(b.failMaxGains)}` +
    `  ${avg(b.failMaxDd)}` +
    `  ${mx(b.failMaxDd)}`
  );
}
