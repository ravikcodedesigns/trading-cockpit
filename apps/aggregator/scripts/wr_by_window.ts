import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trDb    = new Database(path.resolve(__dirname, "../../../data/trading.db"), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, "../../../data/ticks.db"),   { readonly: true });

// Active trade parameters
const TP = 80;
const SL: Record<string, number> = {
  cfLong:  55,
  cfShort: 105,
  expl:    70,
  abso:    140,
};

const WINDOWS = [
  { label: "09:30–09:59", lo: 570, hi: 600 },
  { label: "10:00–10:29", lo: 600, hi: 630 },
  { label: "10:30–11:29", lo: 630, hi: 690 },
  { label: "11:30–12:59", lo: 690, hi: 780 },
  { label: "13:00–14:29", lo: 780, hi: 870 },
  { label: "14:30–15:59", lo: 870, hi: 960 },
];

function etParts(ms: number) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ms));
}

function etMinute(ms: number): number {
  const parts = etParts(ms);
  const h = parseInt(parts.find(p => p.type === "hour")!.value, 10);
  const m = parseInt(parts.find(p => p.type === "minute")!.value, 10);
  return h * 60 + m;
}

function isRTH(ms: number): boolean {
  const parts = etParts(ms);
  const wd  = parts.find(p => p.type === "weekday")!.value;
  const tot = etMinute(ms);
  return ["Mon","Tue","Wed","Thu","Fri"].includes(wd) && tot >= 570 && tot < 960;
}

// End of RTH session for a given signal ts
function rthEnd(ms: number): number {
  // 16:00 ET = 16*60*60*1000 ms into ET day
  // Easier: add up to 7h from signal (max remaining RTH is ~6.5h)
  // We scan until 16:00 ET = minute 960
  // Compute start-of-ET-day then add 960 minutes
  const d = new Date(ms);
  const etStr = d.toLocaleDateString("en-US", { timeZone: "America/New_York" });
  const [m, day, y] = etStr.split("/").map(Number);
  // midnight ET in UTC
  const midnightET = new Date(`${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}T00:00:00`);
  // Adjust for ET offset: EDT = UTC-4, EST = UTC-5
  // Use a safe approach: find 16:00 ET by adding hours
  const rth16 = new Date(midnightET);
  rth16.setUTCHours(20, 0, 0, 0); // 20:00 UTC = 16:00 EDT (UTC-4)
  // If signal is after 20:00 UTC it means EST (UTC-5), use 21:00 UTC
  // Simple check: if computed end is before signal, add 1h
  if (rth16.getTime() <= ms) rth16.setUTCHours(21, 0, 0, 0);
  return rth16.getTime();
}

