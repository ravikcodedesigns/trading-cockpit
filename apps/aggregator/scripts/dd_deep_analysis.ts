/**
 * DD Upper Band — Price-Triggered Deep Analysis (revised framework)
 *
 * Framework (real-time compatible):
 *  Zone entry  = first bar where high crosses DD_upper - 20 on the approach
 *  Snapshot A  = ask depth state at DD upper during zone-entry bar (what was pre-positioned)
 *  Snapshot B  = ask depth state at DD upper during touch bar (did supply hold or evaporate?)
 *  Ask change  = B - A: positive = sellers held/added = real supply = reversal likely
 *                       negative = orders pulled as price arrived = breakout risk
 *  Approach Δ  = cumulative delta from zone entry to touch bar (trade tape, ground truth)
 *  Approach v  = bar count from zone entry to touch (velocity)
 *  Absorption  = large-lot (≥5) prints at DD upper during touch bar
 *  N1/N2       = delta of first two bars after touch (measured from entry — no hindsight)
 *  All TPs     = measured from entry bar high, not a hindsight peak
 */
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ticksDb = new Database(path.resolve(__dirname, "../../../data/ticks.db"), { readonly: true });

// ─── TOUCH EVENTS ─────────────────────────────────────────────────────────────
interface TouchEvent {
  label: string;
  day: string;
  entryTime: string;   // HH:MM — first bar where price touched DD upper (within 2 pts)
  ddUpper: number;
  outcome: "WIN" | "PARTIAL" | "FAIL";
}

