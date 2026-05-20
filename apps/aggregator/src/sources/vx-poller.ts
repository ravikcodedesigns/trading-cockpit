// VX / VVIX fallback poller — Yahoo Finance, every 5 minutes, RTH only.
// Runs inside the aggregator process so it works even when Claude Code
// is closed. The Claude Code MCP cron bridge takes precedence when running
// (it pushes via POST /context/vx); this poller fills the gap otherwise.
//
// Uses ^VIX as a proxy for /VX futures — they track each other closely
// and Yahoo Finance doesn't serve futures data without auth.

import { saveContext } from '../rs-context.js';
import { logger } from '../logger.js';

const POLL_MS  = 5 * 60_000; // 5 minutes
const YAHOO_URL = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=%5EVIX,%5EVVIX';

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

async function pollOnce(): Promise<void> {
  if (!isRTH()) return;

  const res = await fetch(YAHOO_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    logger.warn({ status: res.status }, 'vx-poller: Yahoo Finance non-2xx');
    return;
  }

  const data = await res.json() as {
    quoteResponse?: { result?: { symbol: string; regularMarketPrice?: number }[] };
  };

  const rows  = data.quoteResponse?.result ?? [];
  const vx    = rows.find(r => r.symbol === '^VIX')?.regularMarketPrice;
  const vvix  = rows.find(r => r.symbol === '^VVIX')?.regularMarketPrice;

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
