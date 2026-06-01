/**
 * mhp_hp_touch_analysis.ts — find MHP/HP touches and analyze the microstructure
 * of bars that produced 40+ pt reversals.
 *
 * For each (date, level) pair where level is MHP or HP:
 *   - Build 1-min bars from ticks.
 *   - For each bar where bar.low ≤ level ≤ bar.high (touched the level):
 *     - Compute features (bar geometry + tape + context + touch direction).
 *     - Forward scan next 30 min: did price move +40pt or -40pt with ≤10pt
 *       drawdown the other way?
 *   - Output every touch with features + outcome.
 *
 * Conventions:
 *   is_bid_aggressor=1 → BUY aggressor (verified empirically)
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');
const LEVELS_JSON= path.resolve(__dirname, '../../../daily_levels.json');

const TARGET_PTS  = 40;
const MAX_DD_PTS  = 10;
const HORIZON_MS  = 30 * 60_000;
const LARGE_PRINT_1 = 10;
const LARGE_PRINT_2 = 25;

type Trade = { ts: number; price: number; size: number; isBidAgg: 0|1 };
type Bar = {
  minStartTs: number;
  open: number; high: number; low: number; close: number;
  vol: number; delta: number;
  buyVol: number; sellVol: number;
  maxTradeSize: number;
  largePrints1: number;
  largePrints2: number;
  numTrades: number;
};

function etMin(tsMs: number): number {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function etHHMMSS(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
}

function loadTrades(db: Database.Database, dateStr: string): Trade[] {
  const startTs = Date.parse(`${dateStr}T08:00:00-04:00`);
  const endTs   = Date.parse(`${dateStr}T16:30:00-04:00`);
  return db.prepare(
    `SELECT ts, price, size, is_bid_aggressor AS isBidAgg
     FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?
     ORDER BY ts ASC, id ASC`
  ).all(startTs, endTs) as Trade[];
}

function buildBars(trades: Trade[]): Bar[] {
  const bars: Bar[] = [];
  let cur: Bar | null = null;
  for (const t of trades) {
    const bk = Math.floor(t.ts / 60_000) * 60_000;
    if (!cur || cur.minStartTs !== bk) {
      if (cur) bars.push(cur);
      cur = {
        minStartTs: bk, open: t.price, high: t.price, low: t.price, close: t.price,
        vol: 0, delta: 0, buyVol: 0, sellVol: 0,
        maxTradeSize: 0, largePrints1: 0, largePrints2: 0, numTrades: 0,
      };
    }
    if (t.price > cur.high) cur.high = t.price;
    if (t.price < cur.low)  cur.low  = t.price;
    cur.close = t.price;
    cur.vol += t.size;
    cur.numTrades++;
    if (t.size > cur.maxTradeSize) cur.maxTradeSize = t.size;
    if (t.size >= LARGE_PRINT_1) cur.largePrints1++;
    if (t.size >= LARGE_PRINT_2) cur.largePrints2++;
    if (t.isBidAgg === 1) { cur.buyVol  += t.size; cur.delta += t.size; }
    else                  { cur.sellVol += t.size; cur.delta -= t.size; }
  }
  if (cur) bars.push(cur);
  return bars;
}

// ─── Level loader ────────────────────────────────────────────────────────────

interface DayLevels { mhp: number | null; hp: number | null; on_mhp: number | null; on_hp: number | null; }
function loadLevels(): Record<string, DayLevels> {
  const raw = JSON.parse(fs.readFileSync(LEVELS_JSON, 'utf-8'));
  const days = raw.days ?? {};
  const out: Record<string, DayLevels> = {};
  for (const [date, entry] of Object.entries(days)) {
    const lv = (entry as any).levels?.[0] ?? {};
    const add = (lv.additionalLevels ?? []) as { price?: number; label?: string }[];
    const byLabel: Record<string, number> = {};
    for (const a of add) if (typeof a.price === 'number' && a.label) byLabel[a.label] = a.price;
    out[date] = {
      mhp:    typeof lv.mhp === 'number' ? lv.mhp : null,
      hp:     typeof lv.hedgePressure === 'number' ? lv.hedgePressure : null,
      on_mhp: byLabel['ON MHP'] ?? null,
      on_hp:  byLabel['ON HP']  ?? null,
    };
  }
  return out;
}

// ─── Forward outcome ─────────────────────────────────────────────────────────

interface Outcome {
  result: 'WIN_UP' | 'WIN_DOWN' | 'LOSS' | 'TIMEOUT';
  maxGainUp: number;        // max above bar.close
  maxGainDown: number;      // max below bar.close
  timeToWinMs: number;
}

function forwardOutcome(barCloseTs: number, barClose: number, trades: Trade[]): Outcome {
  // Binary search first trade after barCloseTs.
  let lo = 0, hi = trades.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (trades[m].ts <= barCloseTs) lo = m + 1;
    else hi = m;
  }
  const endTs = barCloseTs + HORIZON_MS;
  let maxUp = 0, maxDown = 0;
  let result: Outcome['result'] = 'TIMEOUT';
  let resolveMs = HORIZON_MS;
  for (let i = lo; i < trades.length && trades[i].ts <= endTs; i++) {
    const px = trades[i].price;
    const up = px - barClose;
    const dn = barClose - px;
    if (up > maxUp)   maxUp   = up;
    if (dn > maxDown) maxDown = dn;
    // UP outcome: hit +40 before -10
    if (maxUp >= TARGET_PTS && maxDown < MAX_DD_PTS) {
      result = 'WIN_UP'; resolveMs = trades[i].ts - barCloseTs; break;
    }
    // DOWN outcome: hit -40 before +10
    if (maxDown >= TARGET_PTS && maxUp < MAX_DD_PTS) {
      result = 'WIN_DOWN'; resolveMs = trades[i].ts - barCloseTs; break;
    }
    // Loss: drawdown either side > MAX_DD without target hit yet
    if (maxUp >= MAX_DD_PTS && maxDown >= MAX_DD_PTS) {
      result = 'LOSS'; resolveMs = trades[i].ts - barCloseTs; break;
    }
  }
  return { result, maxGainUp: maxUp, maxGainDown: maxDown, timeToWinMs: resolveMs };
}

// ─── Features per touch ──────────────────────────────────────────────────────

type LevelName = 'MHP' | 'HP' | 'ON_MHP' | 'ON_HP';
interface Touch {
  date: string;
  level: LevelName;
  levelPrice: number;
  barTs: number;
  // Bar geometry
  open: number; high: number; low: number; close: number;
  range: number; body: number; bodyPct: number;
  upperWick: number; lowerWick: number; closeInRangePct: number;
  bullish: boolean;
  // Tape
  vol: number; delta: number; buyVol: number; sellVol: number;
  deltaPct: number;        // |delta|/vol
  maxTradeSize: number;
  largePrints1: number;    // count of trades >= 10
  largePrints2: number;    // count of trades >= 25
  numTrades: number;
  // Touch direction
  closeRelLevel: number;   // close - level (positive if close above)
  lowToLevel: number;      // low - level (negative if low below level)
  highToLevel: number;     // high - level (positive if high above)
  touchVia: 'upperWick' | 'lowerWick' | 'body';
  // Context — last 5 / 15 bars (using bars[bi-5..bi-1])
  prev5Net: number;
  prev15Net: number;
  prev5Delta: number;
  prev15Delta: number;
  // Outcome
  outcome: Outcome['result'];
  maxGainUp: number;
  maxGainDown: number;
  timeToWinMs: number;
}

function analyzeTouch(
  bars: Bar[], bi: number, level: number, levelName: LevelName, date: string, trades: Trade[],
): Touch {
  const b = bars[bi]!;
  const range = b.high - b.low;
  const body = b.close - b.open;
  const bodyPct = range > 0 ? Math.abs(body) / range : 0;
  const upperWick = b.high - Math.max(b.open, b.close);
  const lowerWick = Math.min(b.open, b.close) - b.low;
  const closeInRangePct = range > 0 ? (b.close - b.low) / range : 0.5;
  const deltaPct = b.vol > 0 ? Math.abs(b.delta) / b.vol : 0;

  // Touch direction inference: which wick is closer to the level?
  const lowToLevel  = b.low  - level;
  const highToLevel = b.high - level;
  let touchVia: 'upperWick'|'lowerWick'|'body' = 'body';
  // If level is in the upper-wick region (above max(open,close))
  if (level > Math.max(b.open, b.close)) touchVia = 'upperWick';
  else if (level < Math.min(b.open, b.close)) touchVia = 'lowerWick';
  else touchVia = 'body';

  // Context — last 5/15 bars (causal, excluding this one)
  const first5  = bars[bi - 5]  ?? bars[0]!;
  const first15 = bars[bi - 15] ?? bars[0]!;
  let prev5Delta = 0, prev15Delta = 0;
  for (let k = Math.max(0, bi - 5);  k < bi; k++) prev5Delta  += bars[k]!.delta;
  for (let k = Math.max(0, bi - 15); k < bi; k++) prev15Delta += bars[k]!.delta;

  const outcome = forwardOutcome(b.minStartTs + 60_000, b.close, trades);

  return {
    date, level: levelName, levelPrice: level, barTs: b.minStartTs,
    open: b.open, high: b.high, low: b.low, close: b.close,
    range, body, bodyPct, upperWick, lowerWick, closeInRangePct,
    bullish: body > 0,
    vol: b.vol, delta: b.delta, buyVol: b.buyVol, sellVol: b.sellVol,
    deltaPct,
    maxTradeSize: b.maxTradeSize,
    largePrints1: b.largePrints1,
    largePrints2: b.largePrints2,
    numTrades: b.numTrades,
    closeRelLevel: b.close - level,
    lowToLevel, highToLevel, touchVia,
    prev5Net: b.close - first5.open,
    prev15Net: b.close - first15.open,
    prev5Delta, prev15Delta,
    outcome: outcome.result,
    maxGainUp: outcome.maxGainUp,
    maxGainDown: outcome.maxGainDown,
    timeToWinMs: outcome.timeToWinMs,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('MHP / HP touch analysis — 40pt target / 10pt max DD, 30-min horizon');
  const allLevels = loadLevels();
  const db = new Database(TICKS_DB, { readonly: true });
  db.pragma('journal_mode = WAL');

  const dates = Object.keys(allLevels).sort();
  const touches: Touch[] = [];

  for (const date of dates) {
    const lv = allLevels[date];
    if (!lv) continue;
    if (lv.mhp == null && lv.hp == null && lv.on_mhp == null && lv.on_hp == null) continue;
    const trades = loadTrades(db, date);
    if (trades.length < 1000) {
      console.log(`${date}: insufficient ticks (${trades.length}) — skipping`);
      continue;
    }
    const bars = buildBars(trades);
    if (bars.length < 60) continue;

    const candidateLevels: [LevelName, number|null][] = [
      ['MHP',    lv.mhp],
      ['HP',     lv.hp],
      ['ON_MHP', lv.on_mhp],
      ['ON_HP',  lv.on_hp],
    ];
    for (const [lvName, lvPrice] of candidateLevels) {
      if (lvPrice == null) continue;
      for (let bi = 15; bi < bars.length; bi++) {
        const b = bars[bi]!;
        if (b.low > lvPrice || b.high < lvPrice) continue;
        const m = etMin(b.minStartTs);
        if (m < 9*60+30 || m > 15*60+55) continue;
        touches.push(analyzeTouch(bars, bi, lvPrice, lvName, date, trades));
      }
    }
  }
  db.close();

  console.log(`\nTotal touches found: ${touches.length}`);
  const winUp   = touches.filter(t => t.outcome === 'WIN_UP');
  const winDn   = touches.filter(t => t.outcome === 'WIN_DOWN');
  const losses  = touches.filter(t => t.outcome === 'LOSS');
  const tos     = touches.filter(t => t.outcome === 'TIMEOUT');
  console.log(`WIN_UP=${winUp.length}  WIN_DOWN=${winDn.length}  LOSS=${losses.length}  TIMEOUT=${tos.length}`);
  console.log(`Total winners (either direction): ${winUp.length + winDn.length}`);

  // Per-level breakdown
  for (const lvName of ['MHP','HP','ON_MHP','ON_HP'] as const) {
    const ts = touches.filter(t => t.level === lvName);
    const wu = ts.filter(t => t.outcome === 'WIN_UP').length;
    const wd = ts.filter(t => t.outcome === 'WIN_DOWN').length;
    const ls = ts.filter(t => t.outcome === 'LOSS').length;
    const to = ts.filter(t => t.outcome === 'TIMEOUT').length;
    console.log(`${lvName.padEnd(7)}  total=${String(ts.length).padStart(3)}  WIN_UP=${String(wu).padStart(2)}  WIN_DOWN=${String(wd).padStart(2)}  LOSS=${String(ls).padStart(2)}  TIMEOUT=${String(to).padStart(2)}`);
  }

  // Detail dump of WINNERS only (both directions)
  console.log('\n── WINNERS (40+ pt move, ≤10 dd) ──');
  console.log('date       et       lvl  price    bar(O/H/L/C)             range body bullW lwrW closeR delta dPct vol  bP1 bP2 maxTr prev5N prev15N prev5D prev15D  outcome   maxUp maxDn  res');
  const winners = touches.filter(t => t.outcome === 'WIN_UP' || t.outcome === 'WIN_DOWN');
  for (const t of winners) {
    console.log(
      `${t.date}  ${etHHMMSS(t.barTs)}  ${t.level} ${t.levelPrice.toFixed(2).padStart(8)} ` +
      `${t.open.toFixed(2)}/${t.high.toFixed(2)}/${t.low.toFixed(2)}/${t.close.toFixed(2)}  ` +
      `${t.range.toFixed(1).padStart(4)} ${(t.bodyPct*100).toFixed(0).padStart(3)} ${t.upperWick.toFixed(1).padStart(4)} ${t.lowerWick.toFixed(1).padStart(4)} ${(t.closeInRangePct*100).toFixed(0).padStart(3)} ` +
      `${t.delta.toString().padStart(6)} ${(t.deltaPct*100).toFixed(0).padStart(3)} ${String(t.vol).padStart(5)} ${String(t.largePrints1).padStart(3)} ${String(t.largePrints2).padStart(3)} ${String(t.maxTradeSize).padStart(5)} ` +
      `${t.prev5Net.toFixed(1).padStart(5)} ${t.prev15Net.toFixed(1).padStart(6)} ${t.prev5Delta.toString().padStart(6)} ${t.prev15Delta.toString().padStart(6)}  ` +
      `${t.outcome.padEnd(9)} ${t.maxGainUp.toFixed(1).padStart(5)} ${t.maxGainDown.toFixed(1).padStart(5)} ${(t.timeToWinMs/60_000).toFixed(1).padStart(4)}m`
    );
  }

  // ── Feature comparison: winners (either direction) vs losers ──
  function avg(arr: number[]): number { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
  function med(arr: number[]): number { if(!arr.length) return 0; const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]!; }
  const winsAll = touches.filter(t => t.outcome.startsWith('WIN'));
  const lossAll = touches.filter(t => t.outcome === 'LOSS');
  const featCols: Array<[string, (t: Touch) => number]> = [
    ['range',         t => t.range],
    ['bodyPct',       t => t.bodyPct * 100],
    ['upperWick',     t => t.upperWick],
    ['lowerWick',     t => t.lowerWick],
    ['closeInRange%', t => t.closeInRangePct * 100],
    ['delta',         t => t.delta],
    ['deltaPct',      t => t.deltaPct * 100],
    ['vol',           t => t.vol],
    ['numTrades',     t => t.numTrades],
    ['maxTradeSize',  t => t.maxTradeSize],
    ['largePr≥10',    t => t.largePrints1],
    ['largePr≥25',    t => t.largePrints2],
    ['prev5Net',      t => t.prev5Net],
    ['prev15Net',     t => t.prev15Net],
    ['prev5Delta',    t => t.prev5Delta],
    ['prev15Delta',   t => t.prev15Delta],
    ['closeRelLevel', t => t.closeRelLevel],
  ];
  console.log('\n── Feature comparison (winners vs losers) ──');
  console.log('feature           win_avg  loss_avg   win_med  loss_med   delta(w-l)');
  for (const [name, fn] of featCols) {
    const wAvg = avg(winsAll.map(fn));
    const lAvg = avg(lossAll.map(fn));
    const wMed = med(winsAll.map(fn));
    const lMed = med(lossAll.map(fn));
    const diff = wAvg - lAvg;
    console.log(`${name.padEnd(16)}  ${wAvg.toFixed(1).padStart(7)}  ${lAvg.toFixed(1).padStart(8)}   ${wMed.toFixed(1).padStart(7)}  ${lMed.toFixed(1).padStart(8)}   ${diff.toFixed(1).padStart(8)}`);
  }
  // Same comparison split by WIN_UP and WIN_DOWN
  console.log('\n── Feature comparison — WIN_UP only ──');
  console.log('feature           win_avg  loss_avg   win_med  loss_med');
  const wupAll = touches.filter(t => t.outcome === 'WIN_UP');
  for (const [name, fn] of featCols) {
    const wAvg = avg(wupAll.map(fn));
    const lAvg = avg(lossAll.map(fn));
    const wMed = med(wupAll.map(fn));
    const lMed = med(lossAll.map(fn));
    console.log(`${name.padEnd(16)}  ${wAvg.toFixed(1).padStart(7)}  ${lAvg.toFixed(1).padStart(8)}   ${wMed.toFixed(1).padStart(7)}  ${lMed.toFixed(1).padStart(8)}`);
  }
  console.log('\n── Feature comparison — WIN_DOWN only ──');
  console.log('feature           win_avg  loss_avg   win_med  loss_med');
  const wdnAll = touches.filter(t => t.outcome === 'WIN_DOWN');
  for (const [name, fn] of featCols) {
    const wAvg = avg(wdnAll.map(fn));
    const lAvg = avg(lossAll.map(fn));
    const wMed = med(wdnAll.map(fn));
    const lMed = med(lossAll.map(fn));
    console.log(`${name.padEnd(16)}  ${wAvg.toFixed(1).padStart(7)}  ${lAvg.toFixed(1).padStart(8)}   ${wMed.toFixed(1).padStart(7)}  ${lMed.toFixed(1).padStart(8)}`);
  }

  console.log('\n── LOSERS sample (first 20) ──');
  for (const t of losses.slice(0, 20)) {
    console.log(
      `${t.date}  ${etHHMMSS(t.barTs)}  ${t.level} ${t.levelPrice.toFixed(2).padStart(8)} ` +
      `${t.open.toFixed(2)}/${t.high.toFixed(2)}/${t.low.toFixed(2)}/${t.close.toFixed(2)}  ` +
      `range=${t.range.toFixed(1)} body=${(t.bodyPct*100).toFixed(0)} delta=${t.delta} dPct=${(t.deltaPct*100).toFixed(0)} vol=${t.vol}  bP1=${t.largePrints1} bP2=${t.largePrints2} maxTr=${t.maxTradeSize} prev15D=${t.prev15Delta}`
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
