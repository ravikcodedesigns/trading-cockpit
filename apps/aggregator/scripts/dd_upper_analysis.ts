import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKS_DB = path.resolve(__dirname, "../../../data/ticks.db");
const ticksDb = new Database(TICKS_DB, { readonly: true });

// DD bands per trading day (from daily_levels.json)
const DD_LEVELS: Record<string, { upper: number; lower: number }> = {
  "2026-05-06": { upper: 28458.17, lower: 27956.33 },
  "2026-05-07": { upper: 28962.84, lower: 28461.66 },
  "2026-05-18": { upper: 29422.81, lower: 28923.19 },
  "2026-05-19": { upper: 28879.25, lower: 28873.65 },
  "2026-05-20": { upper: 29149.24, lower: 28649.26 },
  "2026-05-21": { upper: 29528.71, lower: 29028.29 },
  "2026-05-22": { upper: 29705.26, lower: 29205.74 },
};

interface Bar {
  mb: number;
  time: string;
  low: number;
  high: number;
  vol: number;
  delta: number;
  close: number;
}

function getRthBars(day: string): Bar[] {
  return ticksDb
    .prepare(
      `
    SELECT ts/1000/60 as mb,
           datetime(ts/1000,'unixepoch','localtime') as time,
           MIN(price) as low, MAX(price) as high,
           SUM(size) as vol,
           SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) as delta,
           LAST_VALUE(price) OVER (
             PARTITION BY ts/1000/60 ORDER BY ts
             ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
           ) as close
    FROM trades
    WHERE symbol='NQ'
      AND date(ts/1000,'unixepoch','localtime')=?
      AND time(ts/1000,'unixepoch','localtime') BETWEEN '09:30:00' AND '16:00:00'
    GROUP BY ts/1000/60
    ORDER BY mb
  `
    )
    .all(day) as Bar[];
}

type TpResult = { pts: number; barsToHit: number | null };

function pad(s: string | number, n: number, right = false): string {
  const str = String(s);
  if (right) return str.padEnd(n);
  return str.padStart(n);
}

const summaryRows: any[] = [];

for (const [day, { upper: ddUpper, lower: ddLower }] of Object.entries(DD_LEVELS)) {
  const bars = getRthBars(day);

  if (!bars.length) {
    console.log(`\n${day}: NO TICK DATA`);
    continue;
  }

  const dayHigh = Math.max(...bars.map((b) => b.high));
  const dayLow = Math.min(...bars.map((b) => b.low));

  // Find first bar where high touched/crossed upper DD (within 2 pts tolerance)
  const touchIdx = bars.findIndex((b) => b.high >= ddUpper - 2);

  if (touchIdx === -1) {
    console.log(
      `\n${day}: DD upper=${ddUpper} NEVER TOUCHED — day high=${dayHigh.toFixed(2)}`
    );
    continue;
  }

  const touchBar = bars[touchIdx];
  const overshoot = Math.max(0, touchBar.high - ddUpper);

  // Pre-touch: 5 bars before touch
  const preBars = bars.slice(Math.max(0, touchIdx - 5), touchIdx);
  const preDelta = preBars.reduce((s, b) => s + b.delta, 0);
  const preVol = preBars.reduce((s, b) => s + b.vol, 0);
  const preAbsorption = preVol > 0 ? ((preDelta / preVol) * 100).toFixed(1) : "n/a";

  const touchDeltaPct =
    touchBar.vol > 0
      ? ((touchBar.delta / touchBar.vol) * 100).toFixed(1)
      : "n/a";

  // Post-touch bars (up to 60 bars = 60 mins)
  const postBars = bars.slice(touchIdx); // includes touch bar at [0]

  // Max extension above DD in first 10 bars (did it run further up first?)
  const maxHighAfter = Math.max(
    touchBar.high,
    ...postBars.slice(1, 11).map((b) => b.high)
  );
  const maxExtAboveDd = maxHighAfter - ddUpper;

  // Max retracement: lowest low in post-touch bars
  let runningLow = touchBar.high;
  const tpTargetPts = [20, 30, 40, 50, 60, 80, 100];
  const tpHits: TpResult[] = tpTargetPts.map((pts) => ({ pts, barsToHit: null }));

  for (let j = 1; j < postBars.slice(0, 61).length; j++) {
    const pb = postBars[j];
    if (pb.low < runningLow) runningLow = pb.low;
    const retrace = touchBar.high - runningLow;
    for (const tp of tpHits) {
      if (tp.barsToHit === null && pb.low <= touchBar.high - tp.pts) {
        tp.barsToHit = j;
      }
    }
  }
  const maxRetrace = touchBar.high - runningLow;

  // Max adverse move (how far above did it go before retracing?)
  // SL analysis: max extension above DD upper in 10 bars
  const maxSl = maxExtAboveDd;

  console.log(`\n${"=".repeat(72)}`);
  console.log(
    `DAY: ${day}  |  DD Upper: ${ddUpper}  |  DD Lower: ${ddLower}`
  );
  console.log(
    `Day range: ${dayLow.toFixed(2)} – ${dayHigh.toFixed(2)}  |  RTH bars: ${bars.length}`
  );
  console.log(
    `First DD-upper touch: ${touchBar.time.slice(11, 16)}  |  Bar: L=${touchBar.low} H=${touchBar.high} C=${touchBar.close}`
  );
  console.log(
    `Overshoot above DD: +${overshoot.toFixed(2)} pts  |  Max extension (10-bar): +${maxExtAboveDd.toFixed(2)} pts`
  );
  console.log(
    `Pre-touch 5-bar delta: ${preDelta >= 0 ? "+" : ""}${preDelta} on vol ${preVol} (${preAbsorption}% buy imbalance)`
  );
  console.log(
    `Touch bar: vol=${touchBar.vol}  delta=${touchBar.delta >= 0 ? "+" : ""}${touchBar.delta} (${touchDeltaPct}%)`
  );
  console.log(`Max retracement: ${maxRetrace.toFixed(2)} pts`);
  process.stdout.write("TP hits (mins after touch bar): ");
  for (const tp of tpHits) {
    process.stdout.write(
      `  TP${tp.pts}=${tp.barsToHit !== null ? tp.barsToHit + "m" : "  X"}`
    );
  }
  console.log();

  // Show 20 bars post-touch
  console.log(
    `\n${"Time".padEnd(22)} ${"Low".padStart(9)} ${"High".padStart(9)} ${"Close".padStart(9)} ${"Vol".padStart(7)} ${"Delta".padStart(8)}`
  );
  for (let j = 0; j < Math.min(21, postBars.length); j++) {
    const pb = postBars[j];
    const marker = j === 0 ? " ← TOUCH" : "";
    console.log(
      `${pb.time.padEnd(22)} ${pb.low.toFixed(2).padStart(9)} ${pb.high.toFixed(2).padStart(9)} ${pb.close.toFixed(2).padStart(9)} ${String(pb.vol).padStart(7)} ${(pb.delta >= 0 ? "+" : "") + pb.delta}${marker}`
    );
  }

  summaryRows.push({
    day,
    ddUpper,
    touchTime: touchBar.time.slice(11, 16),
    overshoot: overshoot.toFixed(1),
    maxExt: maxExtAboveDd.toFixed(1),
    maxRetrace: maxRetrace.toFixed(1),
    preDeltaPct: preAbsorption,
    touchDeltaPct,
    tpHits,
  });
}

