// Independent verification of structural levels (PDH/PDL/PDC/ONH/ONL/ONO/POC/VAH/VAL)
// Reads ticks.db trades table directly (same data source as compute_structural_levels.ts).

import Database from 'better-sqlite3';

const ticksDb = new Database('/Users/ravikumarbasker/trading-cockpit/data/ticks.db', { readonly: true });

function etDateTimeToMs(dateStr: string, hh: number, mm: number): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  // June 2026 is EDT (UTC-4). Add 4h to ET.
  return Date.UTC(y!, m! - 1, d!, hh + 4, mm);
}

for (const symbol of ['NQ', 'ES']) {
  console.log(`\n══ ${symbol} ══`);

  // Prior day RTH: 2026-06-03 09:30 → 16:00 ET
  const pdStart = etDateTimeToMs('2026-06-03', 9, 30);
  const pdEnd   = etDateTimeToMs('2026-06-03', 16, 0);
  const pd = ticksDb.prepare(`SELECT MAX(price) AS hi, MIN(price) AS lo, COUNT(*) AS n FROM trades WHERE symbol=? AND ts>=? AND ts<?`).get(symbol, pdStart, pdEnd) as any;
  const pdc = (ticksDb.prepare(`SELECT price FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts DESC LIMIT 1`).get(symbol, pdStart, pdEnd) as any)?.price;
  console.log(`PDH=${pd.hi}  PDL=${pd.lo}  PDC=${pdc}  (n=${pd.n} ticks)`);

  // Overnight: 2026-06-03 18:00 → 2026-06-04 09:30 ET
  const onStart = etDateTimeToMs('2026-06-03', 18, 0);
  const onEnd   = etDateTimeToMs('2026-06-04', 9, 30);
  const on = ticksDb.prepare(`SELECT MAX(price) AS hi, MIN(price) AS lo, COUNT(*) AS n FROM trades WHERE symbol=? AND ts>=? AND ts<?`).get(symbol, onStart, onEnd) as any;
  const ono = (ticksDb.prepare(`SELECT price FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts ASC LIMIT 1`).get(symbol, onStart, onEnd) as any)?.price;
  console.log(`ONH=${on.hi}  ONL=${on.lo}  ONO=${ono}  (n=${on.n} ticks)`);

  // Volume profile on prior RTH
  const TICK = 0.25;
  const rows = ticksDb.prepare(`SELECT price, size FROM trades WHERE symbol=? AND ts>=? AND ts<?`).all(symbol, pdStart, pdEnd) as Array<{ price: number; size: number }>;
  const profile = new Map<number, number>();
  for (const r of rows) {
    const px = Math.round(r.price / TICK) * TICK;
    profile.set(px, (profile.get(px) ?? 0) + r.size);
  }
  const totalVol = Array.from(profile.values()).reduce((s, v) => s + v, 0);
  const sorted = Array.from(profile.entries()).sort((a, b) => b[1] - a[1]);
  const poc = sorted.length ? sorted[0]![0] : 0;
  const va = totalVol * 0.7;
  let lo = poc, hi = poc, covered = profile.get(poc) ?? 0;
  while (covered < va) {
    const upPx = parseFloat((hi + TICK).toFixed(2));
    const dnPx = parseFloat((lo - TICK).toFixed(2));
    const upV = profile.get(upPx) ?? 0;
    const dnV = profile.get(dnPx) ?? 0;
    if (!profile.has(upPx) && !profile.has(dnPx)) break;
    if (upV >= dnV) { hi = upPx; covered += upV; }
    else            { lo = dnPx; covered += dnV; }
  }
  console.log(`POC=${poc}  VAH=${hi}  VAL=${lo}  totalVol=${totalVol}`);
}