const EVENTS: TouchEvent[] = [
  // FAILS — breakout, price did not reverse
  { label: "May06",   day: "2026-05-06", entryTime: "09:35", ddUpper: 28458.17, outcome: "FAIL"    },
  { label: "May08",   day: "2026-05-08", entryTime: "09:34", ddUpper: 28962.84, outcome: "FAIL"    },
  // May 19
  { label: "May19-1", day: "2026-05-19", entryTime: "09:30", ddUpper: 28879.25, outcome: "WIN"     },
  { label: "May19-2", day: "2026-05-19", entryTime: "11:42", ddUpper: 28879.25, outcome: "PARTIAL" },
  { label: "May19-3", day: "2026-05-19", entryTime: "12:03", ddUpper: 28879.25, outcome: "PARTIAL" },
  { label: "May19-4", day: "2026-05-19", entryTime: "12:24", ddUpper: 28879.25, outcome: "WIN"     },
  // May 20
  { label: "May20-1", day: "2026-05-20", entryTime: "09:33", ddUpper: 29149.24, outcome: "WIN"     },
  { label: "May20-2", day: "2026-05-20", entryTime: "09:44", ddUpper: 29149.24, outcome: "WIN"     },
  // May 21
  { label: "May21",   day: "2026-05-21", entryTime: "13:52", ddUpper: 29528.71, outcome: "WIN"     },
  // May 22
  { label: "May22-1", day: "2026-05-22", entryTime: "09:40", ddUpper: 29705.26, outcome: "WIN"     },
  { label: "May22-2", day: "2026-05-22", entryTime: "11:28", ddUpper: 29705.26, outcome: "PARTIAL" },
  { label: "May22-3", day: "2026-05-22", entryTime: "13:05", ddUpper: 29705.26, outcome: "WIN"     },
  { label: "May22-4", day: "2026-05-22", entryTime: "13:47", ddUpper: 29705.26, outcome: "PARTIAL" },
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getRthBars(day: string) {
  return ticksDb.prepare(`
    SELECT ts/1000/60 as mb,
           datetime(ts/1000,'unixepoch','localtime') as time,
           MIN(price) as low, MAX(price) as high,
           FIRST_VALUE(price) OVER (PARTITION BY ts/1000/60 ORDER BY ts
             ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as open,
           SUM(size) as vol,
           SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) as delta,
           LAST_VALUE(price) OVER (PARTITION BY ts/1000/60 ORDER BY ts
             ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as close
    FROM trades WHERE symbol='NQ'
      AND date(ts/1000,'unixepoch','localtime')=?
      AND time(ts/1000,'unixepoch','localtime') BETWEEN '09:00:00' AND '16:05:00'
    GROUP BY ts/1000/60 ORDER BY mb
  `).all(day) as any[];
}

function barAt(bars: any[], hhmm: string): { bar: any; idx: number } | null {
  const idx = bars.findIndex((b: any) => b.time.slice(11, 16) === hhmm);
  return idx >= 0 ? { bar: bars[idx], idx } : null;
}

// Find zone entry: last bar in this approach where price first crossed DD_upper - 20.
// Walks backward from entryIdx to find where the 20-pt zone was entered.
function findZoneEntry(bars: any[], entryIdx: number, ddUpper: number): { bar: any; idx: number } {
  const threshold = ddUpper - 20;
  let j = entryIdx - 1;
  while (j >= 0 && bars[j].high >= threshold) j--;
  const zoneIdx = Math.min(j + 1, entryIdx);
  return { bar: bars[zoneIdx], idx: zoneIdx };
}

// Depth snapshot: ask-side activity at DD upper during a single 60-second bar window.
// Returns total size and distinct price levels. Uses all depth updates (replacements included).
function depthSnapshot(barStartMs: number, ddUpper: number) {
  const row = ticksDb.prepare(`
    SELECT
      SUM(CASE WHEN side=1 AND price >= ? THEN size ELSE 0 END) as ask_sz,
      COUNT(DISTINCT CASE WHEN side=1 AND price >= ? THEN price END) as ask_levels,
      MAX(CASE WHEN side=1 AND price >= ? THEN size ELSE 0 END) as ask_max
    FROM depth WHERE symbol='NQ'
      AND ts >= ? AND ts < ?
  `).get(ddUpper, ddUpper, ddUpper, barStartMs, barStartMs + 60_000) as any;
  return {
    askSz:     row?.ask_sz     || 0,
    askLevels: row?.ask_levels || 0,
    askMax:    row?.ask_max    || 0,
  };
}

// Approach leg: cumulative delta + volume from zone entry bar start to touch bar start.
// This is the ground-truth buying pressure that carried price into DD upper.
function approachLeg(zoneStartMs: number, entryStartMs: number) {
  if (zoneStartMs >= entryStartMs) return { delta: 0, vol: 0, deltaPct: 0 };
  const row = ticksDb.prepare(`
    SELECT
      SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) as delta,
      SUM(size) as vol
    FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?
  `).get(zoneStartMs, entryStartMs) as any;
  const delta = row?.delta || 0;
  const vol   = row?.vol   || 0;
  return { delta, vol, deltaPct: vol > 0 ? delta / vol * 100 : 0 };
}

// Touch bar absorption: large lots (≥5) printed at/above DD upper during the touch bar.
// Negative netDelta = large sellers came to market = strong reversal signal.
function touchAbsorption(entryStartMs: number, ddUpper: number) {
  const row = ticksDb.prepare(`
    SELECT
      COUNT(*)                                                             as count,
      SUM(CASE WHEN is_bid_aggressor=0 THEN size ELSE 0 END)              as sell_vol,
      SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE 0 END)              as buy_vol,
      SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END)          as net_delta,
      MAX(size)                                                            as max_lot
    FROM trades WHERE symbol='NQ'
      AND ts >= ? AND ts < ?
      AND price >= ?
      AND size >= 5
  `).get(entryStartMs, entryStartMs + 60_000, ddUpper - 3) as any;
  return {
    count:    row?.count     || 0,
    sellVol:  row?.sell_vol  || 0,
    buyVol:   row?.buy_vol   || 0,
    netDelta: row?.net_delta || 0,
    maxLot:   row?.max_lot   || 0,
  };
}

// CVD 15-bar divergence: price rising but cumulative delta weak = buyers exhausted.
// diverging = price up >5 pts and CVD < 30% of the equivalent price-rate (exhaustion).
function cvd15(bars: any[], refIdx: number) {
  const start = Math.max(0, refIdx - 14);
  const window = bars.slice(start, refIdx + 1);
  if (window.length < 2) return { priceDelta: 0, cvd: 0, diverging: false };
  const priceDelta = window[window.length - 1].close - window[0].open;
  const cvd = window.reduce((sum: number, b: any) => sum + b.delta, 0);
  const diverging = priceDelta > 5 && cvd < priceDelta * 0.3;
  return { priceDelta, cvd, diverging };
}

// Prior trading day: did price trade at or above DD upper? Fresh test vs repeated overshoot.
function prevDayAboveDDUpper(day: string, ddUpper: number): boolean {
  const prevRow = ticksDb.prepare(`
    SELECT DISTINCT date(ts/1000,'unixepoch','localtime') as d
    FROM trades WHERE symbol='NQ'
      AND date(ts/1000,'unixepoch','localtime') < ?
    ORDER BY d DESC LIMIT 1
  `).get(day) as any;
  if (!prevRow?.d) return false;
  const row = ticksDb.prepare(`
    SELECT MAX(price) as mx FROM trades
    WHERE symbol='NQ' AND date(ts/1000,'unixepoch','localtime')=?
  `).get(prevRow.d) as any;
  return (row?.mx || 0) >= ddUpper;
}

// RTH time gate: highest-quality DD reversals happen 11:00–15:00 ET (post-open noise, pre-close).
function inTimeGate(hhmm: string): boolean {
  return hhmm >= "11:00" && hhmm <= "15:00";
}

// TPs measured from entry bar high (the price you'd actually short at in live trading).
function calcTPs(bars: any[], entryIdx: number, entryHigh: number) {
  const post = bars.slice(entryIdx + 1, entryIdx + 121);
  let minLow = entryHigh;
  const tps: Record<number, number | null> = { 30: null, 50: null, 100: null, 150: null };
  for (let k = 0; k < post.length; k++) {
    minLow = Math.min(minLow, post[k].low);
    for (const tp of [30, 50, 100, 150]) {
      if (tps[tp] === null && post[k].low <= entryHigh - tp) tps[tp] = k + 1;
    }
  }
  return { maxRetrace: entryHigh - minLow, tps };
}

// ─── MAIN ANALYSIS ────────────────────────────────────────────────────────────
interface Result {
  ev: TouchEvent;
  entryHigh: number;
  // Zone → Touch approach
  zoneTime: string;
  approachBars: number;
  approachDelta: number;
  approachDeltaPct: number;
  approachVol: number;
  // Depth snapshots (A = zone entry bar, B = touch bar)
  askSzA: number; askLvlsA: number;
  askSzB: number; askLvlsB: number;
  askSzChange: number;     // B - A: positive = supply held/grew = bearish for price
  askLvlChange: number;    // B - A in distinct levels
  // Touch bar
  touchDeltaPct: number;
  touchVolVsAppr: number;  // touch bar vol / avg approach bar vol
  barClosePos: number;     // 0 = close at high (full bull bar), 1 = close at low (full bear bar)
  // Large-lot absorption at touch bar
  absCount: number;
  absSellVol: number;
  absBuyVol: number;
  absNetDelta: number;
  absMaxLot: number;
  // Post-touch (N1/N2 measured from entry bar — real-time compatible)
  nxt1Delta: number;
  nxt2Delta: number;
  consNegBars: number;
  // Signal quality filters
  inTimeGate: boolean;
  prevDayAboveDDUpper: boolean;
  cvdZonePriceDelta: number;
  cvdZoneCvd: number;
  cvdZoneDiverging: boolean;
  cvdTouchPriceDelta: number;
  cvdTouchCvd: number;
  cvdTouchDiverging: boolean;
  // Outcome
  maxRetrace: number;
  tp30: number | null;
  tp50: number | null;
  tp100: number | null;
  tp150: number | null;
}

const results: Result[] = [];

for (const ev of EVENTS) {
  const bars = getRthBars(ev.day);
  if (!bars.length) { console.log(`${ev.label}: no tick data`); continue; }

  const entryFound = barAt(bars, ev.entryTime);
  if (!entryFound) { console.log(`${ev.label}: entry bar not found at ${ev.entryTime}`); continue; }
  const { bar: entryBar, idx: entryIdx } = entryFound;
  const entryHigh = entryBar.high;

  // Zone entry for this specific approach
  const { bar: zoneBar, idx: zoneIdx } = findZoneEntry(bars, entryIdx, ev.ddUpper);
  const approachBars = entryIdx - zoneIdx;
  const zoneTsMs  = zoneBar.mb  * 60 * 1_000;
  const entryTsMs = entryBar.mb * 60 * 1_000;

  // Depth: snapshot at zone entry vs touch
  const dsnA = depthSnapshot(zoneTsMs,  ev.ddUpper);
  const dsnB = depthSnapshot(entryTsMs, ev.ddUpper);
  const askSzChange  = dsnB.askSz     - dsnA.askSz;
  const askLvlChange = dsnB.askLevels - dsnA.askLevels;

  // Approach leg (trade tape from zone entry to touch bar, excludes touch bar)
  const appr = approachLeg(zoneTsMs, entryTsMs);
  const approachAvgVol = approachBars > 0 ? appr.vol / approachBars : 0;

  // Touch bar metrics
  const touchDeltaPct  = entryBar.vol > 0 ? entryBar.delta / entryBar.vol * 100 : 0;
  const touchVolVsAppr = approachAvgVol > 0 ? entryBar.vol / approachAvgVol : 1;
  const barRange    = entryBar.high - entryBar.low;
  const barClosePos = barRange > 0 ? (entryBar.high - entryBar.close) / barRange : 0;

  // Large-lot absorption at touch level
  const abs = touchAbsorption(entryTsMs, ev.ddUpper);

  // Post-touch N1/N2 from entry bar (not a hindsight peak)
  const nxt1   = bars[entryIdx + 1] ?? null;
  const nxt2   = bars[entryIdx + 2] ?? null;
  const post4  = bars.slice(entryIdx + 1, entryIdx + 5);
  let consNeg  = 0;
  for (const pb of post4) { if (pb.delta < 0) consNeg++; else break; }

  // Signal quality filters
  const timeGate    = inTimeGate(ev.entryTime);
  const prevAbove   = prevDayAboveDDUpper(ev.day, ev.ddUpper);
  const cvdZoneRes  = cvd15(bars, zoneIdx);
  const cvdTouchRes = cvd15(bars, entryIdx);

  // TPs from entry bar high
  const { maxRetrace, tps } = calcTPs(bars, entryIdx, entryHigh);

  results.push({
    ev, entryHigh,
    zoneTime: zoneBar.time.slice(11, 16),
    approachBars, approachDelta: appr.delta, approachDeltaPct: appr.deltaPct, approachVol: appr.vol,
    askSzA: dsnA.askSz, askLvlsA: dsnA.askLevels,
    askSzB: dsnB.askSz, askLvlsB: dsnB.askLevels,
    askSzChange, askLvlChange,
    touchDeltaPct, touchVolVsAppr, barClosePos,
    absCount: abs.count, absSellVol: abs.sellVol, absBuyVol: abs.buyVol,
    absNetDelta: abs.netDelta, absMaxLot: abs.maxLot,
    nxt1Delta: nxt1?.delta ?? 0, nxt2Delta: nxt2?.delta ?? 0, consNegBars: consNeg,
    inTimeGate: timeGate,
    prevDayAboveDDUpper: prevAbove,
    cvdZonePriceDelta: cvdZoneRes.priceDelta,
    cvdZoneCvd: cvdZoneRes.cvd,
    cvdZoneDiverging: cvdZoneRes.diverging,
    cvdTouchPriceDelta: cvdTouchRes.priceDelta,
    cvdTouchCvd: cvdTouchRes.cvd,
    cvdTouchDiverging: cvdTouchRes.diverging,
    maxRetrace, tp30: tps[30], tp50: tps[50], tp100: tps[100], tp150: tps[150],
  });
}

// ─── OUTPUT ───────────────────────────────────────────────────────────────────
const W   = "🟢 WIN    ";
const P   = "🟡 PARTIAL";
const F   = "🔴 FAIL   ";
const tag = (o: string) => o === "WIN" ? W : o === "PARTIAL" ? P : F;
const sgn = (n: number) => (n >= 0 ? "+" : "") + n;
const fmt = (x: number | null) => x != null ? String(x) + "m" : "  X";
function avg(arr: number[]) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

console.log("\n" + "═".repeat(104));
console.log("DD UPPER BAND — PRICE-TRIGGERED DEEP ANALYSIS  (all 13 events)");
console.log("═".repeat(104));

for (const r of results) {
  const { ev } = r;
  const chgDir = r.askSzChange > 0 ? "GREW ▲" : r.askSzChange < 0 ? "SHRUNK ▼" : "flat";
  const chgK   = (r.askSzChange >= 0 ? "+" : "") + Math.round(r.askSzChange / 1_000) + "K";

  const tgLabel    = r.inTimeGate ? "✅ IN GATE" : "⛔ outside";
  const prevLabel  = r.prevDayAboveDDUpper ? "⚠️  YES (repeated touch)" : "✅ NO (fresh)";
  const divZLabel  = r.cvdZoneDiverging ? "⚠️  DIVERGING" : "OK";
  const divTLabel  = r.cvdTouchDiverging ? "⚠️  DIVERGING" : "OK";
  console.log(`\n${tag(ev.outcome)} ${ev.label.padEnd(10)} | DD Upper: ${ev.ddUpper}  Entry: ${ev.entryTime} @ ${r.entryHigh.toFixed(2)}  |  Retrace: ${r.maxRetrace.toFixed(0)} pts  |  TP30:${fmt(r.tp30)} TP50:${fmt(r.tp50)} TP100:${fmt(r.tp100)}`);
  console.log(`  Time gate      : ${tgLabel}  |  Prev day above DD upper: ${prevLabel}`);
  console.log(`  Zone entry     : ${r.zoneTime} (${r.approachBars} bars before touch)  approach Δ: ${sgn(r.approachDelta)} (${r.approachDeltaPct.toFixed(1)}% of vol)  approach vol: ${r.approachVol}`);
  console.log(`  CVD15 @ zone   : price Δ: ${r.cvdZonePriceDelta.toFixed(1)}  CVD: ${sgn(r.cvdZoneCvd)}  → ${divZLabel}`);
  console.log(`  CVD15 @ touch  : price Δ: ${r.cvdTouchPriceDelta.toFixed(1)}  CVD: ${sgn(r.cvdTouchCvd)}  → ${divTLabel}`);
  console.log(`  Depth @ zone   : ask size ${Math.round(r.askSzA / 1_000)}K  |  ask levels: ${r.askLvlsA}`);
  console.log(`  Depth @ touch  : ask size ${Math.round(r.askSzB / 1_000)}K  |  ask levels: ${r.askLvlsB}  |  CHANGE: ${chgK} (${chgDir}) ← KEY`);
  console.log(`  Touch bar      : Δ%: ${sgn(+r.touchDeltaPct.toFixed(1))}%  vol vs approach avg: ${r.touchVolVsAppr.toFixed(2)}x  close pos: ${(r.barClosePos * 100).toFixed(0)}% from high`);
  console.log(`  Absorption(≥5) : count=${r.absCount}  sell=${r.absSellVol}  buy=${r.absBuyVol}  net=${sgn(r.absNetDelta)}  max_lot=${r.absMaxLot}`);
  console.log(`  Post-touch     : N1Δ: ${sgn(r.nxt1Delta)}  N2Δ: ${sgn(r.nxt2Delta)}  consec neg bars: ${r.consNegBars}/4`);
}

// ─── COMPARISON TABLE ─────────────────────────────────────────────────────────
console.log("\n\n" + "═".repeat(150));
console.log("COMPARISON TABLE");
console.log("═".repeat(150));
console.log(
  `${"Event".padEnd(12)} ${"Out".padEnd(8)} ${"Gate".padStart(5)} ${"PrevAb".padStart(7)} ${"CVDzD".padStart(6)} ${"CVDtD".padStart(6)} ${"Zone".padStart(5)} ${"ApprB".padStart(6)} ${"ApprΔ%".padStart(7)} ${"AskSzA".padStart(8)} ${"AskSzB".padStart(8)} ${"AskChg".padStart(8)} ${"LvlChg".padStart(7)} ${"TchΔ%".padStart(7)} ${"VolX".padStart(5)} ${"AbsNet".padStart(7)} ${"AbsMax".padStart(7)} ${"N1Δ".padStart(7)} ${"N2Δ".padStart(8)} ${"Neg/4".padStart(6)} ${"Retrace".padStart(8)} ${"TP50".padStart(5)} ${"TP100".padStart(6)}`
);
console.log("─".repeat(175));

const grp = (o: "WIN" | "PARTIAL" | "FAIL") => results.filter(r => r.ev.outcome === o);
for (const r of [...grp("WIN"), ...grp("PARTIAL"), ...grp("FAIL")]) {
  const chgK = (r.askSzChange >= 0 ? "+" : "") + Math.round(r.askSzChange / 1_000) + "K";
  console.log(
    `${r.ev.label.padEnd(12)} ${r.ev.outcome.padEnd(8)}` +
    ` ${(r.inTimeGate ? "YES" : "no").padStart(5)}` +
    ` ${(r.prevDayAboveDDUpper ? "YES" : "no").padStart(7)}` +
    ` ${(r.cvdZoneDiverging ? "DIV" : "-").padStart(6)}` +
    ` ${(r.cvdTouchDiverging ? "DIV" : "-").padStart(6)}` +
    ` ${r.zoneTime.padStart(5)} ${String(r.approachBars).padStart(6)}` +
    ` ${((r.approachDeltaPct >= 0 ? "+" : "") + r.approachDeltaPct.toFixed(1)).padStart(7)}` +
    ` ${(Math.round(r.askSzA / 1_000) + "K").padStart(8)}` +
    ` ${(Math.round(r.askSzB / 1_000) + "K").padStart(8)}` +
    ` ${chgK.padStart(8)}` +
    ` ${sgn(r.askLvlChange).padStart(7)}` +
    ` ${((r.touchDeltaPct >= 0 ? "+" : "") + r.touchDeltaPct.toFixed(1)).padStart(7)}` +
    ` ${r.touchVolVsAppr.toFixed(2).padStart(5)}` +
    ` ${sgn(r.absNetDelta).padStart(7)}` +
    ` ${String(r.absMaxLot).padStart(7)}` +
    ` ${sgn(r.nxt1Delta).padStart(7)}` +
    ` ${sgn(r.nxt2Delta).padStart(8)}` +
    ` ${String(r.consNegBars + "/4").padStart(6)}` +
    ` ${r.maxRetrace.toFixed(0).padStart(8)}` +
    ` ${fmt(r.tp50).padStart(5)} ${fmt(r.tp100).padStart(6)}`
  );
}

// ─── AVERAGES BY OUTCOME ──────────────────────────────────────────────────────
console.log("\n\n" + "═".repeat(90));
console.log("AVERAGES BY OUTCOME GROUP");
console.log("═".repeat(90));

for (const outcome of ["WIN", "PARTIAL", "FAIL"] as const) {
  const g = results.filter(r => r.ev.outcome === outcome);
  if (!g.length) continue;
  console.log(`\n${tag(outcome)} (n=${g.length})`);
  const nInGate  = g.filter(r => r.inTimeGate).length;
  const nPrevAbv = g.filter(r => r.prevDayAboveDDUpper).length;
  const nDivZ    = g.filter(r => r.cvdZoneDiverging).length;
  const nDivT    = g.filter(r => r.cvdTouchDiverging).length;
  console.log(`  In time gate (11-15) : ${nInGate}/${g.length}`);
  console.log(`  Prev day above upper : ${nPrevAbv}/${g.length}  (repeated touch = weaker setup)`);
  console.log(`  CVD15 diverging@zone : ${nDivZ}/${g.length}  (price up, buyers exhausted)`);
  console.log(`  CVD15 diverging@tch  : ${nDivT}/${g.length}`);
  console.log(`  Approach bars        : avg ${avg(g.map(r => r.approachBars)).toFixed(1)}  (bars from DD-20 zone entry to touch)`);
  console.log(`  Approach delta%      : avg ${avg(g.map(r => r.approachDeltaPct)).toFixed(1)}%  (% of approach vol that was buy-driven)`);
  console.log(`  Ask size @ zone (A)  : avg ${(avg(g.map(r => r.askSzA)) / 1_000).toFixed(0)}K`);
  console.log(`  Ask size @ touch (B) : avg ${(avg(g.map(r => r.askSzB)) / 1_000).toFixed(0)}K`);
  console.log(`  Ask size change B-A  : avg ${((avg(g.map(r => r.askSzChange))) / 1_000).toFixed(0)}K  (+= supply held/grew = reversal, -= evaporated = breakout risk)`);
  console.log(`  Ask level change     : avg ${avg(g.map(r => r.askLvlChange)).toFixed(0)}  (+= more levels defended at touch)`);
  console.log(`  Touch bar delta%     : avg ${avg(g.map(r => r.touchDeltaPct)).toFixed(1)}%`);
  console.log(`  Touch vol vs appr    : avg ${avg(g.map(r => r.touchVolVsAppr)).toFixed(2)}x`);
  console.log(`  Absorption net Δ     : avg ${avg(g.map(r => r.absNetDelta)).toFixed(0)}  (negative = large sellers came to market)`);
  console.log(`  Absorption max lot   : avg ${avg(g.map(r => r.absMaxLot)).toFixed(0)}`);
  console.log(`  N1 delta             : avg ${avg(g.map(r => r.nxt1Delta)).toFixed(0)}`);
  console.log(`  N2 delta             : avg ${avg(g.map(r => r.nxt2Delta)).toFixed(0)}`);
  console.log(`  Consec neg bars/4    : avg ${avg(g.map(r => r.consNegBars)).toFixed(1)}`);
  console.log(`  Max retrace (pts)    : avg ${avg(g.map(r => r.maxRetrace)).toFixed(0)}  [${Math.min(...g.map(r => r.maxRetrace)).toFixed(0)} – ${Math.max(...g.map(r => r.maxRetrace)).toFixed(0)}]`);
}

// ─── PATTERN FINGERPRINT ──────────────────────────────────────────────────────
console.log("\n\n" + "═".repeat(76));
console.log("PATTERN FINGERPRINT — WIN vs PARTIAL vs FAIL");
console.log("═".repeat(76));

const wins    = results.filter(r => r.ev.outcome === "WIN");
const partial = results.filter(r => r.ev.outcome === "PARTIAL");
const fails   = results.filter(r => r.ev.outcome === "FAIL");

const dims = [
  { name: "CVD15 CVD @ zone",      w: avg(wins.map(r=>r.cvdZoneCvd)),               p: avg(partial.map(r=>r.cvdZoneCvd)),               f: avg(fails.map(r=>r.cvdZoneCvd)) },
  { name: "CVD15 priceΔ @ zone",   w: avg(wins.map(r=>r.cvdZonePriceDelta)),         p: avg(partial.map(r=>r.cvdZonePriceDelta)),         f: avg(fails.map(r=>r.cvdZonePriceDelta)) },
  { name: "CVD15 CVD @ touch",     w: avg(wins.map(r=>r.cvdTouchCvd)),              p: avg(partial.map(r=>r.cvdTouchCvd)),              f: avg(fails.map(r=>r.cvdTouchCvd)) },
  { name: "CVD15 priceΔ @ touch",  w: avg(wins.map(r=>r.cvdTouchPriceDelta)),        p: avg(partial.map(r=>r.cvdTouchPriceDelta)),        f: avg(fails.map(r=>r.cvdTouchPriceDelta)) },
  { name: "Approach bars",         w: avg(wins.map(r=>r.approachBars)),              p: avg(partial.map(r=>r.approachBars)),              f: avg(fails.map(r=>r.approachBars)) },
  { name: "Approach delta%",       w: avg(wins.map(r=>r.approachDeltaPct)),          p: avg(partial.map(r=>r.approachDeltaPct)),          f: avg(fails.map(r=>r.approachDeltaPct)) },
  { name: "Ask size @ zone (K)",   w: avg(wins.map(r=>r.askSzA/1000)),              p: avg(partial.map(r=>r.askSzA/1000)),              f: avg(fails.map(r=>r.askSzA/1000)) },
  { name: "Ask size @ touch (K)",  w: avg(wins.map(r=>r.askSzB/1000)),              p: avg(partial.map(r=>r.askSzB/1000)),              f: avg(fails.map(r=>r.askSzB/1000)) },
  { name: "Ask size change (K)",   w: avg(wins.map(r=>r.askSzChange/1000)),         p: avg(partial.map(r=>r.askSzChange/1000)),         f: avg(fails.map(r=>r.askSzChange/1000)) },
  { name: "Ask level change",      w: avg(wins.map(r=>r.askLvlChange)),             p: avg(partial.map(r=>r.askLvlChange)),             f: avg(fails.map(r=>r.askLvlChange)) },
  { name: "Touch delta%",          w: avg(wins.map(r=>r.touchDeltaPct)),            p: avg(partial.map(r=>r.touchDeltaPct)),            f: avg(fails.map(r=>r.touchDeltaPct)) },
  { name: "Absorption net delta",  w: avg(wins.map(r=>r.absNetDelta)),              p: avg(partial.map(r=>r.absNetDelta)),              f: avg(fails.map(r=>r.absNetDelta)) },
  { name: "N1 delta",              w: avg(wins.map(r=>r.nxt1Delta)),                p: avg(partial.map(r=>r.nxt1Delta)),                f: avg(fails.map(r=>r.nxt1Delta)) },
  { name: "N2 delta",              w: avg(wins.map(r=>r.nxt2Delta)),                p: avg(partial.map(r=>r.nxt2Delta)),                f: avg(fails.map(r=>r.nxt2Delta)) },
  { name: "Consec neg bars",       w: avg(wins.map(r=>r.consNegBars)),              p: avg(partial.map(r=>r.consNegBars)),              f: avg(fails.map(r=>r.consNegBars)) },
];

console.log(`\n${"Dimension".padEnd(26)} ${"WIN avg".padStart(12)} ${"PARTIAL avg".padStart(12)} ${"FAIL avg".padStart(12)}`);
console.log("─".repeat(64));
for (const d of dims) {
  const s = (n: number) => ((n >= 0 ? "+" : "") + n.toFixed(1)).padStart(12);
  console.log(`${d.name.padEnd(26)} ${s(d.w)} ${s(d.p)} ${s(d.f)}`);
}

ticksDb.close();
