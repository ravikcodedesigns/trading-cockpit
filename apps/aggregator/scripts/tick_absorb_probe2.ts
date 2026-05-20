import Database from 'better-sqlite3';

const ticksDb  = new Database('../../data/ticks.db', { readonly: true });
const tradingDb = new Database('../../data/trading.db', { readonly: true });

const fmt = (ts: number) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date(ts));

// Missed moves within tick data range (May 4+), with bar-level context
const missed = [
  { date: '2026-05-04', et: '11:23', dir: 'short', mag: 129, cD15:  5891, trigD:    83 },
  { date: '2026-05-04', et: '12:09', dir: 'long',  mag:  82, cD15:  5578, trigD: -1086 },
  { date: '2026-05-04', et: '13:12', dir: 'long',  mag:  69, cD15: -2523, trigD:   273 },
  { date: '2026-05-04', et: '13:38', dir: 'long',  mag:  53, cD15:  2516, trigD:  -318 },
  { date: '2026-05-04', et: '14:46', dir: 'long',  mag:  64, cD15:  1813, trigD:  -450 },
  { date: '2026-05-07', et: '11:27', dir: 'short', mag: 156, cD15:  2479, trigD:  -673 },
  { date: '2026-05-07', et: '13:21', dir: 'long',  mag:  79, cD15:  2253, trigD:  -866 },
  { date: '2026-05-07', et: '14:51', dir: 'long',  mag:  50, cD15:  2547, trigD:  -715 },
  { date: '2026-05-11', et: '11:31', dir: 'long',  mag:  59, cD15: -5060, trigD:   908 },
  { date: '2026-05-11', et: '12:45', dir: 'short', mag:  47, cD15:  4389, trigD:  -324 },
  { date: '2026-05-13', et: '11:45', dir: 'long',  mag:  85, cD15: -3732, trigD:   721 },
  { date: '2026-05-14', et: '11:18', dir: 'long',  mag:  89, cD15: -5197, trigD:    -1 },
  { date: '2026-05-15', et: '10:24', dir: 'short', mag:  97, cD15: -5755, trigD:  2087 },
];

// For each, look at 30s tick buckets from -2min to +5min around the bar
for (const m of missed) {
  const barTs = Date.parse(`${m.date}T${m.et}:00-04:00`);

  const from = barTs - 2 * 60_000;
  const to   = barTs + 6 * 60_000;

  const ticks = ticksDb.prepare(`
    SELECT ts, price, size, is_bid_aggressor
    FROM trades WHERE symbol='NQ' AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(from, to) as any[];

  process.stdout.write(`\n${'═'.repeat(85)}\n`);
  process.stdout.write(`${m.date} ${m.et} ET | ${m.dir.toUpperCase()} ${m.mag}pts | cD15=${m.cD15} trigD=${m.trigD}\n`);
  process.stdout.write(`${'═'.repeat(85)}\n`);

  if (ticks.length === 0) { process.stdout.write(`  NO TICKS IN RANGE\n`); continue; }

  // 30-second buckets
  const BUCKET = 30_000;
  const buckets = new Map<number, { bv: number; sv: number; lo: number; hi: number; n: number }>();
  for (const t of ticks) {
    const b = Math.floor(t.ts / BUCKET) * BUCKET;
    const cur = buckets.get(b) ?? { bv: 0, sv: 0, lo: t.price, hi: t.price, n: 0 };
    if (t.is_bid_aggressor === 1) cur.bv += t.size;
    else cur.sv += t.size;
    cur.lo = Math.min(cur.lo, t.price);
    cur.hi = Math.max(cur.hi, t.price);
    cur.n++;
    buckets.set(b, cur);
  }

  process.stdout.write(`  ${'Time'.padEnd(20)} ${'bVol'.padStart(6)} ${'sVol'.padStart(6)} ${'Δ'.padStart(7)} ${'cumΔ'.padStart(7)} ${'lo-hi range'.padStart(22)}\n`);
  process.stdout.write(`  ${'─'.repeat(72)}\n`);

  let cumD = 0;
  const sorted = Array.from(buckets.entries()).sort(([a], [b]) => a - b);

  for (const [bTs, b] of sorted) {
    const delta = b.bv - b.sv;
    cumD += delta;
    const isBar = bTs >= barTs && bTs < barTs + 60_000;
    const marker = isBar ? ' ← BAR' : '';
    process.stdout.write(`  ${fmt(bTs).padEnd(20)} ${b.bv.toString().padStart(6)} ${b.sv.toString().padStart(6)} ${delta.toString().padStart(7)} ${cumD.toString().padStart(7)} ${`${b.lo.toFixed(2)}-${b.hi.toFixed(2)}`.padStart(22)}${marker}\n`);
  }

  // Absorption metrics
  const barBuckets = sorted.filter(([t]) => t >= barTs && t < barTs + 60_000);
  const post2m     = sorted.filter(([t]) => t >= barTs + 60_000 && t < barTs + 3 * 60_000);
  const pre2m      = sorted.filter(([t]) => t < barTs);

  const preD   = pre2m.reduce((s, [,b]) => s + b.bv - b.sv, 0);
  const barD   = barBuckets.reduce((s, [,b]) => s + b.bv - b.sv, 0);
  const postD  = post2m.reduce((s, [,b]) => s + b.bv - b.sv, 0);
  const barLo  = barBuckets.reduce((lo, [,b]) => Math.min(lo, b.lo), Infinity);
  const barHi  = barBuckets.reduce((hi, [,b]) => Math.max(hi, b.hi), -Infinity);
  const postLo = post2m.reduce((lo, [,b]) => Math.min(lo, b.lo), Infinity);
  const postHi = post2m.reduce((hi, [,b]) => Math.max(hi, b.hi), -Infinity);
  const levelHeld = m.dir === 'long' ? postLo >= barLo - 3 : postHi <= barHi + 3;

  process.stdout.write(`\n  PRE-2m Δ=${preD}  BAR Δ=${barD}  POST-2m Δ=${postD}  barLo=${barLo} postLo=${postLo} levelHeld=${levelHeld}\n`);

  // Check absorption: opposing spike absorbed, then move in background direction
  const longAbsorb = m.dir === 'long' && barD < -50 && postD > 50 && levelHeld;
  const shortAbsorb = m.dir === 'short' && barD > 50 && postD < -50 && levelHeld;
  const absorbed = longAbsorb || shortAbsorb;
  process.stdout.write(`  Absorbed? ${absorbed}  (bar sold off=${barD < -50}, post recovered=${postD > 50 || postD < -50}, level held=${levelHeld})\n`);
}
