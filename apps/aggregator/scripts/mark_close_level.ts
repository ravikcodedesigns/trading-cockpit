// Marks "NQ Close" / "ES Close" levels at 4:00 PM ET RTH close on the daily_levels JSON files.
// Reads the last tick price <16:00 ET from ticks.db for each symbol.
//
// Usage:
//   pnpm --filter @trading/aggregator exec tsx scripts/mark_close_level.ts
//   pnpm --filter @trading/aggregator exec tsx scripts/mark_close_level.ts --date=2026-06-04
//
// Idempotent — re-running on the same day overwrites the existing "NQ Close"/"ES Close" entry.
//
// Schedule: weekdays at 16:05 local time. Example crontab line:
//   5 16 * * 1-5 cd ~/trading-cockpit && pnpm --filter @trading/aggregator exec tsx scripts/mark_close_level.ts >> ~/trading-cockpit/logs/close-level.log 2>&1

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const ticksDb = new Database('/Users/ravikumarbasker/trading-cockpit/data/ticks.db', { readonly: true });

// ── Date handling ───────────────────────────────────────────────────────────
function todayET(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function etDateTimeToMs(dateStr: string, hh: number, mm: number): number {
  // Determine EDT vs EST. EDT (UTC-4) runs roughly second Sunday of March to first Sunday of November.
  // For 2026-06: EDT. For 2026-01: EST. Use Intl to be safe by computing offset for that date.
  const [y, m, d] = dateStr.split('-').map(Number);
  // Build a UTC date at noon, then compute the offset for ET on that day.
  const probe = new Date(Date.UTC(y!, m! - 1, d!, 12, 0));
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' });
  const offsetStr = dtf.formatToParts(probe).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-4';
  const m2 = /GMT([+-]\d+)/.exec(offsetStr);
  const offsetHrs = m2 ? parseInt(m2[1]!, 10) : -4;
  return Date.UTC(y!, m! - 1, d!, hh - offsetHrs, mm);
}

// ── Parse --date= arg ──
const dateArg = process.argv.find(a => a.startsWith('--date='));
const targetDay = dateArg ? dateArg.split('=')[1]! : todayET();

// Sanity: don't run if it's a weekend (no RTH session)
const dow = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(targetDay + 'T12:00:00Z'));
if (dow === 'Sat' || dow === 'Sun') {
  console.log(`[mark_close_level] ${targetDay} is ${dow} — no RTH session. skipping.`);
  process.exit(0);
}

console.log(`[mark_close_level] target day: ${targetDay}  (${dow})`);

// ── Query last RTH tick for NQ + ES ──────────────────────────────────────────
const rthStart = etDateTimeToMs(targetDay, 9, 30);
const rthEnd   = etDateTimeToMs(targetDay, 16, 0);

function lastTick(symbol: string): { price: number; ts: number } | null {
  return ticksDb.prepare(
    `SELECT price, ts FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts DESC LIMIT 1`
  ).get(symbol, rthStart, rthEnd) as any;
}

const nqClose = lastTick('NQ');
const esClose = lastTick('ES');

if (!nqClose || !esClose) {
  console.error(`[mark_close_level] missing close data: NQ=${!!nqClose} ES=${!!esClose}. Aborting (try again later or pass --date= explicitly).`);
  process.exit(1);
}

console.log(`[mark_close_level] NQ close = ${nqClose.price}  ts=${new Date(nqClose.ts).toISOString()}`);
console.log(`[mark_close_level] ES close = ${esClose.price}  ts=${new Date(esClose.ts).toISOString()}`);

// ── Helper to upsert into a daily_levels JSON file ───────────────────────────
function upsertCloseLevel(filePath: string, symbol: string, day: string, price: number, label: string): void {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const dayBlock = raw.days?.[day];
  if (!dayBlock || !Array.isArray(dayBlock.levels)) {
    console.warn(`[mark_close_level] no day-block for ${day} in ${path.basename(filePath)} — skipping`);
    return;
  }
  const entry = dayBlock.levels.find((e: any) => e.symbol === symbol);
  if (!entry) {
    console.warn(`[mark_close_level] no ${symbol} entry in ${path.basename(filePath)}.days[${day}] — skipping`);
    return;
  }
  entry.additionalLevels = entry.additionalLevels ?? [];
  const existing = entry.additionalLevels.find((l: any) => l.label === label);
  if (existing) {
    existing.price = price;
    console.log(`[mark_close_level] updated existing ${label} → ${price} in ${path.basename(filePath)}`);
  } else {
    entry.additionalLevels.push({
      price, label,
      color: '#ffd700',          // gold, distinctive
      style: 'solid',
      width: 2,
    });
    entry.additionalLevels.sort((a: any, b: any) => b.price - a.price);
    console.log(`[mark_close_level] added ${label} @ ${price} to ${path.basename(filePath)}`);
  }
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));
}

// Write the close marker into TODAY's entry...
upsertCloseLevel('/Users/ravikumarbasker/trading-cockpit/daily_levels.json',     'NQ', targetDay, nqClose.price, 'NQ Close');
upsertCloseLevel('/Users/ravikumarbasker/trading-cockpit/daily_levels_es.json',  'ES', targetDay, esClose.price, 'ES Close');

// ...AND into TOMORROW's entry. After 16:00 ET, tradingDayFor() rolls the
// cockpit to the next session, so the close marker must exist in that day's
// block too. Skips silently if tomorrow's block isn't created yet (it should
// be, because the cron wrapper runs compute_structural_levels --date tomorrow
// FIRST, then this script).
function nextWeekday(dateStr: string): string {
  const dt = new Date(dateStr + 'T12:00:00Z');
  do {
    dt.setUTCDate(dt.getUTCDate() + 1);
  } while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6); // skip Sat/Sun
  return dt.toISOString().slice(0, 10);
}
const tomorrow = nextWeekday(targetDay);
upsertCloseLevel('/Users/ravikumarbasker/trading-cockpit/daily_levels.json',     'NQ', tomorrow, nqClose.price, 'NQ Close');
upsertCloseLevel('/Users/ravikumarbasker/trading-cockpit/daily_levels_es.json',  'ES', tomorrow, esClose.price, 'ES Close');

console.log(`[mark_close_level] done.`);
