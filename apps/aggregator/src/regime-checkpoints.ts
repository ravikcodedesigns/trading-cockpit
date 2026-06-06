import { db } from './db.js';
import { state } from './state.js';
import { logger } from './logger.js';
import { tradingDayFor } from '@trading/contracts';
import type { DailyLevels } from '@trading/contracts';

type FactorDir = 'bull' | 'bear' | null;
type RegimeLabel = 'BULL STRONG' | 'BULL WEAK' | 'NEUTRAL' | 'BEAR WEAK' | 'BEAR STRONG';

interface RawBar {
  ts: number;
  open: number; high: number; low: number; close: number;
  buyVolume: number; sellVolume: number;
}

interface Factor { name: string; dir: FactorDir }
interface CheckpointResult {
  time: string;
  etMin: number;
  label: RegimeLabel | null;
  factors: Factor[];
}

// Returns the ET date string and ET time components for a given UTC ms.
function etComponents(tsMs: number): { date: string; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '0';
  const y = get('year'), m = get('month'), d = get('day');
  return {
    date: `${y}-${m}-${d}`,
    hour: parseInt(get('hour'), 10),
    minute: parseInt(get('minute'), 10),
  };
}

// Milliseconds until the next occurrence of etHour:etMin on a weekday.
function msUntilNext(etHour: number, etMin: number): number {
  const now = new Date();
  const nyStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const ny = new Date(nyStr);
  const target = new Date(nyStr);
  target.setHours(etHour, etMin, 0, 0);
  let ms = target.getTime() - ny.getTime() + (now.getTime() - ny.getTime());
  if (ms <= 0) ms += 24 * 60 * 60 * 1000;
  return ms;
}

function getRthOpenMs(nowMs: number): number {
  // Use Intl.DateTimeFormat parts to extract ET year/month/day safely.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(nowMs));
  const get = (t: string) => parseInt(parts.find(p => p.type === t)?.value ?? '0', 10);
  const y = get('year'), mo = get('month'), d = get('day');
  // Probe the UTC offset by checking what ET hour 14:30 UTC maps to.
  // EDT (UTC-4): 14:30 UTC → 10:30 ET. EST (UTC-5): 14:30 UTC → 9:30 ET.
  const probeUtc = Date.UTC(y, mo - 1, d, 14, 30, 0);
  const probeEtHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(new Date(probeUtc)),
    10
  );
  // EST: 14:30 UTC = 09:30 ET → offset 5h. EDT: 14:30 UTC = 10:30 ET → offset 4h.
  const offsetH = probeEtHour === 9 ? 5 : 4;
  return Date.UTC(y, mo - 1, d, 9 + offsetH, 30, 0);
}

