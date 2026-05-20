// Probe tick-level data around the largest missed reversal/spike moves
// to understand what "absorption" looks like at the tick level.
import Database from 'better-sqlite3';

const ticksDb = new Database('../../data/ticks.db', { readonly: true });
const tradingDb = new Database('../../data/trading.db', { readonly: true });

const fmt = (ts: number) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date(ts));

// The 22 missed moves (bar onset timestamps from the audit)
// Using bar data to get exact timestamps
const bars = tradingDb.prepare(`
  SELECT ts,
         json_extract(payload,'$.high') as high,
         json_extract(payload,'$.low') as low,
         json_extract(payload,'$.close') as close,
         COALESCE(json_extract(payload,'$.buyVolume'),0) as bv,
         COALESCE(json_extract(payload,'$.sellVolume'),0) as sv
  FROM events WHERE source='bookmap' AND type='bar'
    AND json_extract(payload,'$.symbol')='NQ' AND json_extract(payload,'$.partial')=0
  ORDER BY ts ASC
`).all() as any[];

// Focus on the 5 biggest missed moves for pattern analysis
const bigMissed = [
  { approxET: '05/01 09:30', dir: 'long',  mag: 243 },
  { approxET: '04/30 12:58', dir: 'long',  mag: 139 },
  { approxET: '05/07 11:27', dir: 'short', mag: 156 },
  { approxET: '05/04 11:23', dir: 'short', mag: 129 },
  { approxET: '05/01 14:47', dir: 'long',  mag: 95  },
  { approxET: '05/04 12:09', dir: 'long',  mag: 82  },
];

