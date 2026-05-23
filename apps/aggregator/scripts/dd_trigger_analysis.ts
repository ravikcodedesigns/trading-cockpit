/**
 * DD Upper Band — Reversal Trigger Analysis
 *
 * Tests 4 entry methods against all 13 touch events to find the best
 * real-time, automatable short trigger after a DD upper touch.
 *
 * Triggers tested:
 *  T1  Sell-stop at touch-bar low − 1  (fires when price breaks below touch bar range)
 *  T2  First bar after touch with delta < 0 AND high < touch high (lower high + selling)
 *  T3  First bar after touch that closes below touch bar's open (bearish bar)
 *  T4  First bar after touch that closes below DD upper (back inside band)
 *
 * For every trigger:
 *  Entry   = trigger price (stop fill price or bar close)
 *  SL      = highest high from touch bar to trigger bar + 5 pts
 *  MAE     = max adverse excursion (how far price ran against you before TP or SL)
 *  Outcome = TP30 / TP50 / TP100 hit, or SL hit, or neither within 120 bars
 */
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ticksDb = new Database(path.resolve(__dirname, "../../../data/ticks.db"), { readonly: true });

interface TouchEvent {
  label: string;
  day: string;
  entryTime: string;
  ddUpper: number;
  outcome: "WIN" | "PARTIAL" | "FAIL";
}

const EVENTS: TouchEvent[] = [
  { label: "May06",   day: "2026-05-06", entryTime: "09:35", ddUpper: 28458.17, outcome: "FAIL"    },
  { label: "May08",   day: "2026-05-08", entryTime: "09:34", ddUpper: 28962.84, outcome: "FAIL"    },
  { label: "May19-1", day: "2026-05-19", entryTime: "09:30", ddUpper: 28879.25, outcome: "WIN"     },
  { label: "May19-2", day: "2026-05-19", entryTime: "11:42", ddUpper: 28879.25, outcome: "PARTIAL" },
  { label: "May19-3", day: "2026-05-19", entryTime: "12:03", ddUpper: 28879.25, outcome: "PARTIAL" },
  { label: "May19-4", day: "2026-05-19", entryTime: "12:24", ddUpper: 28879.25, outcome: "WIN"     },
  { label: "May20-1", day: "2026-05-20", entryTime: "09:33", ddUpper: 29149.24, outcome: "WIN"     },
  { label: "May20-2", day: "2026-05-20", entryTime: "09:44", ddUpper: 29149.24, outcome: "WIN"     },
  { label: "May21",   day: "2026-05-21", entryTime: "13:52", ddUpper: 29528.71, outcome: "WIN"     },
  { label: "May22-1", day: "2026-05-22", entryTime: "09:40", ddUpper: 29705.26, outcome: "WIN"     },
  { label: "May22-2", day: "2026-05-22", entryTime: "11:28", ddUpper: 29705.26, outcome: "PARTIAL" },
  { label: "May22-3", day: "2026-05-22", entryTime: "13:05", ddUpper: 29705.26, outcome: "WIN"     },
  { label: "May22-4", day: "2026-05-22", entryTime: "13:47", ddUpper: 29705.26, outcome: "PARTIAL" },
];

// ─── BAR DATA ─────────────────────────────────────────────────────────────────
function getRthBars(day: string) {
  return ticksDb.prepare(`
    SELECT ts/1000/60 as mb,
           datetime(ts/1000,'unixepoch','localtime') as time,
           MIN(price) as low, MAX(price) as high,
           FIRST_VALUE(price) OVER (PARTITION BY ts/1000/60 ORDER BY ts
             ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as open,
           LAST_VALUE(price) OVER (PARTITION BY ts/1000/60 ORDER BY ts
             ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as close,
           SUM(size) as vol,
           SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) as delta
    FROM trades WHERE symbol='NQ'
      AND date(ts/1000,'unixepoch','localtime')=?
      AND time(ts/1000,'unixepoch','localtime') BETWEEN '09:00:00' AND '16:05:00'
    GROUP BY ts/1000/60 ORDER BY mb
  `).all(day) as any[];
}

function barAt(bars: any[], hhmm: string) {
  const idx = bars.findIndex((b: any) => b.time.slice(11, 16) === hhmm);
  return idx >= 0 ? { bar: bars[idx], idx } : null;
}

