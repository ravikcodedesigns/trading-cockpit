import { startServer } from './server.js';
import { tickDb } from './db.js';
import { logger } from './logger.js';

process.on('SIGINT', () => {
  logger.info('SIGINT received, closing db');
  tickDb.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, closing db');
  tickDb.close();
  process.exit(0);
});

startServer().catch((err) => {
  logger.error({ err }, 'tick-store failed to start');
  process.exit(1);
});
