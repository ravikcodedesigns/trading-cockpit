import 'dotenv/config';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd(), '../..');

// Which strategy engine(s) to run.
// 'A' = bar-based (sweep + divergence) only
// 'B' = tick-based (absorption + sub-second divergence) only
// 'C' = RS level watcher only
// 'BOTH' = run A and B in parallel
// 'ALL'  = run A, B, and C
export type ActiveStrategy = 'A' | 'B' | 'C' | 'D' | 'E' | 'H' | 'BOTH' | 'ALL';

export const config = {
  port: parseInt(process.env.AGGREGATOR_PORT ?? '8787', 10),
  // '127.0.0.1' = localhost only (dev). Set AGGREGATOR_HOST=0.0.0.0 for remote access.
  host: process.env.AGGREGATOR_HOST ?? '127.0.0.1',
  dbPath: process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(repoRoot, 'data', 'trading.db'),
  levelsPath: process.env.LEVELS_PATH
    ? path.resolve(process.env.LEVELS_PATH)
    : path.join(repoRoot, 'daily_levels.json'),
  discordWebhook: process.env.DISCORD_WEBHOOK ?? '',
  flashAlpha: {
    url: process.env.FLASHALPHA_URL ?? '',
    pollMs: parseInt(process.env.FLASHALPHA_POLL_MS ?? '60000', 10),
  },
  logLevel: process.env.LOG_LEVEL ?? 'info',
  isProd: process.env.NODE_ENV === 'production',

  // Strategy engine control
  activeStrategy: (process.env.ACTIVE_STRATEGY ?? 'BOTH') as ActiveStrategy,

  // Tick-store connection (Strategy B reads ticks from here)
  tickStore: {
    baseUrl: process.env.TICK_STORE_URL ?? 'http://127.0.0.1:8788',
    pollMs: parseInt(process.env.TICK_STORE_POLL_MS ?? '500', 10),
  },
};
