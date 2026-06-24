// Lightspeed L3 book worker — continuous, production.
//
// Tails the live full-size NQ + ES Bookmap .log, maintains an in-memory L3 order
// book per symbol, loads the RS levels for the current ET day (reloading until
// they appear ~09:32 ET), and — as price approaches each level — logs the live L3
// confluence snapshot to data/l3-shadow.db. Shadow only — NO orders.
//
// Designed to run under launchd KeepAlive, started well before RTH so the book
// seeds across the session. Follows the per-ET-day log rollover so the book stays
// continuous across midnight. Snapshots begin automatically once levels land.
//
//   pnpm --filter @trading/aggregator l3:worker
//
// Notes: depth ladder (L2) is ground truth (absolute, always complete). L3
// reconstruction converges as the book churns; the L2−L3 gap = implied/untracked
// liquidity (a signal, esp. for ES). No MFE/MAE — snapshots are point-in-time reads.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrderBook, priceFromInt } from '../src/l3/order-book.js';
import { tailLog, type LogEvent, type TailHandle } from '../src/l3/log-tailer.js';
import net from 'node:net';
// NOTE: the framework engines + confirmation live in the SEPARATE l3-decision-worker
// process so this builder (the in-memory book) is never restarted for decision-logic
// changes. This process only maintains the book + emits touch events.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const CAPTURE_DIR = path.join(os.homedir(), 'cockpit-mbo-capture');
const SHADOW_DB = path.join(ROOT, 'data', 'l3-shadow.db');
const SOCK_PATH = process.env.L3_TOUCH_SOCK || '/tmp/cockpit-l3-touch.sock';   // builder→decider push
const LEVEL_FILES: Record<string, string> = {
  NQ: path.join(ROOT, 'daily_levels.json'),
  ES: path.join(ROOT, 'daily_levels_es.json'),
};

const TICK = 0.25;
const intFromPrice = (p: number) => Math.round(p / TICK);

const NEAR_TICKS = Number(process.env.NEAR_TICKS ?? 16);   // snapshot/touch when price within ±N ticks of a level
const DECISION_REARM_TICKS = Number(process.env.DECISION_REARM_TICKS ?? 24); // price must leave ±N ticks to re-arm a level's decision
const WALL_TICKS = Number(process.env.WALL_TICKS ?? 4);    // sum depth within ±N ticks for the "wall"
const SNAP_THROTTLE_MS = 5000;   // at most one row per (symbol,level) per 5s while parked
const SNAP_LOOP_MS = 1000;
const HEALTH_MS = 30000;
const ROLL_CHECK_MS = 15000;
const LEVELS_RELOAD_MS = 60000;
const TAPE_WINDOW_MS = 30000;    // aggressor-flow lookback near a level

