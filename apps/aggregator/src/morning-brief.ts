// Overnight analysis briefing sent to Discord at 9:00 AM ET.
//
// Queries ticks.db directly (read-only) to compute:
//   - Previous RTH OHLCV  (9:30 AM – 4:15 PM ET prev trading day)
//   - Overnight OHLCV     (4:15 PM prev day – 9:00 AM ET today)
//   - Gap, delta, key level comparisons, direction bias score

import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { discord } from './discord.js';
import { getTodayEvents } from './economic-calendar.js';
import type { EconEvent } from './economic-calendar.js';

const ticksDbPath = path.join(path.dirname(config.dbPath), 'ticks.db');

// ── Types ────────────────────────────────────────────────────────────────────

interface OHLCV {
  open: number;
  high: number;
  low: number;
  close: number;
  buyVol: number;
  sellVol: number;
  tradeCount: number;
}

// ── Time helpers ─────────────────────────────────────────────────────────────

// Convert a NY local date + time to UTC epoch ms.
// Probes the UTC offset at noon on that date, which is stable (no DST crossover).
function nyToUtcMs(nyDateStr: string, hour: number, minute: number): number {
  const parts = nyDateStr.split('-').map(Number) as [number, number, number];
  const [y, m, d] = parts;
  const noonUtcMs = Date.UTC(y, m - 1, d, 12, 0, 0);
  const nyHourAtNoonUtc = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    }).format(noonUtcMs)
  );
  const offsetHrs = 12 - nyHourAtNoonUtc; // e.g. 12 - 8 = 4 (EDT), 12 - 7 = 5 (EST)
  return Date.UTC(y, m - 1, d, hour + offsetHrs, minute, 0);
}


function dateNY(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(ms).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2');
}

// Steps back from today to the most recent weekday (Mon–Fri).
function prevTradingDayStr(todayStr: string): string {
  const parts = todayStr.split('-').map(Number) as [number, number, number];
  const [y, m, d] = parts;
  let msCandidate = Date.UTC(y, m - 1, d) - 86_400_000;
  while (true) {
    const dow = new Date(msCandidate).getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) break;
    msCandidate -= 86_400_000;
  }
  const prev = new Date(msCandidate);
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
}

// Short weekday name for a YYYY-MM-DD string
function weekdayLabel(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(new Date(dateStr + 'T12:00:00Z'));
}

// ── DB helpers ───────────────────────────────────────────────────────────────

function getOHLCV(db: Database.Database, symbol: string, fromMs: number, toMs: number): OHLCV | null {
  type AggRow = { high: number; low: number; buy_vol: number; sell_vol: number; cnt: number };
  const agg = db.prepare(`
    SELECT MAX(price) AS high, MIN(price) AS low,
           SUM(CASE WHEN is_bid_aggressor = 0 THEN size ELSE 0 END) AS buy_vol,
           SUM(CASE WHEN is_bid_aggressor = 1 THEN size ELSE 0 END) AS sell_vol,
           COUNT(*) AS cnt
    FROM trades WHERE symbol = ? AND ts BETWEEN ? AND ?
  `).get(symbol, fromMs, toMs) as AggRow;

  if (!agg || agg.cnt === 0) return null;

  type PriceRow = { price: number };
  const first = db.prepare(
    'SELECT price FROM trades WHERE symbol = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC, id ASC LIMIT 1'
  ).get(symbol, fromMs, toMs) as PriceRow;
  const last = db.prepare(
    'SELECT price FROM trades WHERE symbol = ? AND ts BETWEEN ? AND ? ORDER BY ts DESC, id DESC LIMIT 1'
  ).get(symbol, fromMs, toMs) as PriceRow;

  return {
    open: first.price, high: agg.high,
    low: agg.low, close: last.price,
    buyVol: agg.buy_vol, sellVol: agg.sell_vol,
    tradeCount: agg.cnt,
  };
}

// ── Bias scoring ─────────────────────────────────────────────────────────────

interface BiasResult {
  score: number;       // -5 to +5
  label: string;
  bullets: string[];
}

