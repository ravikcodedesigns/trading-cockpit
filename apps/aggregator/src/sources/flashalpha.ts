import { config } from '../config.js';
import { state } from '../state.js';
import { logger } from '../logger.js';
import { ingest } from '../ingest.js';
import type { Symbol } from '@trading/contracts';

// FlashAlpha integration is a placeholder until we wire your specific MCP setup.
// Three options for how to talk to FlashAlpha from here:
//   1. If FlashAlpha exposes an HTTP endpoint, set FLASHALPHA_URL and we POST/GET it.
//   2. If it's MCP-only, run a tiny local proxy that exposes the same data over HTTP.
//   3. If it's pull-only via Claude Code, dump the snapshot to a JSON file we watch.
//
// For now this poller hits FLASHALPHA_URL?symbol=NQ expecting a JSON response
// matching FlashAlphaSnapshot (minus ts/source/type which we add).

const SYMBOLS: Symbol[] = ['NQ', 'ES'];

async function pollOnce(): Promise<void> {
  if (!config.flashAlpha.url) return;

  for (const symbol of SYMBOLS) {
    try {
      const url = `${config.flashAlpha.url}?symbol=${symbol}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        logger.warn({ status: res.status, symbol }, 'flashalpha non-2xx');
        continue;
      }
      const data = await res.json() as Record<string, unknown>;
      ingest('flashalpha', { type: 'snapshot', symbol, ...data });
    } catch (err) {
      logger.warn({ err, symbol }, 'flashalpha poll failed');
    }
  }
}

export function startFlashAlphaPoller(): void {
  if (!config.flashAlpha.url) {
    logger.info('flashalpha: FLASHALPHA_URL not set, poller disabled');
    state.setConnection('flashalpha', 'disconnected');
    return;
  }

  logger.info(
    { url: config.flashAlpha.url, intervalMs: config.flashAlpha.pollMs },
    'flashalpha poller starting'
  );

  let healthy = false;
  const tick = async () => {
    try {
      await pollOnce();
      if (!healthy) {
        state.setConnection('flashalpha', 'connected');
        healthy = true;
      }
    } catch (err) {
      if (healthy) {
        state.setConnection('flashalpha', 'disconnected');
        healthy = false;
      }
      logger.warn({ err }, 'flashalpha tick failed');
    }
  };

  void tick();
  setInterval(tick, config.flashAlpha.pollMs);
}
