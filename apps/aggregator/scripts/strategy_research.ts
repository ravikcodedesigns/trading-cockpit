/**
 * Full multi-dimensional strategy research script.
 * Analyzes CF↑, CF↓, EXPL↑, ABSO↑ signals that reach the chart.
 * Win = TP hit before SL, tick-by-tick, scanning to end of RTH.
 */
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trDb    = new Database(path.resolve(__dirname, "../../../data/trading.db"), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, "../../../data/ticks.db"),   { readonly: true });

// ─── Parameters ───────────────────────────────────────────────────────────────
const TP = 80;
const SL: Record<string, number> = { cfLong: 55, cfShort: 105, expl: 70, abso: 140 };
// Holdout: last N trading days
const HOLDOUT_START = "2026-05-19";

// ─── ET helpers ───────────────────────────────────────────────────────────────
function etMinute(ms: number): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ms));
  return parseInt(p.find(x => x.type === "hour")!.value) * 60 + parseInt(p.find(x => x.type === "minute")!.value);
}

function etDate(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ms)).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2");
}

function isRTH(ms: number): boolean {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ms));
  const wd = p.find(x => x.type === "weekday")!.value;
  const h  = parseInt(p.find(x => x.type === "hour")!.value);
  const m  = parseInt(p.find(x => x.type === "minute")!.value);
  return ["Mon","Tue","Wed","Thu","Fri"].includes(wd) && (h * 60 + m) >= 570 && (h * 60 + m) < 960;
}

function rthStart(ms: number): number {
  const d = new Date(ms);
  const s = d.toLocaleDateString("en-US", { timeZone: "America/New_York" }).split("/");
  const base = new Date(`${s[2]}-${s[0].padStart(2,"0")}-${s[1].padStart(2,"0")}T00:00:00Z`);
  base.setUTCHours(13, 30, 0, 0); // 09:30 ET = 13:30 UTC (EDT)
  if (base.getTime() > ms) base.setUTCHours(14, 30, 0, 0); // EST fallback
  return base.getTime();
}

function rthEnd(ms: number): number {
  const d = new Date(ms);
  const s = d.toLocaleDateString("en-US", { timeZone: "America/New_York" }).split("/");
  const base = new Date(`${s[2]}-${s[0].padStart(2,"0")}-${s[1].padStart(2,"0")}T00:00:00Z`);
  base.setUTCHours(20, 0, 0, 0); // 16:00 ET = 20:00 UTC (EDT)
  if (base.getTime() <= ms) base.setUTCHours(21, 0, 0, 0);
  return base.getTime();
}