function analyzeTickWindow(barTs: number, barClose: number, direction: string, mag: number): void {
  // Look at ticks from 2 min before the bar to 5 min after (the absorption window)
  const from = barTs - 2 * 60_000;
  const to   = barTs + 6 * 60_000;

  const ticks = ticksDb.prepare(`
    SELECT ts, price, size, is_bid_aggressor
    FROM trades
    WHERE symbol='NQ' AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(from, to) as any[];

  if (ticks.length === 0) { process.stdout.write(`  NO TICKS\n`); return; }

  // Bucket into 30-second windows
  const bucketMs = 30_000;
  const buckets = new Map<number, { buyVol: number; sellVol: number; minPrice: number; maxPrice: number; count: number }>();
  for (const t of ticks) {
    const b = Math.floor(t.ts / bucketMs) * bucketMs;
    const cur = buckets.get(b) ?? { buyVol: 0, sellVol: 0, minPrice: t.price, maxPrice: t.price, count: 0 };
    if (t.is_bid_aggressor === 1) cur.buyVol += t.size;
    else cur.sellVol += t.size;
    cur.minPrice = Math.min(cur.minPrice, t.price);
    cur.maxPrice = Math.max(cur.maxPrice, t.price);
    cur.count++;
    buckets.set(b, cur);
  }

  process.stdout.write(`  Total ticks: ${ticks.length}  Bar close: ${barClose}  Expected move: ${direction} ${mag}pts\n`);
  process.stdout.write(`  ${'Time'.padEnd(22)} ${'buyV'.padStart(6)} ${'sellV'.padStart(6)} ${'delta'.padStart(7)} ${'cumD'.padStart(7)} ${'lo-hi'.padStart(15)} ${'note'.padStart(15)}\n`);

  let cumDelta = 0;
  const barBucketStart = Math.floor(barTs / bucketMs) * bucketMs;
  const sortedBuckets = Array.from(buckets.entries()).sort(([a], [b]) => a - b);
  let spikeFound = false;
  let spikeDir = '';
  let spikeEnd = 0;
  let postSpikeRecovery = 0;

  for (const [bTs, b] of sortedBuckets) {
    const delta = b.buyVol - b.sellVol;
    cumDelta += delta;
    const isBarBucket = bTs >= barBucketStart && bTs < barBucketStart + 60_000;
    const isPreBar = bTs < barBucketStart;
    const isPostBar = bTs >= barBucketStart + 60_000;

    // Detect spike: net delta >= 150 in a 30s window (large directional pressure)
    let note = '';
    if (Math.abs(delta) >= 150) {
      const sDir = delta > 0 ? 'BUY-SPIKE' : 'SELL-SPIKE';
      note = sDir;
      if (!spikeFound && isBarBucket) {
        spikeFound = true;
        spikeDir = delta > 0 ? 'buy' : 'sell';
        spikeEnd = bTs + bucketMs;
      }
    }
    if (spikeFound && isPostBar && bTs === spikeEnd) {
      postSpikeRecovery = delta;
      note += ` ← recovery delta=${delta}`;
    }

    const marker = isBarBucket ? ' ← TRIGGER BAR' : (isPreBar ? '' : '');
    process.stdout.write(`  ${fmt(bTs).padEnd(22)} ${b.buyVol.toString().padStart(6)} ${b.sellVol.toString().padStart(6)} ${delta.toString().padStart(7)} ${cumDelta.toString().padStart(7)} ${`${b.minPrice.toFixed(2)}-${b.maxPrice.toFixed(2)}`.padStart(15)} ${(note+marker).padStart(30)}\n`);
  }

  // Absorption summary for this move
  // The absorption pattern for long: sell spike on trigger bar → buy volume recovers in next 30-60s
  const triggerBuckets = sortedBuckets.filter(([t]) => t >= barBucketStart && t < barBucketStart + 60_000);
  const postBuckets = sortedBuckets.filter(([t]) => t >= barBucketStart + 60_000 && t < barBucketStart + 3 * 60_000);

  const triggerDelta = triggerBuckets.reduce((s, [,b]) => s + b.buyVol - b.sellVol, 0);
  const post2mDelta = postBuckets.reduce((s, [,b]) => s + b.buyVol - b.sellVol, 0);
  const triggerLow = triggerBuckets.reduce((mn, [,b]) => Math.min(mn, b.minPrice), Infinity);
  const post2mLow  = postBuckets.reduce((mn, [,b]) => Math.min(mn, b.minPrice), Infinity);
  const holdingLow = post2mLow >= triggerLow - 5;

  process.stdout.write(`\n  ABSORPTION SUMMARY: triggerDelta=${triggerDelta} post2mDelta=${post2mDelta} triggerLow=${triggerLow} holdingLow=${holdingLow}\n`);
  const absorbed = direction === 'long'
    ? (triggerDelta < -100 && post2mDelta > 100 && holdingLow)
    : (triggerDelta > 100 && post2mDelta < -100);
  process.stdout.write(`  Pattern match (absorbed=${absorbed}): trigger ${direction==='long'?'sold':'bought'}, post-2m reversed, price held\n\n`);
}

// Match approximate timestamps to actual bar timestamps
for (const miss of bigMissed) {
  // Find the bar closest to the given time
  const [md, mtime] = miss.approxET.split(' ');
  const [month, day] = md!.split('/').map(Number);
  const [hour, min] = mtime!.split(':').map(Number);
  const year = 2026;
  const targetTs = Date.parse(`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:${String(min).padStart(2,'0')}:00-04:00`);
  const bar = bars.find(b => Math.abs(b.ts - targetTs) < 90_000);
  if (!bar) { process.stdout.write(`${miss.approxET}: NO BAR FOUND near ${targetTs}\n`); continue; }

  process.stdout.write(`\n${'═'.repeat(90)}\n`);
  process.stdout.write(`${miss.approxET} ET  |  ${miss.dir.toUpperCase()} ${miss.mag}pts  |  barTs=${fmt(bar.ts)}\n`);
  process.stdout.write(`${'═'.repeat(90)}\n`);
  analyzeTickWindow(bar.ts, bar.close, miss.dir, miss.mag);
}