// ─── TP / SL OUTCOME FROM A GIVEN ENTRY ───────────────────────────────────────
// Returns the first TP hit and whether SL was hit before it.
function tradeOutcome(bars: any[], fromIdx: number, entry: number, sl: number) {
  const tpTargets = [30, 50, 100, 150];
  const result: Record<string, number | null> = { tp30: null, tp50: null, tp100: null, tp150: null };
  let slHitBar: number | null = null;
  let maxHigh = entry; // max adverse excursion tracker

  for (let k = 1; k <= 120 && fromIdx + k < bars.length; k++) {
    const b = bars[fromIdx + k];
    maxHigh = Math.max(maxHigh, b.high);

    // SL check first (stop is above entry for a short)
    if (slHitBar === null && b.high >= sl) {
      slHitBar = k;
    }

    // TP checks (only count if SL not yet hit, or SL hit after TP)
    for (const tp of tpTargets) {
      const key = `tp${tp}`;
      if (result[key] === null && b.low <= entry - tp) {
        // Only valid if SL wasn't hit before this bar
        if (slHitBar === null || slHitBar >= k) {
          result[key] = k;
        }
      }
    }
  }

  const mae = maxHigh - entry; // max adverse excursion (pts above entry)
  return { ...result, slHitBar, mae };
}

// ─── TRIGGER SEARCH ───────────────────────────────────────────────────────────
type TriggerResult = {
  name: string;
  fired: boolean;
  barsAfterTouch: number;        // 0 = fires on touch bar itself
  triggerTime: string;
  entryPrice: number;
  slPrice: number;
  slDist: number;                // pts from entry to SL
  mae: number;                   // max adverse excursion in pts
  slHit: boolean;
  tp30: number | null; tp50: number | null; tp100: number | null;
};

function noFire(name: string): TriggerResult {
  return { name, fired: false, barsAfterTouch: -1, triggerTime: "--", entryPrice: 0, slPrice: 0, slDist: 0, mae: 0, slHit: false, tp30: null, tp50: null, tp100: null };
}

function evalTrigger(
  name: string,
  bars: any[],
  touchIdx: number,
  touchBar: any,
  ddUpper: number,
  triggerIdx: number,   // index of the bar that triggered
  entryPrice: number,
): TriggerResult {
  // SL = DD upper + 45 (fixed structural SL — covers full observed overshoot distribution)
  // NOT touch-bar-high + 5: that's too tight, price routinely runs 50-250 pts above touch
  const slPrice = ddUpper + 45;
  const slDist  = slPrice - entryPrice;
  const { tp30, tp50, tp100, tp150, slHitBar, mae } = tradeOutcome(bars, triggerIdx, entryPrice, slPrice);
  return {
    name, fired: true,
    barsAfterTouch: triggerIdx - touchIdx,
    triggerTime: bars[triggerIdx].time.slice(11, 16),
    entryPrice, slPrice, slDist, mae,
    slHit: slHitBar !== null,
    tp30: tp30 as number | null,
    tp50: tp50 as number | null,
    tp100: tp100 as number | null,
  };
}