function computeRegime(
  bars1m: RawBar[],
  bars4h: RawBar[],
  barsDay: RawBar[],
  levels: DailyLevels,
  rthOpenMs: number,
): CheckpointResult[] {
  const rthBars = bars1m.filter(b => b.ts >= rthOpenMs).sort((a, b) => a.ts - b.ts);

  const D1_MS = 1440 * 60_000;
  const H4_MS =  240 * 60_000;
  const H1_MS =   60 * 60_000;

  // Build H1 bars from 1-min data
  const h1Map = new Map<number, RawBar>();
  for (const b of bars1m) {
    const bucket = Math.floor(b.ts / H1_MS) * H1_MS;
    const h = h1Map.get(bucket);
    if (!h) {
      h1Map.set(bucket, { ...b, ts: bucket });
    } else {
      if (b.high > h.high) h.high = b.high;
      if (b.low  < h.low)  h.low  = b.low;
      h.close        = b.close;
      h.buyVolume   += b.buyVolume;
      h.sellVolume  += b.sellVolume;
    }
  }
  const h1Bars = Array.from(h1Map.values()).sort((a, b) => a.ts - b.ts);

  const structDir = (sortedBars: RawBar[], intervalMs: number, beforeMs: number): FactorDir => {
    const done  = sortedBars.filter(b => b.ts + intervalMs <= beforeMs);
    const last  = done.at(-1) ?? null;
    const prior = done.at(-2) ?? null;
    if (!last) return null;
    const range = last.high - last.low;
    const pos   = range > 0 ? (last.close - last.low) / range : 0.5;
    const trend = prior === null ? 0 : last.close > prior.close ? 1 : last.close < prior.close ? -1 : 0;
    if (pos >= 0.5 && trend >= 0) return 'bull';
    if (pos <  0.5 && trend <= 0) return 'bear';
    return null;
  };

  const closeOf = (etMin: number): number | null => {
    const targetMs = rthOpenMs + (etMin - 570) * 60_000;
    const b = rthBars.find(b => Math.floor(b.ts / 60_000) === Math.floor(targetMs / 60_000));
    return b?.close ?? null;
  };

  const vwapUpTo = (toEtMin: number): number | null => {
    const toMs = rthOpenMs + (toEtMin - 570) * 60_000;
    let sumPV = 0, sumV = 0;
    for (const b of rthBars) {
      if (b.ts >= toMs) break;
      const vol = b.buyVolume + b.sellVolume;
      sumPV += ((b.high + b.low + b.close) / 3) * vol;
      sumV  += vol;
    }
    return sumV > 0 ? sumPV / sumV : null;
  };

  const deltaRange = (fromEtMin: number, toEtMin: number): number => {
    const fromMs = rthOpenMs + (fromEtMin - 570) * 60_000;
    const toMs   = rthOpenMs + (toEtMin   - 570) * 60_000;
    return rthBars
      .filter(b => b.ts >= fromMs && b.ts < toMs)
      .reduce((s, b) => s + b.buyVolume - b.sellVolume, 0);
  };

  const cmp = (price: number | null, level: number | null): FactorDir => {
    if (price === null || level === null) return null;
    return price > level ? 'bull' : price < level ? 'bear' : null;
  };

  const ddDir = (price: number | null): FactorDir => {
    if (price === null || !levels.ddBands) return null;
    const { upper, lower } = levels.ddBands;
    if (upper === lower) return null;
    return ((price - lower) / (upper - lower)) > 0.5 ? 'bull' : 'bear';
  };

  const greaterMkt = (price: number | null): FactorDir => {
    if (price === null) return null;
    if (levels.bullZone && price > levels.bullZone.high) return 'bull';
    if (levels.bearZone && price < levels.bearZone.low)  return 'bear';
    return null;
  };

  const deltaDir = (d: number): FactorDir => d > 0 ? 'bull' : d < 0 ? 'bear' : null;

  const getAL = (part: string): number | null =>
    levels.additionalLevels?.find(l => l.label.toUpperCase().includes(part.toUpperCase()))?.price ?? null;

  const toLabel = (factors: Factor[]): RegimeLabel | null => {
    const nonNull = factors.filter(f => f.dir !== null);
    if (nonNull.length === 0) return null;
    const bulls = nonNull.filter(f => f.dir === 'bull').length;
    const r = bulls / nonNull.length;
    if (r >= 2 / 3) return 'BULL STRONG';
    if (r > 0.5)    return 'BULL WEAK';
    if (r <= 1 / 3) return 'BEAR STRONG';
    if (r < 0.5)    return 'BEAR WEAK';
    return 'NEUTRAL';
  };

  // ── 09:31 ───────────────────────────────────────────────────────────────
  const cp931 = rthOpenMs + 60_000;
  const p931 = closeOf(571);
  const f931: Factor[] = [
    { name: 'Daily',       dir: structDir(barsDay, D1_MS, cp931) },
    { name: '4H',          dir: structDir(bars4h,  H4_MS, cp931) },
    { name: 'Greater mkt', dir: greaterMkt(p931) },
    { name: 'DD ratio',    dir: ddDir(p931) },
    { name: 'HP',          dir: cmp(p931, levels.hedgePressure ?? null) },
    { name: 'ON HP',       dir: cmp(p931, getAL('ON HP')) },
    { name: 'ON MHP',      dir: cmp(p931, getAL('ON MHP')) },
    { name: 'HG',          dir: cmp(p931, getAL('HG')) },
  ];

  // ── 10:00 ───────────────────────────────────────────────────────────────
  const cp1000 = rthOpenMs + 30 * 60_000;
  const p1000  = closeOf(599);
  const vwap10 = vwapUpTo(600);
  const delta30 = deltaRange(570, 600);
  const orBars  = rthBars.filter(b => b.ts >= rthOpenMs && b.ts < rthOpenMs + 15 * 60_000);
  const orHigh  = orBars.length > 0 ? orBars.reduce((m, b) => Math.max(m, b.high), -Infinity) : null;
  const orLow   = orBars.length > 0 ? orBars.reduce((m, b) => Math.min(m, b.low),  +Infinity) : null;
  const orBreak: FactorDir = p1000 === null ? null
    : orHigh !== null && p1000 > orHigh ? 'bull'
    : orLow  !== null && p1000 < orLow  ? 'bear'
    : null;
  const f1000: Factor[] = [
    { name: 'Daily',     dir: structDir(barsDay, D1_MS, cp1000) },
    { name: '4H',        dir: structDir(bars4h,  H4_MS, cp1000) },
    { name: 'VWAP',      dir: cmp(p1000, vwap10) },
    { name: 'OR break',  dir: orBreak },
    { name: '30m delta', dir: deltaDir(delta30) },
  ];

  // ── 12:00 ───────────────────────────────────────────────────────────────
  const cp1200 = rthOpenMs + 150 * 60_000;
  const p1200  = closeOf(719);
  const vwap12 = vwapUpTo(720);
  const f1200: Factor[] = [
    { name: 'Daily',      dir: structDir(barsDay, D1_MS, cp1200) },
    { name: '4H',         dir: structDir(bars4h,  H4_MS, cp1200) },
    { name: 'H1',         dir: structDir(h1Bars,  H1_MS, cp1200) },
    { name: 'VWAP',       dir: cmp(p1200, vwap12) },
    { name: 'Sess delta', dir: deltaDir(deltaRange(570, 720)) },
  ];

  // ── 13:30 ───────────────────────────────────────────────────────────────
  const cp1330 = rthOpenMs + 240 * 60_000;
  const p1330  = closeOf(809);
  const vwap1330 = vwapUpTo(810);
  const mornBars = rthBars.filter(b => b.ts >= rthOpenMs && b.ts < rthOpenMs + 150 * 60_000);
  const mornHigh = mornBars.length > 0 ? mornBars.reduce((m, b) => Math.max(m, b.high), -Infinity) : null;
  const mornLow  = mornBars.length > 0 ? mornBars.reduce((m, b) => Math.min(m, b.low),  +Infinity) : null;
  const vsMorn: FactorDir = p1330 === null ? null
    : mornHigh !== null && p1330 > mornHigh ? 'bull'
    : mornLow  !== null && p1330 < mornLow  ? 'bear'
    : null;
  const f1330: Factor[] = [
    { name: 'Daily',   dir: structDir(barsDay, D1_MS, cp1330) },
    { name: '4H',      dir: structDir(bars4h,  H4_MS, cp1330) },
    { name: 'H1',      dir: structDir(h1Bars,  H1_MS, cp1330) },
    { name: 'VWAP',    dir: cmp(p1330, vwap1330) },
    { name: 'vs morn', dir: vsMorn },
  ];

  return [
    { time: '09:31', etMin: 571, label: p931  !== null ? toLabel(f931)  : null, factors: f931  },
    { time: '10:00', etMin: 600, label: p1000 !== null ? toLabel(f1000) : null, factors: f1000 },
    { time: '12:00', etMin: 720, label: p1200 !== null ? toLabel(f1200) : null, factors: f1200 },
    { time: '13:30', etMin: 810, label: p1330 !== null ? toLabel(f1330) : null, factors: f1330 },
  ];
}

