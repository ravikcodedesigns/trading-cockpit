// Strategy J (TRAP) performance report
// For each signal: T1=+20, T2=+40 for longs; T1=-20, T2=-40 for shorts
// Outcome = first to hit: T1, T2, or STOP within 60 min of signal

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const tradingDb = new Database(TRADING_DB, { readonly: true });
const ticksDb   = new Database(TICKS_DB,   { readonly: true });

const LOOKFORWARD_MS = 60 * 60_000; // 60 min

// Deduplicate: one signal per (ts, symbol, direction)
const raw = tradingDb.prepare(
  "SELECT ts, symbol, direction, payload FROM signals WHERE rule_id='trap' ORDER BY ts ASC"
).all() as { ts: number; symbol: string; direction: string; payload: string }[];

const seen = new Set<string>();
const signals = raw.filter(r => {
  const k = `${r.ts}:${r.symbol}:${r.direction}`;
  if (seen.has(k)) return false;
  seen.add(k); return true;
});

console.log(`\n=== TRAP Signal Performance Report ===`);
console.log(`Signals (unique): ${signals.length}\n`);

const fmt = (ts: number) =>
  new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

let wins = 0, losses = 0, open = 0;
const rows: string[] = [];

for (const sig of signals) {
  const p = JSON.parse(sig.payload) as any;
  const dir       = sig.direction as 'long' | 'short';
  const entry     = p.entry    as number;
  const stop      = p.stopLevel as number;
  const t1        = dir === 'long' ? entry + 20 : entry - 20;
  const t2        = dir === 'long' ? entry + 40 : entry - 40;
  const stopDist  = p.stopDist as number;
  const sigTs     = sig.ts; // minute-floor ts

  // Pull ticks for this symbol in the 60 min after signal
  const ticks = ticksDb.prepare(
    `SELECT ts, price FROM trades WHERE symbol = ? AND ts > ? AND ts <= ? ORDER BY ts ASC`
  ).all(sig.symbol, sigTs, sigTs + LOOKFORWARD_MS) as { ts: number; price: number }[];

  let outcome = 'OPEN';
  let exitTs = 0;
  let exitPrice = 0;
  let mae = 0; // max adverse excursion (pts against entry)
  let mfe = 0; // max favorable excursion

  for (const t of ticks) {
    const excursion = dir === 'long' ? t.price - entry : entry - t.price;
    const adverse   = dir === 'long' ? entry - t.price : t.price - entry;
    if (adverse > mae) mae = adverse;
    if (excursion > mfe) mfe = excursion;

    if (dir === 'long') {
      if (t.price <= stop)  { outcome = 'STOP';  exitTs = t.ts; exitPrice = t.price; break; }
      if (t.price >= t2)    { outcome = 'T2';    exitTs = t.ts; exitPrice = t.price; break; }
      if (t.price >= t1)    { outcome = 'T1';    exitTs = t.ts; exitPrice = t.price; break; }
    } else {
      if (t.price >= stop)  { outcome = 'STOP';  exitTs = t.ts; exitPrice = t.price; break; }
      if (t.price <= t2)    { outcome = 'T2';    exitTs = t.ts; exitPrice = t.price; break; }
      if (t.price <= t1)    { outcome = 'T1';    exitTs = t.ts; exitPrice = t.price; break; }
    }
  }

  if (outcome === 'OPEN') open++;
  else if (outcome === 'STOP') losses++;
  else wins++;

  const pnl = outcome === 'STOP' ? -stopDist :
              outcome === 'T2'   ? (dir === 'long' ? 40 : 40) :
              outcome === 'T1'   ? 20 :
              (dir === 'long' ? exitPrice - entry : entry - exitPrice);

  const durationMin = exitTs > 0 ? Math.round((exitTs - sigTs) / 60_000) : null;

  rows.push(
    `${fmt(sigTs)}  ${sig.symbol.padEnd(2)} ${dir.padEnd(5)}  ` +
    `entry=${entry.toFixed(2).padStart(9)}  stop=${stop.toFixed(2).padStart(9)}  ` +
    `T1=${t1.toFixed(2).padStart(9)}  ` +
    `cvd15=${String(p.cvd15).padStart(6)}  spike=${String(p.spikeDelta).padStart(5)}  rec=${String(p.recoveryDelta).padStart(4)}  ` +
    `score=${p.score}  ` +
    `=> ${outcome.padEnd(4)}  pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}  ` +
    `mae=${mae.toFixed(1)}  mfe=${mfe.toFixed(1)}` +
    (durationMin !== null ? `  t=${durationMin}m` : '  t=OPEN')
  );
}

for (const r of rows) console.log(r);

const total = wins + losses;
console.log(`\n--- Summary ---`);
console.log(`Total signals: ${signals.length}  (unique)`);
console.log(`Resolved: ${total}  Open: ${open}`);
if (total > 0) {
  console.log(`Win rate (T1+T2 hit): ${wins}/${total} = ${(wins/total*100).toFixed(0)}%`);
  console.log(`Wins: ${wins}  Losses: ${losses}`);
}

tradingDb.close();
ticksDb.close();