const fwdQuery = ticksDb.prepare(
  `SELECT ts, price FROM trades WHERE symbol='NQ' AND ts > ? AND ts <= ? ORDER BY ts ASC`
);
const entryQuery = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? ORDER BY ts ASC LIMIT 1`
);

function getEntry(ts: number, payload: string): number {
  const p = JSON.parse(payload);
  if (p.entry && p.entry > 1000) return p.entry;
  const row = entryQuery.get(ts) as any;
  return row?.price ?? 0;
}

// Returns true if TP is hit before SL, scanning chronologically to end of RTH
function isWin(ts: number, ep: number, dir: "long" | "short", sl: number): boolean {
  if (ep <= 0) return false;
  const end = rthEnd(ts);
  const trades = fwdQuery.all(ts, end) as { ts: number; price: number }[];
  for (const t of trades) {
    const pnl = dir === "long" ? t.price - ep : ep - t.price;
    if (pnl >= TP)  return true;   // TP hit first
    if (pnl <= -sl) return false;  // SL hit first
  }
  return false; // neither hit by EOD
}

interface Sig { ts: number; ep: number; dir: "long" | "short"; sl: number }

function loadSignals(query: string, dir: "long" | "short", slKey: string): Sig[] {
  const rows = trDb.prepare(query).all() as any[];
  return rows
    .filter(s => isRTH(s.ts))
    .map(s => ({ ts: s.ts, ep: getEntry(s.ts, s.payload), dir, sl: SL[slKey] }));
}

// CF long: NQ only, rs_hard_filtered, meta.filtered, delta15 < 500, delta5 <= -1000 (sellers dominant),
//          EXPL conflict check (opposing EXPL in 60-min window with ratio > 0.25 → silenced)
const cfLong = (trDb.prepare(`
  WITH expl_sig AS (
    SELECT ts AS expl_ts, direction AS expl_dir,
      CAST(json_extract(payload,'$.delta5') AS REAL)  AS expl_d5,
      CAST(json_extract(payload,'$.deltaT') AS REAL)  AS expl_dT
    FROM signals
    WHERE rule_id='expl' AND strategy_version='EXPL' AND symbol='NQ'
  ),
  cf AS (
    SELECT ts, payload,
      CAST(json_extract(payload,'$.delta5') AS REAL) AS delta5
    FROM signals
    WHERE rule_id='clean-impulse' AND direction='long' AND strategy_version='H' AND symbol='NQ'
      AND rs_hard_filtered IS NOT 1
      AND json_extract(meta, '$.filtered') IS NOT 1
      AND json_extract(payload, '$.pattern') = 'FLIP'
      AND (json_extract(payload,'$.delta15') IS NULL OR CAST(json_extract(payload,'$.delta15') AS REAL) < 500)
      AND CAST(json_extract(payload,'$.delta5') AS REAL) <= -1000
  ),
  -- Get the most recent opposing EXPL (short) in the 60-min window before each CF long
  opp_expl AS (
    SELECT cf.ts AS cf_ts,
      e.expl_ts AS last_opp_ts,
      e.expl_d5 AS opp_d5,
      e.expl_dT AS opp_dT
    FROM cf
    JOIN expl_sig e ON e.expl_dir = 'short'
      AND e.expl_ts >= cf.ts - 3600000 AND e.expl_ts < cf.ts
      AND e.expl_ts = (
        SELECT MAX(e2.expl_ts) FROM expl_sig e2
        WHERE e2.expl_dir = 'short'
          AND e2.expl_ts >= cf.ts - 3600000 AND e2.expl_ts < cf.ts
      )
  ),
  same_expl AS (
    SELECT cf.ts AS cf_ts,
      MAX(e.expl_ts) AS last_same_ts
    FROM cf
    JOIN expl_sig e ON e.expl_dir = 'long'
      AND e.expl_ts >= cf.ts - 3600000 AND e.expl_ts < cf.ts
    GROUP BY cf.ts
  ),
  conflict AS (
    SELECT cf.ts, cf.payload,
      o.last_opp_ts,
      s.last_same_ts,
      CASE WHEN o.last_opp_ts IS NOT NULL
            AND (s.last_same_ts IS NULL OR o.last_opp_ts > s.last_same_ts)
           THEN 1 ELSE 0 END AS has_conflict,
      -- ratio uses only EXPL signal's own values (matching quality.ts logic)
      ABS(o.opp_dT) * 1.0 / MAX(ABS(o.opp_d5), 1) AS ratio
    FROM cf
    LEFT JOIN opp_expl o ON o.cf_ts = cf.ts
    LEFT JOIN same_expl s ON s.cf_ts = cf.ts
  )
  SELECT ts, payload FROM conflict
  WHERE NOT (has_conflict = 1 AND ratio > 0.25)
  ORDER BY ts
`).all() as any[])
  .filter(s => isRTH(s.ts))
  .map(s => ({ ts: s.ts, ep: getEntry(s.ts, s.payload), dir: "long" as const, sl: SL.cfLong }));
// CF short: NQ only, rs_hard_filtered, meta.filtered, delta5 >= 1000 (buyers dominant → reversal short)
const cfShort = loadSignals(`
  SELECT ts, payload FROM signals
  WHERE rule_id='clean-impulse' AND direction='short' AND strategy_version='H' AND symbol='NQ'
    AND rs_hard_filtered IS NOT 1
    AND json_extract(meta, '$.filtered') IS NOT 1
    AND json_extract(payload, '$.pattern') = 'FLIP'
    AND CAST(json_extract(payload,'$.delta5') AS REAL) >= 1000
  ORDER BY ts`,
  "short", "cfShort"
);
// EXPL long: NQ only, rs_hard_filtered, meta.filtered, zones > 0, rangePct >= 0.5 or null
const explLong = (trDb.prepare(`
  SELECT ts, payload,
    CAST(json_extract(payload,'$.rangePct') AS REAL) AS rangePct,
    json_array_length(json_extract(payload,'$.stackedBidZones')) AS zones
  FROM signals
  WHERE rule_id='expl' AND direction='long' AND strategy_version='EXPL' AND symbol='NQ'
    AND rs_hard_filtered IS NOT 1
    AND json_extract(meta, '$.filtered') IS NOT 1
  ORDER BY ts