async function fireCheckpoint(symbol: string, checkpointTime: string): Promise<void> {
  const nowMs = Date.now();
  const { date } = etComponents(nowMs);
  const today = tradingDayFor(nowMs);
  const levels = state.levelsForDay(today)?.[symbol as 'NQ' | 'ES'];
  if (!levels) {
    logger.warn({ symbol, checkpoint: checkpointTime, date }, 'regime checkpoint skipped — no levels loaded');
    return;
  }

  // Fetch 1-min (600 min), 4H (7200 min = 5 days), daily (14400 min = 10 days)
  const since1m  = nowMs - 600   * 60_000;
  const since4h  = nowMs - 7200  * 60_000;
  const sinceDay = nowMs - 14400 * 60_000;

  const bars1m  = db.barsForInterval(symbol, since1m,  1)    as RawBar[];
  const bars4h  = db.barsForInterval(symbol, since4h,  240)  as RawBar[];
  const barsDay = db.barsForInterval(symbol, sinceDay, 1440) as RawBar[];

  const rthOpenMs = getRthOpenMs(nowMs);
  const checkpoints = computeRegime(bars1m, bars4h, barsDay, levels, rthOpenMs);
  const cp = checkpoints.find(c => c.time === checkpointTime);

  if (!cp || cp.label === null) {
    logger.warn({ symbol, checkpoint: checkpointTime, date, bars1m: bars1m.length },
      'regime checkpoint computed null label — data may be insufficient');
    return;
  }

  db.logRegime({ date, checkpoint: checkpointTime, symbol, label: cp.label, ts: nowMs, factors: cp.factors });
  logger.info({ symbol, checkpoint: checkpointTime, date, label: cp.label,
    factors: cp.factors.map(f => `${f.name}:${f.dir ?? '?'}`).join(' ') },
    'regime checkpoint stored');
}

