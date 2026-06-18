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
// SPY/QQQ ETF prices for the greater-market "index > MHP" leg (Ravi: there's no live
// index value on the RS chart, so pull SPY/QQQ from Yahoo and compare to the platform MHP).
const SPY_URL   = 'https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=1d';
const QQQ_URL   = 'https://query1.finance.yahoo.com/v8/finance/chart/QQQ?interval=1d&range=1d';
// UVXY = live vol-complex price (the platform's VX gamma HP/MHP are UVXY-scale, and
// DYN_HP's own VX close is only the prior close — need a live quote for the cross).
const UVXY_URL  = 'https://query1.finance.yahoo.com/v8/finance/chart/UVXY?interval=1d&range=1d';

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

// Returns the live price and the prior close (prior close is needed for the
// QQQ-vs-SPY intraday relative-strength read).
async function fetchQuote(url: string): Promise<{ price?: number; prev?: number }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return {};
  const data = await res.json() as {
    chart?: { result?: { meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number } }[] };
  };
  const meta = data.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  const prev  = meta?.chartPreviousClose ?? meta?.previousClose;
  return {
    price: typeof price === 'number' ? price : undefined,
    prev:  typeof prev  === 'number' ? prev  : undefined,
  };
}

async function pollOnce(): Promise<void> {
  if (!isRTH()) return;

  const [vix, vvix, spyQ, qqqQ, uvxyQ] = await Promise.all([
    fetchQuote(VIX_URL), fetchQuote(VVIX_URL), fetchQuote(SPY_URL), fetchQuote(QQQ_URL), fetchQuote(UVXY_URL),
  ]);

  // Save each field independently — a single missing quote (e.g. ^VVIX hiccup)
  // must not block the others or leave the whole set stale.
  const updates: { vx?: number; vvix?: number; spy?: number; qqq?: number; spyPrev?: number; qqqPrev?: number; uvxy?: number } = {};
  if (typeof vix.price   === 'number') updates.vx      = vix.price;
  if (typeof vvix.price  === 'number') updates.vvix    = vvix.price;
  if (typeof spyQ.price  === 'number') updates.spy     = spyQ.price;
  if (typeof spyQ.prev   === 'number') updates.spyPrev = spyQ.prev;
  if (typeof qqqQ.price  === 'number') updates.qqq     = qqqQ.price;
  if (typeof qqqQ.prev   === 'number') updates.qqqPrev = qqqQ.prev;
  if (typeof uvxyQ.price === 'number') updates.uvxy    = uvxyQ.price;

  if (Object.keys(updates).length === 0) {
    logger.warn('vx-poller: no prices in Yahoo response');
    return;
  }

  const ctx = saveContext(updates);
  logger.info({ vx: updates.vx, vvix: updates.vvix, spy: updates.spy, qqq: updates.qqq, qqqSpyRs: ctx.qqqSpyRs }, 'vx-poller: context updated');
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
