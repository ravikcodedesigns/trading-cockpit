import fs from 'node:fs';
import { config } from '../config.js';
import { state } from '../state.js';
import { logger } from '../logger.js';
import { resetLevelTestCounts } from '../rules-v2/rs-level-scorer.js';
import type { AdditionalLevel, DailyLevels, LmCode, Symbol } from '@trading/contracts';

interface RawLevel {
  symbol: Symbol;
  // RS structural levels — optional for non-RS-tracked instruments (e.g., ES Step 1).
  bullZone?: { low: number; high: number };
  bearZone?: { low: number; high: number };
  ddBands?: { upper: number; lower: number };
  hedgePressure?: number; // HP — Weekly Hedge Pressure
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

// Track mtime per file so any source change re-triggers the load.
const lastMtimes: Map<string, number> = new Map();

function loadAndApply(): void {
  // All source files for this load (primary + per-instrument extras).
  const sources = [config.levelsPath, ...(config.levelsExtraPaths ?? [])]
    .filter(p => fs.existsSync(p));
  if (sources.length === 0) {
    logger.warn({ paths: [config.levelsPath, ...(config.levelsExtraPaths ?? [])] }, 'no levels files found');
    state.setConnection('levels', 'disconnected');
    return;
  }

  try {
    // Skip reload only if NO file changed since last run.
    let anyChanged = false;
    for (const p of sources) {
      const stat = fs.statSync(p);
      if (lastMtimes.get(p) !== stat.mtimeMs) { anyChanged = true; lastMtimes.set(p, stat.mtimeMs); }
    }
    if (!anyChanged) return;

    // Build a unified map of date -> levels by merging all source files.
    // Per-symbol entries are concatenated (multiple files can contribute to the
    // same trading day, one entry per symbol).
    const byDate: Record<string, RawLevel[]> = {};

    for (const p of sources) {
      const raw = fs.readFileSync(p, 'utf-8');
      const data = JSON.parse(raw) as FileShape;

      if (data.days && typeof data.days === 'object') {
        for (const [date, entry] of Object.entries(data.days)) {
          if (entry && Array.isArray(entry.levels)) {
            byDate[date] = (byDate[date] ?? []).concat(entry.levels);
          }
        }
      }

      // Backward-compat: legacy single-levels array → treat as today's trading day.
      if (data.levels && Array.isArray(data.levels)) {
        const todayKey = todayInNY();
        byDate[todayKey] = (byDate[todayKey] ?? []).concat(data.levels);
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
        // Auto-compute LM code if openPrice + mhp + RS fields are present and no manual override.
        // Skipped automatically for stub entries (e.g., ES Step 1) where RS fields are absent.
        let lmCode = lv.lmCode;
        if (
          !lmCode && lv.openPrice !== undefined && lv.mhp !== undefined &&
          lv.hedgePressure !== undefined && lv.bullZone && lv.bearZone
        ) {
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

  // Watch every source file (primary + extras). fs.watch fires multiple times
  // for one save; debounce via mtime check inside loadAndApply.
  // 5s poll is a safety net for atomic-rename editors.
  const sources = [config.levelsPath, ...(config.levelsExtraPaths ?? [])];
  for (const p of sources) {
    if (!fs.existsSync(p)) continue;
    try {
      fs.watch(p, { persistent: false }, () => {
        setTimeout(loadAndApply, 50);
      });
    } catch (err) {
      logger.warn({ err, path: p }, 'fs.watch failed for source; polling fallback only');
    }
  }
  setInterval(loadAndApply, 5000);
}