function findTriggers(bars: any[], touchIdx: number, touchBar: any, ddUpper: number): TriggerResult[] {
  const results: TriggerResult[] = [];
  const scan = bars.slice(touchIdx + 1, touchIdx + 31); // scan up to 30 bars after touch

  // ── T1: Sell-stop at touch bar low − 1 ────────────────────────────────────
  // Entry fires the moment price breaks below the touch bar's low.
  // We find the first bar after touch where low < touchBar.low − 1.
  {
    const entry = touchBar.low - 1;
    let fired = false;
    for (let k = 0; k < scan.length; k++) {
      if (scan[k].low <= entry) {
        results.push(evalTrigger("T1-BreakLow", bars, touchIdx, touchBar, ddUpper, touchIdx + 1 + k, entry));
        fired = true;
        break;
      }
    }
    if (!fired) results.push(noFire("T1-BreakLow"));
  }

  // ── T2: First bar with lower high AND negative delta ──────────────────────
  // Confirms selling pressure AND price not making new highs (failed extension).
  {
    let fired = false;
    for (let k = 0; k < scan.length; k++) {
      const b = scan[k];
      const prevHigh = k === 0 ? touchBar.high : scan[k - 1].high;
      if (b.high < prevHigh && b.delta < 0) {
        results.push(evalTrigger("T2-LowHigh+NegDelta", bars, touchIdx, touchBar, ddUpper, touchIdx + 1 + k, b.close));
        fired = true;
        break;
      }
    }
    if (!fired) results.push(noFire("T2-LowHigh+NegDelta"));
  }

  // ── T3: First bar that closes below touch bar open ─────────────────────────
  // A bar closing below the touch bar's open = buyers fully rejected from that open level.
  {
    let fired = false;
    for (let k = 0; k < scan.length; k++) {
      if (scan[k].close < touchBar.open) {
        results.push(evalTrigger("T3-CloseBelow Open", bars, touchIdx, touchBar, ddUpper, touchIdx + 1 + k, scan[k].close));
        fired = true;
        break;
      }
    }
    if (!fired) results.push(noFire("T3-CloseBelow Open"));
  }

  // ── T4: First bar that closes back below DD upper ──────────────────────────
  // Price accepted back inside the band. Clean structural trigger.
  {
    let fired = false;
    for (let k = 0; k < scan.length; k++) {
      if (scan[k].close < ddUpper) {
        results.push(evalTrigger("T4-CloseInsideBand", bars, touchIdx, touchBar, ddUpper, touchIdx + 1 + k, scan[k].close));
        fired = true;
        break;
      }
    }
    if (!fired) results.push(noFire("T4-CloseInsideBand"));
  }

  return results;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
interface EventResult {
  ev: TouchEvent;
  touchBar: any;
  triggers: TriggerResult[];
}

const allResults: EventResult[] = [];

for (const ev of EVENTS) {
  const bars = getRthBars(ev.day);
  const found = barAt(bars, ev.entryTime);
  if (!found) { console.log(`${ev.label}: bar not found`); continue; }
  const { bar: touchBar, idx: touchIdx } = found;
  const triggers = findTriggers(bars, touchIdx, touchBar, ev.ddUpper);
  allResults.push({ ev, touchBar, triggers });
}

// ─── OUTPUT ───────────────────────────────────────────────────────────────────
const W   = "🟢 WIN    ";
const P   = "🟡 PARTIAL";
const F   = "🔴 FAIL   ";
const tag = (o: string) => o === "WIN" ? W : o === "PARTIAL" ? P : F;
const fmt = (x: number | null) => x != null ? `${x}m` : "  X";
const sgn = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(1);

console.log("\n" + "═".repeat(120));
console.log("DD UPPER BAND — REVERSAL TRIGGER ANALYSIS");
console.log("Testing T1 (break touch low) | T2 (lower high + neg delta) | T3 (close < touch open) | T4 (close inside band)");
console.log("═".repeat(120));

for (const { ev, touchBar, triggers } of allResults) {
  const tb = touchBar;
  console.log(`\n${tag(ev.outcome)} ${ev.label.padEnd(10)} | DD Upper: ${ev.ddUpper}  Touch: ${ev.entryTime}  Bar: O=${tb.open} H=${tb.high} L=${tb.low} C=${tb.close}  Δ=${tb.delta >= 0 ? "+" : ""}${tb.delta}`);
  for (const t of triggers) {
    if (!t.fired) {
      console.log(`  ${t.name.padEnd(22)} : DID NOT FIRE within 30 bars`);
      continue;
    }
    const slTag = t.slHit ? "🛑 SL HIT" : "✓ survived";
    console.log(
      `  ${t.name.padEnd(22)} : @${t.triggerTime} +${t.barsAfterTouch}bars  entry=${t.entryPrice.toFixed(2)}  SL=${t.slPrice.toFixed(2)} (${t.slDist.toFixed(0)}pts)  MAE=+${t.mae.toFixed(0)}pts  ${slTag}  TP30:${fmt(t.tp30)} TP50:${fmt(t.tp50)} TP100:${fmt(t.tp100)}`
    );
  }
}

// ─── AGGREGATE PER TRIGGER ────────────────────────────────────────────────────
console.log("\n\n" + "═".repeat(120));
console.log("TRIGGER PERFORMANCE SUMMARY  (across all 13 events)");
console.log("═".repeat(120));

const triggerNames = ["T1-BreakLow", "T2-LowHigh+NegDelta", "T3-CloseBelow Open", "T4-CloseInsideBand"];

for (const tName of triggerNames) {
  const all     = allResults.map(r => r.triggers.find(t => t.name === tName)!).filter(Boolean);
  const fired   = all.filter(t => t.fired);
  const survived= fired.filter(t => !t.slHit);
  const slHit   = fired.filter(t => t.slHit);
  const tp30hit = survived.filter(t => t.tp30 !== null);
  const tp50hit = survived.filter(t => t.tp50 !== null);
  const tp100hit= survived.filter(t => t.tp100 !== null);

  const avgSlDist = fired.length ? fired.reduce((s,t) => s + t.slDist, 0) / fired.length : 0;
  const avgMae    = fired.length ? fired.reduce((s,t) => s + t.mae, 0) / fired.length : 0;
  const avgBars   = fired.length ? fired.reduce((s,t) => s + t.barsAfterTouch, 0) / fired.length : 0;
  const avgTp50T  = tp50hit.length ? tp50hit.reduce((s,t) => s + (t.tp50 ?? 0), 0) / tp50hit.length : 0;
  const avgTp100T = tp100hit.length ? tp100hit.reduce((s,t) => s + (t.tp100 ?? 0), 0) / tp100hit.length : 0;

  console.log(`\n${tName}`);
  console.log(`  Fired       : ${fired.length}/13  (${(fired.length/13*100).toFixed(0)}%)`);
  console.log(`  Avg bars after touch : ${avgBars.toFixed(1)}`);
  console.log(`  Avg SL dist : ${avgSlDist.toFixed(0)} pts above entry`);
  console.log(`  Avg MAE     : ${avgMae.toFixed(0)} pts  (how far price ran against you after entry)`);
  console.log(`  SL hit      : ${slHit.length}/${fired.length}  (${fired.length ? (slHit.length/fired.length*100).toFixed(0) : 0}%)`);
  console.log(`  TP30 hit    : ${tp30hit.length}/${fired.length}  (${fired.length ? (tp30hit.length/fired.length*100).toFixed(0) : 0}%)  [of all fired, not just survived]`);
  console.log(`  TP50 hit    : ${tp50hit.length}/${fired.length}  (${fired.length ? (tp50hit.length/fired.length*100).toFixed(0) : 0}%)  avg time: ${avgTp50T.toFixed(0)} bars`);
  console.log(`  TP100 hit   : ${tp100hit.length}/${fired.length}  (${fired.length ? (tp100hit.length/fired.length*100).toFixed(0) : 0}%)  avg time: ${avgTp100T.toFixed(0)} bars`);
}

// ─── BY OUTCOME GROUP ─────────────────────────────────────────────────────────
console.log("\n\n" + "═".repeat(120));
console.log("TRIGGER BREAKDOWN BY OUTCOME (WIN / PARTIAL / FAIL)");
console.log("═".repeat(120));

for (const tName of triggerNames) {
  console.log(`\n${tName}`);
  console.log(`  ${"Group".padEnd(10)} ${"Fired".padStart(6)} ${"SL%".padStart(6)} ${"TP50%".padStart(7)} ${"TP100%".padStart(8)} ${"AvgSL".padStart(7)} ${"AvgMAE".padStart(8)}`);
  for (const grp of ["WIN", "PARTIAL", "FAIL"] as const) {
    const evs  = allResults.filter(r => r.ev.outcome === grp);
    const all  = evs.map(r => r.triggers.find(t => t.name === tName)!).filter(Boolean);
    const fired= all.filter(t => t.fired);
    const sl   = fired.filter(t => t.slHit);
    const tp50 = fired.filter(t => !t.slHit && t.tp50 !== null);
    const tp100= fired.filter(t => !t.slHit && t.tp100 !== null);
    const avgSl= fired.length ? fired.reduce((s,t)=>s+t.slDist,0)/fired.length : 0;
    const avgMae=fired.length ? fired.reduce((s,t)=>s+t.mae,0)/fired.length : 0;
    console.log(
      `  ${grp.padEnd(10)} ${`${fired.length}/${evs.length}`.padStart(6)}` +
      ` ${fired.length ? (sl.length/fired.length*100).toFixed(0)+"%" : "n/a".padStart(4)   .padStart(6)}` +
      ` ${fired.length ? (tp50.length/fired.length*100).toFixed(0)+"%" : "n/a".padStart(4)  .padStart(7)}` +
      ` ${fired.length ? (tp100.length/fired.length*100).toFixed(0)+"%" : "n/a".padStart(4) .padStart(8)}` +
      ` ${avgSl.toFixed(0).padStart(7)}` +
      ` ${avgMae.toFixed(0).padStart(8)}`
    );
  }
}

ticksDb.close();