function computeBias(prevRTH: OHLCV, overnight: OHLCV): BiasResult {
  let score = 0;
  const bullets: string[] = [];

  // 1. Gap direction (gap = ON close vs prev RTH close)
  const gap = overnight.close - prevRTH.close;
  if (gap >= 30) {
    score += 2;
    bullets.push(`↑ Gap UP **${Math.abs(gap).toFixed(2)} pts** — strong continuation`);
  } else if (gap >= 10) {
    score += 1;
    bullets.push(`↑ Gap up **${Math.abs(gap).toFixed(2)} pts**`);
  } else if (gap <= -30) {
    score -= 2;
    bullets.push(`↓ Gap DOWN **${Math.abs(gap).toFixed(2)} pts** — bearish pressure`);
  } else if (gap <= -10) {
    score -= 1;
    bullets.push(`↓ Gap down **${Math.abs(gap).toFixed(2)} pts**`);
  } else {
    bullets.push(`→ Flat gap (${gap >= 0 ? '+' : ''}${gap.toFixed(2)} pts)`);
  }

  // 2. ON high vs prev RTH high
  const hiDiff = overnight.high - prevRTH.high;
  if (hiDiff > 10) {
    score += 1;
    bullets.push(`↑ ON broke above prev RTH high (+**${hiDiff.toFixed(2)} pts**)`);
  } else if (hiDiff < -10) {
    score -= 1;
    bullets.push(`↓ ON high failed to reach prev RTH high (−**${Math.abs(hiDiff).toFixed(2)} pts**)`);
  } else {
    bullets.push(`→ ON high near prev RTH high (${hiDiff >= 0 ? '+' : ''}${hiDiff.toFixed(2)} pts)`);
  }

  // 3. ON low vs prev RTH low
  const loDiff = overnight.low - prevRTH.low;
  if (loDiff >= 10) {
    score += 1;
    bullets.push(`↑ Support held — ON low stayed above prev RTH low (+**${loDiff.toFixed(2)} pts**)`);
  } else if (loDiff < -10) {
    score -= 1;
    bullets.push(`↓ ON broke below prev RTH low (−**${Math.abs(loDiff).toFixed(2)} pts** extension)`);
  } else {
    bullets.push(`→ ON low near prev RTH low (${loDiff >= 0 ? '+' : ''}${loDiff.toFixed(2)} pts)`);
  }

  // 4. Current price position in ON range
  const onRange = overnight.high - overnight.low;
  const pos = onRange > 0 ? (overnight.close - overnight.low) / onRange : 0.5;
  if (pos >= 0.7) {
    score += 1;
    bullets.push(`↑ Price in top **${Math.round(pos * 100)}%** of ON range — strength`);
  } else if (pos <= 0.3) {
    score -= 1;
    bullets.push(`↓ Price in bottom **${Math.round(pos * 100)}%** of ON range — weakness`);
  } else {
    bullets.push(`→ Price in middle of ON range (${Math.round(pos * 100)}%)`);
  }

  // 5. Delta
  const totalVol = overnight.buyVol + overnight.sellVol;
  const buyPct = totalVol > 0 ? overnight.buyVol / totalVol : 0.5;
  if (buyPct >= 0.55) {
    score += 1;
    bullets.push(`↑ Delta buy-heavy: **${(buyPct * 100).toFixed(1)}% buy** — demand dominant`);
  } else if (buyPct <= 0.45) {
    score -= 1;
    bullets.push(`↓ Delta sell-heavy: **${(100 - buyPct * 100).toFixed(1)}% sell** — supply dominant`);
  } else {
    bullets.push(`→ Delta neutral: ${(buyPct * 100).toFixed(1)}% buy / ${(100 - buyPct * 100).toFixed(1)}% sell`);
  }

  let label: string;
  if (score >= 4)      label = '🟢 STRONG BULLISH';
  else if (score >= 2) label = '🟢 BULLISH';
  else if (score >= 1) label = '⬆️ MILD BULLISH';
  else if (score === 0) label = '➡️ NEUTRAL';
  else if (score >= -1) label = '⬇️ MILD BEARISH';
  else if (score >= -3) label = '🔴 BEARISH';
  else                  label = '🔴 STRONG BEARISH';

  return { score, label, bullets };
}