`).all() as any[])
  .filter(s => isRTH(s.ts) && s.zones > 0 && (s.rangePct === null || s.rangePct >= 0.5))
  .map(s => ({ ts: s.ts, ep: getEntry(s.ts, s.payload), dir: "long" as const, sl: SL.expl }));

// ABSO long: NQ only, rs_hard_filtered, meta.filtered, score >= 80
const absoLong = loadSignals(`
  SELECT ts, payload FROM signals
  WHERE rule_id='absorption' AND direction='long' AND strategy_version='B' AND symbol='NQ'
    AND score >= 80
    AND rs_hard_filtered IS NOT 1
    AND json_extract(meta, '$.filtered') IS NOT 1
  ORDER BY ts`,
  "long", "abso"
);

console.log(`Loaded: CF↑=${cfLong.length}  CF↓=${cfShort.length}  EXPL↑=${explLong.length}  ABSO↑=${absoLong.length}`);
console.log(`Win condition: TP=+${TP}pts hit before SL (CF↑${SL.cfLong} CF↓${SL.cfShort} EXPL${SL.expl} ABSO${SL.abso}), scans to end of RTH\n`);

function wrByWindow(sigs: Sig[]): { n: number; wins: number }[] {
  return WINDOWS.map(w => {
    const inWin = sigs.filter(s => {
      const m = etMinute(s.ts);
      return m >= w.lo && m < w.hi;
    });
    const wins = inWin.filter(s => isWin(s.ts, s.ep, s.dir, s.sl)).length;
    return { n: inWin.length, wins };
  });
}

const cfLongWR  = wrByWindow(cfLong);
const cfShortWR = wrByWindow(cfShort);
const explWR    = wrByWindow(explLong);
const absoWR    = wrByWindow(absoLong);

function fmt(stat: { n: number; wins: number }): string {
  if (stat.n === 0) return "—";
  const pct = Math.round(stat.wins / stat.n * 100);
  const warn = pct < 60 ? " ⚠" : "";
  return `${pct}% (n=${stat.n})${warn}`;
}

console.log("=== TIME & WR TABLE (TP=80pts, SL per strategy, scan to EOD) ===\n");
console.log("WINDOW          | CF↑                | CF↓                | EXPL↑              | ABSO↑");
console.log("----------------|--------------------|--------------------|--------------------|-----------------");
for (let i = 0; i < WINDOWS.length; i++) {
  const w   = WINDOWS[i];
  const cf  = fmt(cfLongWR[i]).padEnd(19);
  const cfs = fmt(cfShortWR[i]).padEnd(19);
  const ex  = fmt(explWR[i]).padEnd(19);
  const ab  = fmt(absoWR[i]).padEnd(18);
  console.log(`${w.label.padEnd(16)}| ${cf}| ${cfs}| ${ex}| ${ab}`);
}

console.log("\n=== WR_ROWS for Chart.tsx ===\n");
for (let i = 0; i < WINDOWS.length; i++) {
  const w   = WINDOWS[i];
  const cf  = fmt(cfLongWR[i]);
  const cfs = fmt(cfShortWR[i]);
  const ex  = fmt(explWR[i]);
  const ab  = fmt(absoWR[i]);
  console.log(`  { window: '${w.label}', lo: ${w.lo}, hi: ${w.hi}, cf: '${cf}', cfs: '${cfs}', expl: '${ex}', abso: '${ab}' },`);
}
