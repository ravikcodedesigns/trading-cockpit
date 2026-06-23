// l3-decision-resolve — walk each actionable l3 decision forward to a fixed bracket
// and record WIN/LOSS/OPEN, so the shadow week can be scored. NQ 40/40, ES 10/10 by
// default (override via env). Reads forward price from ticks.db (NQ=MNQ, ES=MES —
// same index value). Idempotent: only resolves rows with outcome NULL whose window
// has fully elapsed. Run post-close (or any time). Shadow eval only — no orders.
//
//   pnpm --filter @trading/aggregator exec tsx scripts/l3-decision-resolve.ts
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const sh = new Database(path.join(ROOT, 'data', 'l3-shadow.db'));
const tk = new Database(path.join(ROOT, 'data', 'ticks.db'), { readonly: true, fileMustExist: true });

const BRACKET: Record<string, number> = { NQ: Number(process.env.NQ_BRACKET ?? 40), ES: Number(process.env.ES_BRACKET ?? 10) };
const WIN_MS = Number(process.env.RESOLVE_WINDOW_MIN ?? 30) * 60000;
const PV: Record<string, number> = { NQ: 2, ES: 2 };  // points→$ (MNQ/MES, Ravi's contracts)

// inequality direction supplied as a SQL literal per call (long: TP above / SL below)
const cross = (sym: string, after: number, price: number, dir: '>=' | '<=') =>
  (tk.prepare(`SELECT MIN(ts) t FROM trades WHERE symbol=? AND ts>? AND price ${dir} ?`).get(sym, after, price) as { t: number | null }).t;

const lastBefore = tk.prepare('SELECT price FROM trades WHERE symbol=? AND ts<=? ORDER BY ts DESC LIMIT 1');

const now = Date.now();
const rows = sh.prepare(
  `SELECT id, ts_ms, symbol, level_label, level_price, price, action FROM l3_decisions
   WHERE action IN ('long','short') AND outcome IS NULL AND ts_ms + ? <= ?`,
).all(WIN_MS, now) as any[];

const upd = sh.prepare(
  `UPDATE l3_decisions SET outcome=@outcome, exit_price=@exit_price, exit_ts_ms=@exit_ts_ms, pnl_pts=@pnl_pts, resolved_at=@resolved_at WHERE id=@id`,
);

let win = 0, loss = 0, open = 0;
for (const r of rows) {
  const b = BRACKET[r.symbol] ?? 40;
  const entry = r.price;
  const tp = r.action === 'long' ? entry + b : entry - b;
  const sl = r.action === 'long' ? entry - b : entry + b;
  const tpTs = cross(r.symbol, r.ts_ms, tp, r.action === 'long' ? '>=' : '<=');
  const slTs = cross(r.symbol, r.ts_ms, sl, r.action === 'long' ? '<=' : '>=');
  let outcome: string, exitPrice: number, exitTs: number, pnl: number;
  if (tpTs && (slTs == null || tpTs < slTs)) { outcome = 'WIN'; exitPrice = tp; exitTs = tpTs; pnl = b; win++; }
  else if (slTs) { outcome = 'LOSS'; exitPrice = sl; exitTs = slTs; pnl = -b; loss++; }
  else {
    // neither hit in the window → mark at the window-end price (no MFE/MAE)
    const end = r.ts_ms + WIN_MS;
    const px = (lastBefore.get(r.symbol, end) as { price: number } | undefined)?.price ?? entry;
    outcome = 'OPEN'; exitPrice = px; exitTs = end; pnl = r.action === 'long' ? px - entry : entry - px; open++;
  }
  upd.run({ id: r.id, outcome, exit_price: +exitPrice.toFixed(2), exit_ts_ms: exitTs, pnl_pts: +pnl.toFixed(2), resolved_at: now });
}
console.log(`resolved ${rows.length} decisions: ${win} WIN / ${loss} LOSS / ${open} OPEN`);