const ET = 'America/New_York';
const etDate = (ms = Date.now()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const etTime = (ms = Date.now()): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(ms);

// ── levels ───────────────────────────────────────────────────────────────────
interface RsLevel { label: string; price: number; kind: 'RS' | 'struct'; }

function loadLevels(symbol: string): RsLevel[] {
  const file = LEVEL_FILES[symbol];
  let j: any;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const entry = (j.days?.[etDate()]?.levels ?? []).find((l: any) => l.symbol === symbol);
  if (!entry) return [];
  const out: RsLevel[] = [];
  const push = (label: string, price: any, kind: 'RS' | 'struct' = 'RS') => {
    if (typeof price === 'number' && isFinite(price)) out.push({ label, price, kind });
  };
  push('MHP', entry.mhp);
  push('HP', entry.hedgePressure);
  if (entry.ddBands) { push('DDupper', entry.ddBands.upper); push('DDlower', entry.ddBands.lower); }
  // Watch EVERY bull/bear zone, not just the single "primary" (which rs-levels
  // picks by DD-mid proximity — wrong on a gap day when price is far from the DD
  // band). Only the zones near live price ever fire snapshots (±NEAR_TICKS gate),
  // so pushing all of them is safe and ensures the near-price BZB/BrZT are tracked.
  const bullZones = Array.isArray(entry.zones?.bull) ? entry.zones.bull : (entry.bullZone ? [entry.bullZone] : []);
  for (const z of bullZones) { push('BZB', z.low); if (z.high !== z.low) push('BZB_hi', z.high); }
  const bearZones = Array.isArray(entry.zones?.bear) ? entry.zones.bear : (entry.bearZone ? [entry.bearZone] : []);
  for (const z of bearZones) { push('BrZT', z.high); if (z.high !== z.low) push('BrZT_lo', z.low); }
  for (const a of entry.additionalLevels ?? []) push(a.label ?? 'lvl', a.price, 'struct');
  return out;
}

// ── db ─────────────────────────────────────────────────────────────────────
const db = new Database(SHADOW_DB);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS l3_level_snapshots (
  id INTEGER PRIMARY KEY,
  ts_ms INTEGER, ts_et TEXT, trading_day TEXT,
  symbol TEXT, level_label TEXT, level_kind TEXT, level_price REAL,
  price REAL, dist_ticks REAL, defend_side TEXT,
  l2_size INTEGER, l2_orders INTEGER, l3_size INTEGER, implied_gap INTEGER,
  best_bid REAL, best_ask REAL, spread REAL, cvd INTEGER,
  aggr_buy INTEGER, aggr_sell INTEGER, tape_prints INTEGER
)`);
const insSnap = db.prepare(`INSERT INTO l3_level_snapshots
  (ts_ms, ts_et, trading_day, symbol, level_label, level_kind, level_price,
   price, dist_ticks, defend_side, l2_size, l2_orders, l3_size, implied_gap,
   best_bid, best_ask, spread, cvd, aggr_buy, aggr_sell, tape_prints)
  VALUES (@ts_ms,@ts_et,@trading_day,@symbol,@level_label,@level_kind,@level_price,
   @price,@dist_ticks,@defend_side,@l2_size,@l2_orders,@l3_size,@implied_gap,
   @best_bid,@best_ask,@spread,@cvd,@aggr_buy,@aggr_sell,@tape_prints)`);

// TOUCH-EVENT QUEUE — one row per RS-level touch episode with the direction-agnostic
// live L3 read (both sides + cvd/sweep/cluster) computed from the in-memory book. The
// decision-worker consumes these (processed=0 → 1), runs the engines + confirmation,
// and writes l3_trade_decisions. Durable so a decision-worker restart loses nothing.
db.exec(`CREATE TABLE IF NOT EXISTS l3_touch_events (
  id INTEGER PRIMARY KEY,
  ts_ms INTEGER, ts_et TEXT, trading_day TEXT,
  symbol TEXT, level_label TEXT, level_kind TEXT, level_price REAL,
  mid REAL, dist_ticks REAL, l3_json TEXT,
  processed INTEGER DEFAULT 0
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_touch_unprocessed ON l3_touch_events(processed, id)');
const insTouch = db.prepare(`INSERT INTO l3_touch_events
  (ts_ms,ts_et,trading_day,symbol,level_label,level_kind,level_price,mid,dist_ticks,l3_json)
  VALUES (@ts_ms,@ts_et,@trading_day,@symbol,@level_label,@level_kind,@level_price,@mid,@dist_ticks,@l3_json)`);

// ── builder→decider PUSH: a UDS the decision-worker connects to; on each touch we
//    nudge it (1 byte) so it processes the new row instantly — no polling window. ──
const clients = new Set<net.Socket>();
try { fs.unlinkSync(SOCK_PATH); } catch { /* none */ }
const pushServer = net.createServer((sock) => {
  clients.add(sock);
  sock.on('close', () => clients.delete(sock));
  sock.on('error', () => clients.delete(sock));
});
pushServer.listen(SOCK_PATH, () => console.log(`touch-event push socket → ${SOCK_PATH}`));
const nudge = () => { for (const c of clients) { try { c.write('1'); } catch { /* dead */ } } };

// ── per-symbol state ─────────────────────────────────────────────────────────
interface SymState {
  sym: string;
  suffix: string;
  book: OrderBook;
  tail: TailHandle | null;
  logPath: string | null;
  levels: RsLevel[];
  lastSnap: Map<string, number>;
  snaps: number;
  inZone: Map<string, boolean>;       // per (label,price): is price currently in the touch band
  cvdHist: Array<[number, number]>;   // [ts, cvd] ring for the CVD-slope (cvd60)
  decisions: number;
}

function liveLog(suffix: string): string | null {
  let files: string[];
  try {
    files = fs.readdirSync(CAPTURE_DIR).filter((f) => f.includes(`-${suffix}_`) && f.endsWith('.log')).sort();
  } catch { return null; }
  return files.length ? path.join(CAPTURE_DIR, files[files.length - 1]) : null;
}

function dispatch(book: OrderBook, e: LogEvent): void {
  book.lastTs = e.ts_ms;
  const d = e.data;
  switch (e.kind) {
    case 'depth': book.applyDepth(d as any); break;
    case 'trade': book.applyTrade(d as any); break;
    case 'mbo_send': book.applySend(d as any); break;
    case 'mbo_replace': book.applyReplace(d as any); break;
    case 'mbo_cancel': book.applyCancel(d as any); break;
  }
}

/** Attach (first time) or follow the per-ET-day log rollover. */
function ensureTail(st: SymState): void {
  const latest = liveLog(st.suffix);
  if (!latest || latest === st.logPath) return;
  const firstAttach = st.logPath === null;
  if (st.tail) { st.tail.stop(); console.log(`[${st.sym}] roll → ${path.basename(latest)}`); }
  // first attach: live tail (EOF) to avoid a giant startup replay — seeding
  // accumulates over the hours to RTH. On roll: read the new file from start so
  // we don't miss the head of the new day (book state carries over either way).
  st.logPath = latest;
  st.tail = tailLog(latest, (e) => { dispatch(st.book, e); onTradeTouch(st, e); }, { fromStart: !firstAttach });
}

// CVD slope = book.cvd now minus its value ~60s ago (from the sampling ring).
function cvdSlope(st: SymState, now: number): number {
  const then = st.cvdHist.find(([t]) => t >= now - 60000);
  return then ? st.book.cvd - then[1] : 0;
}

// Emit ONE touch event per episode: compute the DIRECTION-AGNOSTIC live L3 read from
// the in-memory book (both sides + cvd/sweep/cluster), queue it, and nudge the decision-
// worker. The engines + confirmation run in that SEPARATE process — so restarting the
// decision logic never touches this book.
function emitTouch(st: SymState, lv: RsLevel, distTicks: number, mid: number, slope: number, now: number): void {
  const lvInt = intFromPrice(lv.price);
  const since = now - TAPE_WINDOW_MS;
  const sideRead = (side: 'bid' | 'ask') => {
    const w = st.book.depthNear(lvInt, WALL_TICKS, side);
    const l3 = st.book.l3Near(lvInt, WALL_TICKS, side);
    return {
      wall: w.size, l3, gap: Math.max(0, w.size - l3),
      ice: st.book.icebergsNear(lvInt, WALL_TICKS, side).count,
      synth: st.book.syntheticRefillsNear(lvInt, WALL_TICKS, since),
      pull: st.book.pullNear(lvInt, WALL_TICKS, side, since),
      adds: st.book.addsNear(lvInt, WALL_TICKS, side, since),
    };
  };
  let aggrBuy = 0, aggrSell = 0, executedNear = 0;
  for (const p of st.book.tapeNear(lvInt, NEAR_TICKS, since)) { executedNear += p.size; if (p.buy) aggrBuy += p.size; else aggrSell += p.size; }
  const sweep = st.book.sweepNear(lvInt, NEAR_TICKS, since);
  const cluster = st.book.aggressorClusterNear(lvInt, NEAR_TICKS, since);
  const l3 = {
    bid: sideRead('bid'), ask: sideRead('ask'),
    cvd: st.book.cvd, cvd60: Math.round(slope), aggrBuy, aggrSell, executedNear,
    sweep: { swept: sweep.swept, dir: sweep.dir, levels: sweep.levels, size: sweep.size },
    cluster: { dominance: +cluster.dominance.toFixed(3) },
  };
  insTouch.run({
    ts_ms: now, ts_et: etTime(now), trading_day: etDate(now),
    symbol: st.sym, level_label: lv.label, level_kind: lv.kind, level_price: lv.price,
    mid: +mid.toFixed(2), dist_ticks: distTicks, l3_json: JSON.stringify(l3),
  });
  st.decisions++;
  nudge();
}

// EVENT-DRIVEN touch detection — called on every trade event the instant it lands,
// so a decision fires on the trade that crosses a level (≈ tailer poll + compute),
// not after the 1 Hz snapshot loop. Re-arm per (label,price) once price leaves.
function onTradeTouch(st: SymState, e: LogEvent): void {
  if (e.kind !== 'trade' || !st.levels.length) return;
  if (Date.now() - e.ts_ms > 3000) return;   // skip replayed events (log roll) — fire on LIVE only
  const bbI = st.book.bestBid(), baI = st.book.bestAsk();
  if (bbI == null || baI == null) return;
  const midInt = (bbI + baI) / 2;
  const mid = priceFromInt(midInt);
  const now = Date.now();
  for (const lv of st.levels) {
    const distTicks = midInt - intFromPrice(lv.price);
    const tkey = `${lv.label}:${lv.price}`;
    if (Math.abs(distTicks) <= NEAR_TICKS) {
      if (!st.inZone.get(tkey)) {
        st.inZone.set(tkey, true);
        try {
          emitTouch(st, lv, distTicks, mid, cvdSlope(st, now), now);
          // touch→emit latency (upstream flush + tailer + book read). The decider adds its own.
          console.log(`[${st.sym}] ↳ touch@${lv.label} ${lv.price} emit ${Date.now() - e.ts_ms}ms`);
        } catch (err) { console.error(`[${st.sym}] emit error @ ${lv.label}:`, (err as Error).message); }
      }
    } else if (Math.abs(distTicks) >= DECISION_REARM_TICKS) {
      st.inZone.set(tkey, false);
    }
  }
}

function snapshot(st: SymState): void {
  if (!st.levels.length) return;
  const bbI = st.book.bestBid(), baI = st.book.bestAsk();
  if (bbI == null || baI == null) return;
  const bb = priceFromInt(bbI), ba = priceFromInt(baI);
  const midInt = (bbI + baI) / 2;
  const mid = (bb + ba) / 2;
  const now = Date.now();
  // sample CVD for the slope ring (this loop runs ~1 Hz)
  st.cvdHist.push([now, st.book.cvd]);
  while (st.cvdHist.length && st.cvdHist[0][0] < now - 90000) st.cvdHist.shift();

  for (const lv of st.levels) {
    const lvInt = intFromPrice(lv.price);
    const distTicks = midInt - lvInt; // + = price above the level
    if (Math.abs(distTicks) > NEAR_TICKS) continue;
    const tkey = `${lv.label}:${lv.price}`;
    // snapshot time-series (throttled). Touch DECISIONS are now EVENT-DRIVEN — see onTradeTouch.
    if (now - (st.lastSnap.get(tkey) ?? 0) < SNAP_THROTTLE_MS) continue;
    st.lastSnap.set(tkey, now);
    // price above level → level acts as support (bids defend); below → resistance (asks defend)
    const side: 'bid' | 'ask' = distTicks >= 0 ? 'bid' : 'ask';
    const wall = st.book.depthNear(lvInt, WALL_TICKS, side);
    const l3size = st.book.l3Near(lvInt, WALL_TICKS, side);
    const prints = st.book.tapeNear(lvInt, NEAR_TICKS, now - TAPE_WINDOW_MS);
    let aggrBuy = 0, aggrSell = 0;
    for (const p of prints) { if (p.buy) aggrBuy += p.size; else aggrSell += p.size; }
    insSnap.run({
      ts_ms: now, ts_et: etTime(now), trading_day: etDate(now),
      symbol: st.sym, level_label: lv.label, level_kind: lv.kind, level_price: lv.price,
      price: +mid.toFixed(2), dist_ticks: distTicks, defend_side: side,
      l2_size: wall.size, l2_orders: wall.orders, l3_size: l3size,
      implied_gap: Math.max(0, wall.size - l3size),
      best_bid: bb, best_ask: ba, spread: +(ba - bb).toFixed(2), cvd: st.book.cvd,
      aggr_buy: aggrBuy, aggr_sell: aggrSell, tape_prints: prints.length,
    });
    st.snaps++;
  }
}

function health(st: SymState): void {
  const cc = st.book.crossCheck();
  const bbI = st.book.bestBid(), baI = st.book.bestAsk();
  const px = bbI != null && baI != null ? `${priceFromInt(bbI).toFixed(2)}/${priceFromInt(baI).toFixed(2)}` : '—';
  console.log(
    `[${st.sym}] ${etTime()} ET px ${px} ev d=${st.book.depthEvents} m=${st.book.mboEvents} t=${st.book.tradeEvents}` +
    ` cc ${cc.levels ? Math.round((100 * cc.matched) / cc.levels) : 0}% levels=${st.levels.length || 'pending'}` +
    ` snaps=${st.snaps} decisions=${st.decisions} log=${st.logPath ? path.basename(st.logPath) : 'none'}`,
  );
}

// ── main ─────────────────────────────────────────────────────────────────────
const states: SymState[] = [
  { sym: 'NQ', suffix: 'NQU6', book: new OrderBook('NQ'), tail: null, logPath: null, levels: [], lastSnap: new Map(), snaps: 0, inZone: new Map(), cvdHist: [], decisions: 0 },
  { sym: 'ES', suffix: 'ESU6', book: new OrderBook('ES'), tail: null, logPath: null, levels: [], lastSnap: new Map(), snaps: 0, inZone: new Map(), cvdHist: [], decisions: 0 },
];

function reloadLevels(): void {
  for (const st of states) {
    const lv = loadLevels(st.sym);
    if (lv.length !== st.levels.length) console.log(`[${st.sym}] levels: ${st.levels.length} → ${lv.length} for ${etDate()}`);
    st.levels = lv;
  }
}

console.log(`l3-book-worker starting ${etTime()} ET — tailing full-size NQ+ES, snapshots → ${SHADOW_DB}`);
states.forEach(ensureTail);
reloadLevels();

const timers = [
  setInterval(() => states.forEach(snapshot), SNAP_LOOP_MS),
  setInterval(() => states.forEach(health), HEALTH_MS),
  setInterval(() => states.forEach(ensureTail), ROLL_CHECK_MS),
  setInterval(reloadLevels, LEVELS_RELOAD_MS),
];

function shutdown(): void {
  timers.forEach(clearInterval);
  states.forEach((s) => s.tail?.stop());
  try { pushServer.close(); } catch { /* ignore */ }
  try { fs.unlinkSync(SOCK_PATH); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  console.log(`l3-book-worker stopped ${etTime()} ET`);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
