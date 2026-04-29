import dotenv from 'dotenv';
import path from 'node:path';

// pnpm runs each workspace from its own directory; .env lives at repo root
const repoRoot = path.resolve(process.cwd(), '../..');
dotenv.config({ path: path.join(repoRoot, '.env') });

export const config = {
  port: parseInt(process.env.AGGREGATOR_PORT ?? '8787', 10),
  dbPath: process.env.DB_PATH
  ? path.resolve(repoRoot, process.env.DB_PATH)
  : path.join(repoRoot, 'data', 'trading.db'),
    levelsPath: process.env.LEVELS_PATH
    ? path.resolve(repoRoot, process.env.LEVELS_PATH)
    : path.join(repoRoot, 'daily_levels.json'),
  discordWebhook: process.env.DISCORD_WEBHOOK ?? '',
  flashAlpha: {
    url: process.env.FLASHALPHA_URL ?? '',
    pollMs: parseInt(process.env.FLASHALPHA_POLL_MS ?? '60000', 10),
  },
  logLevel: process.env.LOG_LEVEL ?? 'info',
  isProd: process.env.NODE_ENV === 'production',
};
