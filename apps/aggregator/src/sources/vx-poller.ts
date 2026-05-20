// VX / VVIX fallback poller — Yahoo Finance, every 5 minutes, RTH only.
// Runs inside the aggregator process so it works even when Claude Code
// is closed. The Claude Code MCP cron bridge takes precedence when running
// (it pushes via POST /context/vx); this poller fills the gap otherwise.
//
// Uses ^VIX as a proxy for /VX futures — they track each other closely
// and Yahoo Finance doesn't serve futures data without auth.

import { saveContext } from '../rs-context.js';
import { logger } from '../logger.js';

const POLL_MS   = 5 * 60_000; // 5 minutes
const VIX_URL   = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d';
const VVIX_URL  = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVVIX?interval=1d&range=1d';

function isRTH(): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const wd = parts.find(p => p.type === 'weekday')?.value ?? '';
  const h  = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0');
  const m  = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0');
  const minOfDay = h * 60 + m;
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(wd)
    && minOfDay >= 570   // 09:30 ET
    && minOfDay <  960;  // 16:00 ET
}

async function fetchPrice(url: string): Promise<number | undefined> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return undefined;
  const data = await res.json() as {
    chart?: { result?: { meta?: { regularMarketPrice?: number } }[] };
  };
  const price = data.chart?.result?.[0]?.meta?.regularMarketPrice;
  return typeof price === 'number' ? price : undefined;
}

async function pollOnce(): Promise<void> {
  if (!isRTH()) return;

  const [vx, vvix] = await Promise.all([fetchPrice(VIX_URL), fetchPrice(VVIX_URL)]);

  if (typeof vx !== 'number' || typeof vvix !== 'number') {
    logger.warn({ vx, vvix }, 'vx-poller: missing prices in Yahoo response');
    return;
  }

  const ctx = saveContext({ vx, vvix });
  logger.info({ vx, vvix, vxAboveBBB: ctx.vxAboveBBB, vvixGolden: ctx.vvixGolden }, 'vx-poller: context updated');
}

export function startVXPoller(): void {
  logger.info({ pollMs: POLL_MS }, 'vx-poller started (Yahoo Finance ^VIX/^VVIX, RTH only)');

  // Delay first poll 15s so aggregator finishes booting before we write context.
  setTimeout(() => {
    void pollOnce().catch(err => logger.warn({ err }, 'vx-poller: initial poll failed'));
    setInterval(
      () => void pollOnce().catch(err => logger.warn({ err }, 'vx-poller: poll failed')),
      POLL_MS,
    );
  }, 15_000);
}
