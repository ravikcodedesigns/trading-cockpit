// l3-trade-resolve — score the engine→L3 decisions for the shadow week. For each
// decision, walk the ENGINE thesis direction forward to a fixed bracket (NQ 40/40,
// ES 10/10) → engine_outcome (what the framework call alone would have done), and
// decision_outcome (TAKE → that outcome; SKIP → no trade). The comparison shows
// EXACTLY what the L3 confirmation layer adds: of the engine calls L3 vetoed, how
// many were losers (saved) vs winners (missed). WIN/LOSS only, no MFE/MAE. No orders.
//   pnpm --filter @trading/aggregator exec tsx scripts/l3-trade-resolve.ts
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const sh = new Database(path.join(ROOT, 'data', 'l3-shadow.db'));
const tk = new Database(path.join(ROOT, 'data', 'ticks.db'), { readonly: true, fileMustExist: true });

const BRACKET: Record<string, number> = { NQ: Number(process.env.NQ_BRACKET ?? 40), ES: Number(process.env.ES_BRACKET ?? 10) };
const WIN_MS = Number(process.env.RESOLVE_WINDOW_MIN ?? 30) * 60000;
const now = Date.now();

const cross = (sym: string, after: number, price: number, dir: '>=' | '<=') =>
  (tk.prepare(`SELECT MIN(ts) t FROM trades WHERE symbol=? AND ts>? AND price ${dir} ?`).get(sym, after, price) as { t: number | null }).t;

const rows = sh.prepare(
  `SELECT id, ts_ms, symbol, price, direction, verdict FROM l3_trade_decisions
   WHERE engine_outcome IS NULL AND ts_ms + ? <= ?`,
).all(WIN_MS, now) as any[];

const upd = sh.prepare(
  `UPDATE l3_trade_decisions SET engine_outcome=@eo, decision_outcome=@do, engine_pnl_pts=@pnl,
   exit_ts_ms=@ex, resolved_at=@ra WHERE id=@id`,
);

for (const r of rows) {
  const b = BRACKET[r.symbol] ?? 40;
  const long = r.direction === 'long';
  const tp = long ? r.price + b : r.price - b;
  const sl = long ? r.price - b : r.price + b;
  const tpTs = cross(r.symbol, r.ts_ms, tp, long ? '>=' : '<=');
  const slTs = cross(r.symbol, r.ts_ms, sl, long ? '<=' : '>=');
  let eo: string, pnl: number, ex: number;
  if (tpTs && (slTs == null || tpTs < slTs)) { eo = 'WIN'; pnl = b; ex = tpTs; }
  else if (slTs) { eo = 'LOSS'; pnl = -b; ex = slTs; }
  else { eo = 'OPEN'; pnl = 0; ex = r.ts_ms + WIN_MS; }
  upd.run({ id: r.id, eo, do: r.verdict === 'take' ? eo : 'SKIP', pnl, ex, ra: now });
}

// ── engine-alone vs engine+L3 comparison (all resolved rows) ──
const q = (sql: string) => (sh.prepare(sql).get() as any);
const takeW = q("SELECT COUNT(*) n FROM l3_trade_decisions WHERE verdict='take' AND engine_outcome='WIN'").n;
const takeL = q("SELECT COUNT(*) n FROM l3_trade_decisions WHERE verdict='take' AND engine_outcome='LOSS'").n;
const skipSaved = q("SELECT COUNT(*) n FROM l3_trade_decisions WHERE verdict='skip' AND engine_outcome='LOSS'").n;
const skipMissed = q("SELECT COUNT(*) n FROM l3_trade_decisions WHERE verdict='skip' AND engine_outcome='WIN'").n;
const engW = q("SELECT COUNT(*) n FROM l3_trade_decisions WHERE engine_outcome='WIN'").n;
const engL = q("SELECT COUNT(*) n FROM l3_trade_decisions WHERE engine_outcome='LOSS'").n;
const wr = (w: number, l: number) => (w + l ? Math.round((100 * w) / (w + l)) : 0);
console.log(`resolved ${rows.length} new.`);
console.log(`ENGINE-ALONE:   ${engW}W/${engL}L  (${wr(engW, engL)}% WR)`);
console.log(`ENGINE+L3 TAKE: ${takeW}W/${takeL}L  (${wr(takeW, takeL)}% WR)   ← what we'd have traded`);
console.log(`L3 SKIPS:       saved ${skipSaved} losers, missed ${skipMissed} winners   ← what L3 vetoed`);
