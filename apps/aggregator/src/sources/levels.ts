import fs from 'node:fs';
import { config } from '../config.js';
import { state } from '../state.js';
import { logger } from '../logger.js';
import type { DailyLevels, Symbol } from '@trading/contracts';

interface RawLevel {
  symbol: Symbol;
  bullZone: { low: number; high: number };
  bearZone: { low: number; high: number };
  ddBands: { upper: number; lower: number };
  hedgePressure: number;
  notes?: string;
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
    const data = JSON.parse(raw) as { levels?: RawLevel[] };

    if (!Array.isArray(data.levels)) {
      logger.warn('levels file missing levels[] array');
      return;
    }

    const ts = Date.now();
    let count = 0;
    for (const lv of data.levels) {
      if (!lv.symbol) continue;
      const event: DailyLevels = {
        ts,
        source: 'levels',
        type: 'daily',
        symbol: lv.symbol,
        bullZone: lv.bullZone,
        bearZone: lv.bearZone,
        ddBands: lv.ddBands,
        hedgePressure: lv.hedgePressure,
        notes: lv.notes,
      };
      state.applyEvent(event);
      count++;
    }

    state.setConnection('levels', 'connected');
    logger.info({ count }, 'levels loaded');
  } catch (err) {
    logger.warn({ err }, 'failed to load levels');
    state.setConnection('levels', 'disconnected');
  }
}

export function startLevelsWatcher(): void {
  loadAndApply();

  // fs.watch can fire multiple times for one save; debounce via mtime check above.
  // Also poll every 5s as a safety net (some editors do atomic-rename which fs.watch misses).
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