// ── Format helpers ───────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pctStr(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${(n * 100).toFixed(2)}%`;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function fireOvernightBriefing(symbol = 'NQ'): Promise<void> {
  let db: Database.Database | null = null;
  try {
    db = new Database(ticksDbPath, { readonly: true });

    const todayStr = dateNY(Date.now());
    const prevStr = prevTradingDayStr(todayStr);

    // Previous RTH: 9:30 AM – 4:15 PM ET
    const rthStart = nyToUtcMs(prevStr, 9, 30);
    const rthEnd   = nyToUtcMs(prevStr, 16, 15);

    // Overnight: 4:15 PM prev day – 9:00 AM today
    const onStart = rthEnd;
    const onEnd   = nyToUtcMs(todayStr, 9, 0);

    const prevRTH = getOHLCV(db, symbol, rthStart, rthEnd);
    const overnight = getOHLCV(db, symbol, onStart, onEnd);

    if (!overnight) {
      logger.warn({ symbol, prevStr, todayStr }, 'overnight briefing: no overnight tick data, skipping');
      return;
    }

    const todayEvents = getTodayEvents();
    const onRange  = overnight.high - overnight.low;
    const totalVol = overnight.buyVol + overnight.sellVol;
    const buyPct   = totalVol > 0 ? overnight.buyVol / totalVol : 0.5;
    const todayDay = weekdayLabel(todayStr);
    const prevDay  = weekdayLabel(prevStr);
    const newsLine = todayEvents.length > 0
      ? todayEvents.map(e => `⚠️ **${e.short}** at ${e.time_et} ET`).join('  ·  ')
      : '';

    const fields: { name: string; value: string; inline?: boolean }[] = [];

    if (prevRTH) {
      const rthRange = prevRTH.high - prevRTH.low;
      const hiDiff   = overnight.high - prevRTH.high;
      const loDiff   = overnight.low  - prevRTH.low;
      const gap      = overnight.close - prevRTH.close;
      const gapPct   = prevRTH.close > 0 ? gap / prevRTH.close : 0;
      const gapArrow = gap >= 0 ? '▲' : '▼';
      const bias     = computeBias(prevRTH, overnight);

      // Previous RTH
      fields.push({
        name: `📅 Prev RTH — ${prevDay} ${prevStr}`,
        value: `O **${fmt(prevRTH.open)}** · H **${fmt(prevRTH.high)}** · L **${fmt(prevRTH.low)}** · C **${fmt(prevRTH.close)}**\nRange: **${fmt(rthRange)} pts**`,
      });

      // Overnight with context
      const onLoDiff = loDiff < -10 ? ` 🔴 (${Math.abs(loDiff).toFixed(2)} pts below prev low)` : loDiff > 10 ? ` 🟢 (held above prev low)` : '';
      fields.push({
        name: '🌙 Overnight Session',
        value: `O ${fmt(overnight.open)} · H **${fmt(overnight.high)}** · L **${fmt(overnight.low)}** · C **${fmt(overnight.close)}**\nRange: **${fmt(onRange)} pts**${onLoDiff}`,
      });

      // Gap
      const gapStatus = gap >= 0
        ? `Gap UP **${fmt(gap)} pts** (${pctStr(gapPct)}) ${gapArrow}`
        : `Gap DOWN **${fmt(Math.abs(gap))} pts** (${pctStr(gapPct)}) ${gapArrow}`;
      fields.push({ name: '📐 Gap at Open', value: gapStatus, inline: true });

      // Key level comparison
      const hiStatus = hiDiff > 10 ? `🟢 +${fmt(hiDiff)} (broke out)` : hiDiff < -10 ? `🔴 −${fmt(Math.abs(hiDiff))} (failed)` : `≈ ${hiDiff >= 0 ? '+' : ''}${fmt(hiDiff)}`;
      const loStatus = loDiff > 10 ? `🟢 +${fmt(loDiff)} (held)` : loDiff < -10 ? `🔴 −${fmt(Math.abs(loDiff))} (extended)` : `≈ ${loDiff >= 0 ? '+' : ''}${fmt(loDiff)}`;
      fields.push({
        name: '🎯 vs Prev RTH Levels',
        value: `ON High vs prev high: ${hiStatus}\nON Low  vs prev low:  ${loStatus}`,
      });

      // Delta
      fields.push({
        name: '⚖️ Overnight Delta',
        value: `Buy **${(buyPct * 100).toFixed(1)}%** · Sell **${(100 - buyPct * 100).toFixed(1)}%** · ${totalVol.toLocaleString()} contracts`,
        inline: true,
      });

      // Bias
      fields.push({
        name: `📊 Direction Bias: ${bias.label} (${bias.score > 0 ? '+' : ''}${bias.score}/5)`,
        value: bias.bullets.join('\n'),
      });

      const biasColor = bias.score >= 2 ? 0x00b050 : bias.score <= -2 ? 0xd64545 : 0xf2a633;

      if (newsLine) fields.push({ name: '📰 Economic Events Today', value: newsLine });

      discord.send({
        title: `${gapArrow} ${symbol} Pre-Open Brief — ${todayDay} ${todayStr}  |  ${bias.label}`,
        description: newsLine
          ? 'High-impact news day. **Reduce position size.** Watch for spike reversals and wide stops.'
          : `Pre-open read for ${symbol}. RTH opens at 9:30 ET.`,
        color: biasColor,
        fields,
        timestamp: new Date().toISOString(),
      });

      logger.info({ symbol, prevStr, todayStr, gap, biasScore: bias.score, biasLabel: bias.label }, 'overnight briefing sent');
      return;
    }

    // Partial brief — overnight only, no prev RTH comparison yet (first day of data capture)
    fields.push({
      name: '🌙 Overnight Session',
      value: `O ${fmt(overnight.open)} · H **${fmt(overnight.high)}** · L **${fmt(overnight.low)}** · C **${fmt(overnight.close)}**\nRange: **${fmt(onRange)} pts**`,
    });
    fields.push({
      name: '⚖️ Overnight Delta',
      value: `Buy **${(buyPct * 100).toFixed(1)}%** · Sell **${(100 - buyPct * 100).toFixed(1)}%** · ${totalVol.toLocaleString()} contracts`,
    });

    if (newsLine) {
      fields.push({ name: '📰 Economic Events Today', value: newsLine });
    }

    discord.send({
      title: `➡️ ${symbol} Pre-Open Brief — ${todayDay} ${todayStr}  |  Overnight only (no prev RTH data)`,
      description: newsLine
        ? 'High-impact news day. **Reduce position size.** Watch for spike reversals and wide stops.'
        : `Pre-open overnight data for ${symbol}. Prev RTH comparison available from tomorrow.`,
      color: 0x4a8fdc,
      fields,
      timestamp: new Date().toISOString(),
    });

    logger.info({ symbol, prevStr, todayStr }, 'overnight briefing sent (partial — no prevRTH)');

  } catch (err) {
    logger.error({ err }, 'fireOvernightBriefing failed');
  } finally {
    db?.close();
  }
}