// ─── Prepared statements ──────────────────────────────────────────────────────
const fwdTrades = ticksDb.prepare(
  `SELECT ts, price FROM trades WHERE symbol='NQ' AND ts > ? AND ts <= ? ORDER BY ts ASC`
);
const sessionTrades = ticksDb.prepare(
  `SELECT size, is_bid_aggressor FROM trades WHERE symbol='NQ' AND ts >= ? AND ts <= ? ORDER BY ts ASC`
);
const entryTick = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? ORDER BY ts ASC LIMIT 1`
);

// ─── Outcome computation ──────────────────────────────────────────────────────
interface Outcome {
  win: boolean; mae: number; mfe: number; tpMins: number | null; slMins: number | null; eodPnl: number;
}

function computeOutcome(signalTs: number, ep: number, dir: "long"|"short", sl: number): Outcome {
  const end   = rthEnd(signalTs);
  const trades = fwdTrades.all(signalTs, end) as { ts: number; price: number }[];
  let mae = 0, mfe = 0;
  for (const t of trades) {
    const pnl = dir === "long" ? t.price - ep : ep - t.price;
    if (pnl > mfe) mfe = pnl;
    if (-pnl > mae) mae = -pnl;
    if (pnl >= TP)  return { win: true,  mae, mfe, tpMins: (t.ts - signalTs) / 60_000, slMins: null, eodPnl: TP };
    if (pnl <= -sl) return { win: false, mae, mfe, tpMins: null, slMins: (t.ts - signalTs) / 60_000, eodPnl: -sl };
  }
  const last = trades.at(-1);
  const eod  = last ? (dir === "long" ? last.price - ep : ep - last.price) : 0;
  return { win: false, mae, mfe, tpMins: null, slMins: null, eodPnl: eod };
}

function getEntry(ts: number, payload: string): number {
  const p = JSON.parse(payload);
  if (p.entry && p.entry > 1000) return p.entry;
  const row = entryTick.get(ts) as any;
  return row?.price ?? 0;
}

// ─── Session delta at signal time ─────────────────────────────────────────────
function sessionDelta(signalTs: number): number {
  const start = rthStart(signalTs);
  const rows  = sessionTrades.all(start, signalTs) as { size: number; is_bid_aggressor: number }[];
  return rows.reduce((d, r) => d + r.size * (r.is_bid_aggressor ? 1 : -1), 0);
}

// ─── Load signals ─────────────────────────────────────────────────────────────
interface Signal {
  ts: number; ep: number; dir: "long"|"short"; sl: number; slKey: string;
  score: number; delta5: number; delta15: number; rangePct: number | null; zones: number;
  ctxGm: string; ctxLm: string; ctxDdRatio: number | null;
  etMin: number; etDateStr: string; isHoldout: boolean;
  payload: any;
}

function loadSigs(query: string, dir: "long"|"short", slKey: string): Signal[] {
  return (trDb.prepare(query).all() as any[])
    .filter(s => isRTH(s.ts))
    .map(s => {
      const p = JSON.parse(s.payload);
      const ep = getEntry(s.ts, s.payload);
      const d = etDate(s.ts);
      return {
        ts: s.ts, ep, dir, sl: SL[slKey], slKey,
        score: s.score ?? 0,
        delta5:  p.delta5  ?? 0,
        delta15: p.delta15 ?? 0,
        rangePct: p.rangePct ?? null,
        zones: p.stackedBidZones?.length ?? 0,
        ctxGm:     s.ctx_gm     ?? "unknown",
        ctxLm:     s.ctx_lm_code ?? "unknown",
        ctxDdRatio: s.ctx_dd_ratio ?? null,
        etMin: etMinute(s.ts),
        etDateStr: d,
        isHoldout: d >= HOLDOUT_START,
        payload: p,
      };
    });
}

const CF_LONG_WHERE = `
  rule_id='clean-impulse' AND direction='long' AND strategy_version='H'
  AND rs_hard_filtered IS NOT 1 AND json_extract(meta,'$.filtered') IS NOT 1
  AND json_extract(payload,'$.pattern')='FLIP'
  AND (json_extract(payload,'$.delta15') IS NULL OR CAST(json_extract(payload,'$.delta15') AS REAL) < 500)
  AND ABS(CAST(json_extract(payload,'$.delta5') AS REAL)) >= 1000`;
const CF_SHORT_WHERE = `
  rule_id='clean-impulse' AND direction='short' AND strategy_version='H'
  AND rs_hard_filtered IS NOT 1 AND json_extract(meta,'$.filtered') IS NOT 1
  AND json_extract(payload,'$.pattern')='FLIP'
  AND ABS(CAST(json_extract(payload,'$.delta5') AS REAL)) >= 1000`;
const EXPL_WHERE = `
  rule_id='expl' AND direction='long' AND strategy_version='EXPL'
  AND rs_hard_filtered IS NOT 1 AND json_extract(meta,'$.filtered') IS NOT 1`;
const ABSO_WHERE = `
  rule_id='absorption' AND direction='long' AND strategy_version='B' AND score >= 80
  AND rs_hard_filtered IS NOT 1 AND json_extract(meta,'$.filtered') IS NOT 1`;

const SELECT = `SELECT ts, score, payload, ctx_gm, ctx_lm_code, ctx_dd_ratio`;

const cfLong  = loadSigs(`${SELECT} FROM signals WHERE ${CF_LONG_WHERE} ORDER BY ts`, "long",  "cfLong");
const cfShort = loadSigs(`${SELECT} FROM signals WHERE ${CF_SHORT_WHERE} ORDER BY ts`, "short", "cfShort");
const explLong = loadSigs(`${SELECT},
  CAST(json_extract(payload,'$.rangePct') AS REAL) AS rangePct,
  json_array_length(json_extract(payload,'$.stackedBidZones')) AS zones
  FROM signals WHERE ${EXPL_WHERE} ORDER BY ts`, "long", "expl")
  .filter(s => s.zones > 0 && (s.rangePct === null || s.rangePct >= 0.5));
const absoLong = loadSigs(`${SELECT} FROM signals WHERE ${ABSO_WHERE} ORDER BY ts`, "long", "abso");

console.log(`\nLoaded: CF↑=${cfLong.length}  CF↓=${cfShort.length}  EXPL↑=${explLong.length}  ABSO↑=${absoLong.length}`);
console.log(`Holdout from ${HOLDOUT_START}\n`);

// ─── Enrich signals with outcomes + session delta ─────────────────────────────
interface EnrichedSignal extends Signal {
  out: Outcome; sessDelta: number; sessDeltaBucket: string;
}

function enrich(sigs: Signal[]): EnrichedSignal[] {
  return sigs.map(s => {
    const out = s.ep > 0 ? computeOutcome(s.ts, s.ep, s.dir, s.sl) : { win: false, mae: 0, mfe: 0, tpMins: null, slMins: null, eodPnl: 0 };
    const sd  = sessionDelta(s.ts);
    const sdB = sd < -5000 ? "strongly bearish (<-5k)" :
                sd < -1000 ? "bearish (-5k to -1k)" :
                sd < 1000  ? "neutral (-1k to +1k)" :
                sd < 5000  ? "bullish (+1k to +5k)" : "strongly bullish (>+5k)";
    return { ...s, out, sessDelta: sd, sessDeltaBucket: sdB };
  });
}

console.log("Computing outcomes + session delta (this takes a minute)...");
const ecfLong  = enrich(cfLong);
const ecfShort = enrich(cfShort);
const eExpl    = enrich(explLong);
const eAbso    = enrich(absoLong);
console.log("Done.\n");

// ─── Analysis helpers ─────────────────────────────────────────────────────────
const LINE = "─".repeat(90);
const DLINE = "═".repeat(90);

function pct(n: number, d: number) { return d === 0 ? " —  " : `${Math.round(100*n/d)}%`.padStart(4); }
function exp(wr: number, tp: number, sl: number) { return (wr * tp - (1 - wr) * sl).toFixed(1); }
function expStr(wins: number, n: number, tp: number, sl: number) {
  if (n === 0) return "   —";
  const wr = wins / n;
  const e  = wr * tp - (1 - wr) * sl;
  return `${e >= 0 ? "+" : ""}${e.toFixed(1)}`.padStart(7);
}
function flag(n: number) { return n < 10 ? "⚠" : " "; }

function printTable(
  rows: { label: string; wins: number; n: number }[],
  tp: number, sl: number, title: string
) {
  console.log(`  ${title}`);
  console.log(`  ${"BUCKET".padEnd(35)} ${"n".padStart(4)} ${"WR".padStart(5)} ${"E[PnL]".padStart(8)}  flag`);
  console.log(`  ${LINE.slice(0,60)}`);
  for (const r of rows) {
    if (r.n === 0) continue;
    const wr  = r.wins / r.n;
    const e   = wr * tp - (1 - wr) * sl;
    const f   = flag(r.n);
    console.log(`  ${r.label.padEnd(35)} ${String(r.n).padStart(4)} ${pct(r.wins,r.n).padStart(5)} ${expStr(r.wins,r.n,tp,sl).padStart(8)}  ${f}`);
  }
  console.log();
}

function breakdown<T extends EnrichedSignal>(
  sigs: T[], key: (s: T) => string, tp: number, sl: number, title: string
) {
  const map = new Map<string, { wins: number; n: number }>();
  for (const s of sigs) {
    const k = key(s);
    if (!map.has(k)) map.set(k, { wins: 0, n: 0 });
    const r = map.get(k)!;
    r.n++;
    if (s.out.win) r.wins++;
  }
  const rows = [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, { wins, n }]) => ({ label, wins, n }));
  printTable(rows, tp, sl, title);
}

function printBlock(label: string, sigs: EnrichedSignal[], tp: number, sl: number) {
  const n    = sigs.length;
  const wins = sigs.filter(s => s.out.win).length;
  const wr   = wins / n;
  const ex   = wr * tp - (1 - wr) * sl;

  const train = sigs.filter(s => !s.isHoldout);
  const hold  = sigs.filter(s => s.isHoldout);
  const trWins = train.filter(s => s.out.win).length;
  const hoWins = hold.filter(s => s.out.win).length;
  const trEx = train.length > 0 ? ((trWins/train.length)*tp - (1-trWins/train.length)*sl).toFixed(1) : "—";
  const hoEx = hold.length  > 0 ? ((hoWins/hold.length)*tp  - (1-hoWins/hold.length)*sl).toFixed(1)  : "—";

  console.log(`\n${DLINE}`);
  console.log(`  ${label}  |  n=${n}  WR=${pct(wins,n)}  E[PnL]=${expStr(wins,n,tp,sl)}  |  train E=${trEx}  holdout E=${hoEx}`);
  console.log(DLINE);

  // ── 1. Time of day (30-min buckets) ────────────────────────────────────────
  console.log("\n── 1. TIME OF DAY (30-min buckets) ────────────────────────────────────");
  const timeBuckets = [
    [570,600],[600,630],[630,660],[660,690],[690,720],[720,750],[750,780],[780,810],[810,840],[840,870],[870,900],[900,930],[930,960]
  ].map(([lo,hi]) => {
    const grp = sigs.filter(s => s.etMin >= lo && s.etMin < hi);
    const w   = grp.filter(s => s.out.win).length;
    const hh  = String(Math.floor(lo/60)).padStart(2,"0");
    const mm  = String(lo%60).padStart(2,"0");
    const hh2 = String(Math.floor((hi-1)/60)).padStart(2,"0");
    const mm2 = String((hi-1)%60).padStart(2,"0");
    return { label: `${hh}:${mm}–${hh2}:${mm2}`, wins: w, n: grp.length };
  });
  printTable(timeBuckets, tp, sl, "");

  // ── 2. Regime: ctx_gm ──────────────────────────────────────────────────────
  console.log("── 2a. REGIME: ctx_gm ─────────────────────────────────────────────────");
  breakdown(sigs, s => s.ctxGm || "null", tp, sl, "");

  // ── 2b. Regime: ctx_lm_code ───────────────────────────────────────────────
  console.log("── 2b. REGIME: ctx_lm_code ────────────────────────────────────────────");
  breakdown(sigs, s => s.ctxLm || "null", tp, sl, "");

  // ── 2c. Regime: ctx_dd_ratio ──────────────────────────────────────────────
  console.log("── 2c. REGIME: ctx_dd_ratio (DD band position) ────────────────────────");
  const ddBuckets = ["<0.3","0.3–0.5","0.5–0.65","0.65–0.8",">0.8"].map(lbl => {
    const grp = sigs.filter(s => {
      const r = s.ctxDdRatio;
      if (r === null) return false;
      if (lbl === "<0.3")    return r < 0.3;
      if (lbl === "0.3–0.5") return r >= 0.3 && r < 0.5;
      if (lbl === "0.5–0.65")return r >= 0.5 && r < 0.65;
      if (lbl === "0.65–0.8")return r >= 0.65 && r < 0.8;
      return r >= 0.8;
    });
    return { label: `ddRatio ${lbl}`, wins: grp.filter(s => s.out.win).length, n: grp.length };
  });
  printTable(ddBuckets, tp, sl, "");

  // ── 3. Signal strength ────────────────────────────────────────────────────
  console.log("── 3a. SIGNAL STRENGTH: score ─────────────────────────────────────────");
  const scoreBuckets = ["<70","70–79","80–89",">=90"].map(lbl => {
    const grp = sigs.filter(s => {
      const sc = s.score;
      if (lbl === "<70")  return sc < 70;
      if (lbl === "70–79")return sc >= 70 && sc < 80;
      if (lbl === "80–89")return sc >= 80 && sc < 90;
      return sc >= 90;
    });
    return { label: `score ${lbl}`, wins: grp.filter(s=>s.out.win).length, n: grp.length };
  });
  printTable(scoreBuckets, tp, sl, "");

  if (label.includes("CF")) {
    console.log("── 3b. SIGNAL STRENGTH: |delta5| buckets ──────────────────────────────");
    const d5Buckets = ["1k–2k","2k–3k","3k–5k",">5k"].map(lbl => {
      const grp = sigs.filter(s => {
        const d = Math.abs(s.delta5);
        if (lbl === "1k–2k") return d >= 1000 && d < 2000;
        if (lbl === "2k–3k") return d >= 2000 && d < 3000;
        if (lbl === "3k–5k") return d >= 3000 && d < 5000;
        return d >= 5000;
      });
      return { label: `|delta5| ${lbl}`, wins: grp.filter(s=>s.out.win).length, n: grp.length };
    });
    printTable(d5Buckets, tp, sl, "");

    console.log("── 3c. SIGNAL STRENGTH: delta15 (long: negative = sellers dominant) ──");
    const d15Buckets = ["<-3k","-3k–-1k","-1k–0","0–500"].map(lbl => {
      const grp = sigs.filter(s => {
        const d = s.delta15;
        if (lbl === "<-3k")    return d < -3000;
        if (lbl === "-3k–-1k") return d >= -3000 && d < -1000;
        if (lbl === "-1k–0")   return d >= -1000 && d < 0;
        return d >= 0 && d < 500;
      });
      return { label: `delta15 ${lbl}`, wins: grp.filter(s=>s.out.win).length, n: grp.length };
    });
    printTable(d15Buckets, tp, sl, "");
  }

  // ── 5. Session delta ──────────────────────────────────────────────────────
  console.log("── 5. SESSION DELTA AT SIGNAL TIME ────────────────────────────────────");
  breakdown(sigs, s => s.sessDeltaBucket, tp, sl, "");

  // Session delta direction alignment
  if (label.includes("CF↑") || label.includes("EXPL") || label.includes("ABSO")) {
    console.log("── 5b. SESSION DELTA ALIGNED VS AGAINST (long signals) ────────────────");
    const aligned = sigs.filter(s => s.sessDelta < 0); // bearish session = buyers exhausted = supports long reversal
    const against = sigs.filter(s => s.sessDelta >= 0);
    printTable([
      { label: "sessDelta < 0 (bearish flow, supports long)", wins: aligned.filter(s=>s.out.win).length, n: aligned.length },
      { label: "sessDelta >= 0 (bullish flow, against long)",  wins: against.filter(s=>s.out.win).length, n: against.length },
    ], tp, sl, "");
  }

  // ── 7. MAE for winners ────────────────────────────────────────────────────
  console.log("── 7. MAX ADVERSE EXCURSION (winners only) ────────────────────────────");
  const winners = sigs.filter(s => s.out.win);
  const losers  = sigs.filter(s => !s.out.win);
  if (winners.length > 0) {
    const maes = winners.map(s => s.out.mae);
    const sorted = [...maes].sort((a,b) => a-b);
    const med = sorted[Math.floor(sorted.length/2)]!;
    const avg = maes.reduce((a,b) => a+b, 0) / maes.length;
    const pct10 = maes.filter(m => m > 10).length / maes.length;
    const pct20 = maes.filter(m => m > 20).length / maes.length;
    const pct30 = maes.filter(m => m > 30).length / maes.length;
    console.log(`  Winners (n=${winners.length}): avg MAE=${avg.toFixed(1)}pts  median=${med.toFixed(1)}pts`);
    console.log(`  MAE >10pts: ${Math.round(pct10*100)}%  >20pts: ${Math.round(pct20*100)}%  >30pts: ${Math.round(pct30*100)}%`);
    console.log(`  → SL is ${sl}pts. Winners that dipped >half-SL: ${maes.filter(m=>m>sl/2).length}/${winners.length}`);
  }

  // ── 8. MFE for losers ─────────────────────────────────────────────────────
  console.log("\n── 8. MAX FAVORABLE EXCURSION (losers only) ───────────────────────────");
  if (losers.length > 0) {
    const mfes = losers.map(s => s.out.mfe);
    const avg  = mfes.reduce((a,b) => a+b, 0) / mfes.length;
    const pct20 = mfes.filter(m => m > 20).length / mfes.length;
    const pct40 = mfes.filter(m => m > 40).length / mfes.length;
    const pct50 = mfes.filter(m => m > 50).length / mfes.length;
    console.log(`  Losers (n=${losers.length}): avg MFE=${avg.toFixed(1)}pts`);
    console.log(`  Losers that reached >20pts: ${Math.round(pct20*100)}%  >40pts: ${Math.round(pct40*100)}%  >50pts: ${Math.round(pct50*100)}%`);
    console.log(`  → Losers that would have won at TP=50: ${mfes.filter(m=>m>=50).length}/${losers.length}`);
    console.log(`  → Losers that would have won at TP=60: ${mfes.filter(m=>m>=60).length}/${losers.length}`);
  }
  console.log();

  // ── Sequence context ──────────────────────────────────────────────────────
  console.log("── 6. SEQUENCE CONTEXT ────────────────────────────────────────────────");
  const allExpls = (trDb.prepare(
    `SELECT ts, direction FROM signals WHERE rule_id='expl' AND strategy_version='EXPL'
     AND rs_hard_filtered IS NOT 1 AND json_extract(meta,'$.filtered') IS NOT 1 ORDER BY ts`
  ).all() as any[]);
  const allFlips = (trDb.prepare(
    `SELECT ts, direction FROM signals WHERE rule_id='clean-impulse' AND strategy_version='H'
     AND rs_hard_filtered IS NOT 1 AND json_extract(meta,'$.filtered') IS NOT 1 ORDER BY ts`
  ).all() as any[]);

  const withExpl    = sigs.filter(s => allExpls.some(e => e.direction === s.dir && e.ts < s.ts && e.ts >= s.ts - 60*60_000));
  const withoutExpl = sigs.filter(s => !allExpls.some(e => e.direction === s.dir && e.ts < s.ts && e.ts >= s.ts - 60*60_000));
  const withFlip    = sigs.filter(s => allFlips.some(f => f.direction === s.dir && f.ts < s.ts && f.ts >= s.ts - 30*60_000));
  const withoutFlip = sigs.filter(s => !allFlips.some(f => f.direction === s.dir && f.ts < s.ts && f.ts >= s.ts - 30*60_000));

  printTable([
    { label: "preceded by same-dir EXPL (60m)", wins: withExpl.filter(s=>s.out.win).length, n: withExpl.length },
    { label: "no same-dir EXPL in 60m",         wins: withoutExpl.filter(s=>s.out.win).length, n: withoutExpl.length },
    { label: "preceded by same-dir CF (30m)",    wins: withFlip.filter(s=>s.out.win).length, n: withFlip.length },
    { label: "no same-dir CF in 30m",            wins: withoutFlip.filter(s=>s.out.win).length, n: withoutFlip.length },
  ], tp, sl, "");
}

// ─── Run analysis ─────────────────────────────────────────────────────────────
printBlock("CF↑ (clean-impulse long)",   ecfLong,  TP, SL.cfLong);
printBlock("CF↓ (clean-impulse short)", ecfShort, TP, SL.cfShort);
printBlock("EXPL↑ (explosive long)",    eExpl,    TP, SL.expl);
printBlock("ABSO↑ (absorption long)",   eAbso,    TP, SL.abso);

// ─── Summary table ────────────────────────────────────────────────────────────
console.log(`\n${"█".repeat(90)}`);
console.log("  OVERALL SUMMARY");
console.log("█".repeat(90));
for (const [label, sigs, tp, sl] of [
  ["CF↑",  ecfLong,  TP, SL.cfLong],
  ["CF↓",  ecfShort, TP, SL.cfShort],
  ["EXPL↑",eExpl,    TP, SL.expl],
  ["ABSO↑",eAbso,    TP, SL.abso],
] as const) {
  const n    = (sigs as EnrichedSignal[]).length;
  const wins = (sigs as EnrichedSignal[]).filter(s => s.out.win).length;
  const wr   = wins / n;
  const ex   = (wr * (tp as number) - (1-wr) * (sl as number)).toFixed(1);
  const hold = (sigs as EnrichedSignal[]).filter(s => s.isHoldout);
  const hWins = hold.filter(s => s.out.win).length;
  const hEx = hold.length > 0 ? ((hWins/hold.length)*(tp as number) - (1-hWins/hold.length)*(sl as number)).toFixed(1) : "—";
  console.log(`  ${String(label).padEnd(8)} n=${String(n).padStart(3)}  WR=${pct(wins,n)}  E[PnL]=${String(ex).padStart(7)}  holdout(n=${hold.length}) E=${hEx}`);
}
console.log();