// The 4 checkpoints with their ET hour:minute
const CHECKPOINTS: { time: string; hour: number; min: number }[] = [
  { time: '09:31', hour:  9, min: 31 },
  { time: '10:00', hour: 10, min:  0 },
  { time: '12:00', hour: 12, min:  0 },
  { time: '13:30', hour: 13, min: 30 },
];

function isWeekdayET(): boolean {
  const day = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(day);
}

function etMinuteNow(): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => p.find(x => x.type === t)?.value ?? '0';
  return parseInt(g('hour'), 10) * 60 + parseInt(g('minute'), 10);
}

function scheduleCheckpoint(cp: typeof CHECKPOINTS[number], symbol: string): void {
  const fire = () => {
    if (isWeekdayET()) {
      void fireCheckpoint(symbol, cp.time).catch(err =>
        logger.error({ err, symbol, checkpoint: cp.time }, 'regime checkpoint error')
      );
    }
    // Reschedule for the same time next day
    setTimeout(fire, 24 * 60 * 60 * 1000);
  };

  const delay = msUntilNext(cp.hour, cp.min);
  setTimeout(fire, delay);
  logger.info({ symbol, checkpoint: cp.time, msUntilFire: delay }, 'regime checkpoint scheduled');
}

export function startRegimeCheckpoints(): void {
  const symbols = ['NQ', 'ES'];

  for (const symbol of symbols) {
    for (const cp of CHECKPOINTS) {
      scheduleCheckpoint(cp, symbol);
    }
  }

  // Boot-time catch-up: if aggregator starts mid-day, compute any checkpoints
  // that have already passed today and are not yet in the DB.
  if (!isWeekdayET()) return;

  const etMin = etMinuteNow();
  const passedCheckpoints = CHECKPOINTS.filter(cp => cp.hour * 60 + cp.min <= etMin);
  if (passedCheckpoints.length === 0) return;

  const today = tradingDayFor(Date.now());
  // Small delay so DB and state are fully ready
  setTimeout(() => {
    for (const symbol of symbols) {
      const existing = db.query<{ checkpoint: string }>(
        `SELECT checkpoint FROM daily_regimes WHERE date = ? AND symbol = ?`,
        [today, symbol]
      ).map(r => r.checkpoint);

      for (const cp of passedCheckpoints) {
        if (!existing.includes(cp.time)) {
          logger.info({ symbol, checkpoint: cp.time, today }, 'boot catch-up: computing missed regime checkpoint');
          void fireCheckpoint(symbol, cp.time).catch(err =>
            logger.error({ err, symbol, checkpoint: cp.time }, 'boot catch-up regime error')
          );
        }
      }
    }
  }, 5_000);
}
