import Database from 'better-sqlite3';
const db = new Database('../../data/ticks.db', { readonly: true });

const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as any[];
process.stdout.write('Tables: ' + tables.map(t => t.name).join(', ') + '\n');

const cols = db.prepare(`PRAGMA table_info(trades)`).all() as any[];
process.stdout.write('trades columns: ' + cols.map(c => `${c.name}(${c.type})`).join(', ') + '\n');

const range = db.prepare(`SELECT MIN(ts) as minTs, MAX(ts) as maxTs, COUNT(*) as n FROM trades WHERE symbol='NQ'`).get() as any;
process.stdout.write(`NQ ticks: n=${range.n}, min=${range.minTs}, max=${range.maxTs}\n`);
process.stdout.write(`Min date: ${new Date(range.minTs).toISOString()}\n`);
process.stdout.write(`Max date: ${new Date(range.maxTs).toISOString()}\n`);

const sample = db.prepare(`SELECT * FROM trades WHERE symbol='NQ' ORDER BY ts DESC LIMIT 3`).all() as any[];
sample.forEach(t => process.stdout.write(`  ts=${t.ts} (${new Date(t.ts).toISOString()}) price=${t.price} size=${t.size} bid_aggressor=${t.is_bid_aggressor}\n`));

// Check a specific window for the 04/30 12:57 move
const from = Date.parse('2026-04-30T16:55:00Z'); // 12:55 ET = 16:55 UTC
const to   = Date.parse('2026-04-30T17:05:00Z'); // 13:05 ET
const count = db.prepare(`SELECT COUNT(*) as n FROM trades WHERE symbol='NQ' AND ts >= ? AND ts <= ?`).get(from, to) as any;
process.stdout.write(`\nTicks in 12:55-13:05 ET on 04/30: ${count.n}\n`);
process.stdout.write(`Query window: ${from} to ${to}\n`);
