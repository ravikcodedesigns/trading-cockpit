// Phase A smoke: tail the live full-size NQ + ES Bookmap .log, reconstruct the
// L3 order book in memory, and print a ladder snapshot every few seconds.
//
//   pnpm --filter @trading/aggregator exec tsx scripts/l3-book-smoke.ts
//   SMOKE_SECONDS=20 ...   # bounded run (else runs until Ctrl-C)
//   FROM_START=1 ...       # replay the whole log from byte 0 instead of live EOF
//
// What to look for: best bid/ask move in real time, ladder sizes look sane, and
// crossCheck() converges (diverged levels shrink as the book churns) — that's the
// MBO reconstruction agreeing with Bookmap's own depth stream. NO orders. Read-only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrderBook, priceFromInt } from '../src/l3/order-book.js';
import { tailLog, type LogEvent } from '../src/l3/log-tailer.js';

const CAPTURE_DIR = path.join(os.homedir(), 'cockpit-mbo-capture');
const SNAPSHOT_MS = 3000;
const SMOKE_SECONDS = process.env.SMOKE_SECONDS ? Number(process.env.SMOKE_SECONDS) : 0;
const FROM_START = process.env.FROM_START === '1';

function liveLog(suffix: string): string | null {
  const files = fs.readdirSync(CAPTURE_DIR)
    .filter((f) => f.includes(`-${suffix}_`) && f.endsWith('.log'))
    .sort();
  return files.length ? path.join(CAPTURE_DIR, files[files.length - 1]) : null;
}

function dispatch(book: OrderBook, e: LogEvent): void {
  book.lastTs = e.ts_ms;
  const d = e.data;
  switch (e.kind) {
    case 'depth': book.applyDepth(d as any); break;
    case 'trade': book.applyTrade(d as any); break;
    case 'mbo_send': book.applySend(d as any); break;
    case 'mbo_replace': book.applyReplace(d as any); break;
    case 'mbo_cancel': book.applyCancel(d as any); break;
  }
}

function snapshot(book: OrderBook): void {
  const bb = book.bestBid(), ba = book.bestAsk();
  const { bids, asks } = book.ladder(5);
  const cc = book.crossCheck();
  const matchPct = cc.levels ? ((100 * cc.matched) / cc.levels).toFixed(0) : '—';
  const top = (lv: { price: number; size: number; orders: number }) =>
    `${lv.price.toFixed(2)} x${lv.size}(${lv.orders})`;
  console.log(
    `\n[${book.symbol}] ${new Date(book.lastTs).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET` +
    `  bid ${bb != null ? priceFromInt(bb).toFixed(2) : '—'} / ask ${ba != null ? priceFromInt(ba).toFixed(2) : '—'}` +
    `  spread ${bb != null && ba != null ? (priceFromInt(ba) - priceFromInt(bb)).toFixed(2) : '—'}` +
    `  CVD ${book.cvd}`,
  );
  console.log(`   asks: ${asks.map(top).reverse().join('  ')}`);
  console.log(`   bids: ${bids.map(top).join('  ')}`);
  console.log(
    `   events: depth=${book.depthEvents} mbo=${book.mboEvents} trade=${book.tradeEvents}` +
    `  | crossCheck: ${cc.matched}/${cc.levels} levels match (${matchPct}%), Σ|Δsize|=${cc.sizeDeltaAbs}`,
  );
}

function main(): void {
  const targets: { sym: string; suffix: string }[] = [
    { sym: 'NQ', suffix: 'NQU6' },
    { sym: 'ES', suffix: 'ESU6' },
  ];
  const books: OrderBook[] = [];
  const stops: Array<() => void> = [];

  for (const { sym, suffix } of targets) {
    const log = liveLog(suffix);
    if (!log) { console.error(`no live log for ${sym} (${suffix})`); continue; }
    const book = new OrderBook(sym);
    books.push(book);
    console.log(`tailing ${sym}: ${path.basename(log)}${FROM_START ? ' (from start)' : ' (live tail)'}`);
    const h = tailLog(log, (e) => dispatch(book, e), { fromStart: FROM_START });
    stops.push(h.stop);
  }
  if (!books.length) { console.error('nothing to tail'); process.exit(1); }

  const snap = setInterval(() => books.forEach(snapshot), SNAPSHOT_MS);

  const shutdown = (): void => {
    clearInterval(snap);
    stops.forEach((s) => s());
    console.log('\n— final —');
    books.forEach(snapshot);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  if (SMOKE_SECONDS > 0) setTimeout(shutdown, SMOKE_SECONDS * 1000);
}

main();