// ─── SUMMARY TABLE ────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(72)}`);
console.log("SUMMARY — Upper DD Band Touch from Below → Short Retracement");
console.log(`${"=".repeat(72)}`);
console.log(
  `${"Day".padEnd(12)} ${"DDU".padStart(9)} ${"Touch".padStart(6)} ${"OvrShot".padStart(8)} ${"MaxExt+".padStart(8)} ${"MaxRet".padStart(8)} ${"TP20".padStart(6)} ${"TP30".padStart(6)} ${"TP40".padStart(6)} ${"TP50".padStart(6)} ${"TP60".padStart(6)}`
);
for (const r of summaryRows) {
  const tp = r.tpHits;
  const fmt = (x: TpResult) => (x.barsToHit !== null ? x.barsToHit + "m" : "  X");
  console.log(
    `${r.day.padEnd(12)} ${String(r.ddUpper).padStart(9)} ${r.touchTime.padStart(6)} ${("+" + r.overshoot).padStart(8)} ${("+" + r.maxExt).padStart(8)} ${r.maxRetrace.padStart(8)} ${fmt(tp[0]).padStart(6)} ${fmt(tp[1]).padStart(6)} ${fmt(tp[2]).padStart(6)} ${fmt(tp[3]).padStart(6)} ${fmt(tp[4]).padStart(6)}`
  );
}

// ─── AGGREGATE STATS ──────────────────────────────────────────────────────────
if (summaryRows.length > 0) {
  console.log(`\n--- AGGREGATE STATS (${summaryRows.length} touch events) ---`);
  const retraces = summaryRows.map((r) => parseFloat(r.maxRetrace));
  const exts = summaryRows.map((r) => parseFloat(r.maxExt));
  const overshoots = summaryRows.map((r) => parseFloat(r.overshoot));

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const min = (arr: number[]) => Math.min(...arr);
  const max2 = (arr: number[]) => Math.max(...arr);

  console.log(
    `Max retracement  — avg: ${avg(retraces).toFixed(1)} pts  min: ${min(retraces).toFixed(1)} pts  max: ${max2(retraces).toFixed(1)} pts`
  );
  console.log(
    `Max extension+   — avg: ${avg(exts).toFixed(1)} pts  min: ${min(exts).toFixed(1)} pts  max: ${max2(exts).toFixed(1)} pts`
  );
  console.log(
    `Overshoot        — avg: ${avg(overshoots).toFixed(1)} pts  min: ${min(overshoots).toFixed(1)} pts  max: ${max2(overshoots).toFixed(1)} pts`
  );

  for (const tpPts of [20, 30, 40, 50]) {
    const tpIdx = [20, 30, 40, 50, 60, 80, 100].indexOf(tpPts);
    const hits = summaryRows.filter(
      (r) => r.tpHits[tpIdx].barsToHit !== null
    ).length;
    const hitTimes = summaryRows
      .filter((r) => r.tpHits[tpIdx].barsToHit !== null)
      .map((r) => r.tpHits[tpIdx].barsToHit as number);
    const avgTime = hitTimes.length > 0 ? avg(hitTimes).toFixed(0) : "n/a";
    console.log(
      `TP${tpPts}: hit ${hits}/${summaryRows.length} (${((hits / summaryRows.length) * 100).toFixed(0)}%)  avg time to hit: ${avgTime} min`
    );
  }
}

ticksDb.close();

// ─── PART 2: SECOND TOUCH ANALYSIS + DETAILED ORDERFLOW SIGNATURE ─────────────

export {};
