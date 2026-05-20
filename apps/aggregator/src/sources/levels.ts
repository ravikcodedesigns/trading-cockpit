import fs from 'node:fs';
import { config } from '../config.js';
import { state } from '../state.js';
import { logger } from '../logger.js';
import { resetLevelTestCounts } from '../rules-v2/rs-level-scorer.js';
import type { AdditionalLevel, DailyLevels, LmCode, Symbol } from '@trading/contracts';

interface RawLevel {
  symbol: Symbol;
  bullZone: { low: number; high: number };
  bearZone: { low: number; high: number };
  ddBands: { upper: number; lower: number };
  hedgePressure: number;  // HP — Weekly Hedge Pressure
  mhp?: number;           // MHP — Monthly Hedge Pressure
  openPrice?: number;     // RTH 09:30 open — triggers LM code auto-computation
  lmCode?: LmCode;        // override; computed automatically if absent and openPrice+mhp present
  additionalLevels?: AdditionalLevel[];
  notes?: string;
}

// Derive LM code from open price relative to HP, MHP, and bull/bear zones.
// Returns undefined when open is in LP (between zones) or IP (out-of-range) —
// those edge cases require manual override.
function computeLmCode(
  openPrice: number,
  mhp: number,
  hp: number,
  bullZone: { low: number; high: number },
  bearZone: { low: number; high: number },
): LmCode | undefined {
  const inBullZone = openPrice >= bullZone.low;
  const inBearZone = openPrice <= bearZone.high;
  if (!inBullZone && !inBearZone) return undefined; // LP or IP

  const prefix = inBullZone ? 'B' : 'Br';
  const ls     = openPrice > hp ? 'L' : 'S';
  const du     = mhp > hp       ? 'D' : 'U';
  return `${prefix}${ls}${du}` as LmCode;
}

interface DayEntry {
  levels: RawLevel[];
}

interface FileShape {
  // New shape: date-keyed map of trading-day -> levels
  days?: Record<string, DayEntry>;
  // Legacy shape: single levels array (treated as "today's" trading day)
  levels?: RawLevel[];
}

let lastMtime = 0;

function loadAndApply(): void {
  if (!fs.existsSync(config.levelsPath)) {
    logger.warn({ path: config.levelsPath }, 'levels file not found');
    state.setConnection('levels', 'disconnected');
    return;
  }

  try {
    const stat = fs.statSync(config.levelsPath);
    if (stat.mtimeMs === lastMtime) return;
    lastMtime = stat.mtimeMs;

    const raw = fs.readFileSync(config.levelsPath, 'utf-8');
    const data = JSON.parse(raw) as FileShape;

    // Build a unified map of date -> levels.
    const byDate: Record<string, RawLevel[]> = {};

    if (data.days && typeof data.days === 'object') {
      for (const [date, entry] of Object.entries(data.days)) {
        if (entry && Array.isArray(entry.levels)) {
          byDate[date] = entry.levels;
        }
      }
    }

    // Backward-compat: if file uses old shape (just `levels` array), treat
    // it as today's trading day. This lets existing files keep working.
    if (data.levels && Array.isArray(data.levels)) {
      const todayKey = todayInNY();
      if (!byDate[todayKey]) {
        byDate[todayKey] = data.levels;
      }
    }

    if (Object.keys(byDate).length === 0) {
      logger.warn('levels file has no recognized days[] or levels[]');
      return;
    }

    const ts = Date.now();
    let totalLevels = 0;
    const days: Record<string, DailyLevels[]> = {};

    for (const [tradingDay, levelsArr] of Object.entries(byDate)) {
      const dayLevels: DailyLevels[] = [];
      for (const lv of levelsArr) {
        if (!lv.symbol) continue;
        // Auto-compute LM code if openPrice + mhp are present and no manual override
        let lmCode = lv.lmCode;
        if (!lmCode && lv.openPrice !== undefined && lv.mhp !== undefined) {
          lmCode = computeLmCode(lv.openPrice, lv.mhp, lv.hedgePressure, lv.bullZone, lv.bearZone);
          if (lmCode) {
            logger.info({ symbol: lv.symbol, lmCode, openPrice: lv.openPrice, mhp: lv.mhp, hp: lv.hedgePressure }, 'LM code auto-computed');
          } else {
            logger.warn({ symbol: lv.symbol, openPrice: lv.openPrice }, 'LM code: open in LP/IP zone — set manually');
          }
        }

        const event: DailyLevels = {
          ts,
          source: 'levels',
          type: 'daily',
          symbol: lv.symbol,
          tradingDay,
          bullZone: lv.bullZone,
          bearZone: lv.bearZone,
          ddBands: lv.ddBands,
          hedgePressure: lv.hedgePressure,
          mhp: lv.mhp,
          openPrice: lv.openPrice,
          lmCode,
          additionalLevels: lv.additionalLevels,
          notes: lv.notes,
        };
        dayLevels.push(event);
        totalLevels++;
      }
      days[tradingDay] = dayLevels;
    }

    state.applyAllLevels(days);
    state.setConnection('levels', 'connected');
    // New levels = new session — reset per-level test counts so first-test
    // bonus is correctly awarded from the start of each trading day.
    resetLevelTestCounts();
    logger.info({ days: Object.keys(days).length, totalLevels }, 'levels loaded');
  } catch (err) {
    logger.warn({ err }, 'failed to load levels');
    state.setConnection('levels', 'disconnected');
  }
}

function todayInNY(): string {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(d);
}

export function startLevelsWatcher(): void {
  loadAndApply();

  // fs.watch can fire multiple times for one save; debounce via mtime check.
  // Also poll every 5s as a safety net (some editors do atomic-rename).
  if (fs.existsSync(config.levelsPath)) {
    try {
      fs.watch(config.levelsPath, { persistent: false }, () => {
        setTimeout(loadAndApply, 50);
      });
    } catch (err) {
      logger.warn({ err }, 'fs.watch failed, falling back to polling only');
    }
  }
  setInterval(loadAndApply, 5000);
}
