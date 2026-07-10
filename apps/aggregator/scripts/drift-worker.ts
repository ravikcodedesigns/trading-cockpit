// Drift worker — the DEDICATED process that polls the Quant Data net-drift API for SPX +
// NDX every 60s, cumulates the ABJ-filtered (0DTE/OTM/aggressor) drift curve, computes the
// 10-min slope (signal) + a price-momentum(10m) slope (placebo), and streams a DriftSnapshot
// per future (NDX→NQ, SPX→ES) to the aggregator for the cockpit DRIFT HUD. SHADOW ONLY.
//
// Flow: connect to /ws/drift-ingest. The aggregator tells us whether any browser is watching
// (`{type:'active'}`). We poll ONLY while active — idle otherwise (saves API quota) — and
// forward `{type:'snap', symbol, snap}`. Reconnects on drop and re-syncs the active flag.
//
// LIVE data uses getNetDriftLive (uncached): the cached path keys on sessionDate so it would
// return a frozen snapshot on every intraday poll. The nightly capture owns persistence.

import WebSocket from 'ws';
import { getNetDriftLive, abjNetDriftFilter } from '../src/sources/quantdata-store.js';
import type { Symbol as Sym, DriftSnapshot } from '@trading/contracts';

const INGEST_URL = process.env.DRIFT_INGEST_URL ?? 'ws://127.0.0.1:8787/ws/drift-ingest';
const RECONNECT_MS = 2000;
const POLL_MS = 60_000;
const SLOPE_WIN = 10;         // minutes in the rolling slope window
const STALE_MS = 5 * 60_000;  // last print older than this ⇒ stale

const INDEXES: { index: 'SPX' | 'NDX'; sym: Sym }[] = [
  { index: 'SPX', sym: 'ES' },
  { index: 'NDX', sym: 'NQ' },
];

let ws: WebSocket | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;

function todayNY(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}
function nowMs(): number { return Date.now(); }

/** Least-squares slope (per bucket) of a short series. */
function slope(ys: number[]): number {
  const n = ys.length; if (n < 2) return 0;
  const mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (ys[i]! - my); den += (i - mx) ** 2; }
  return den ? num / den : 0;
}

function forward(sym: Sym, snap: DriftSnapshot): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'snap', symbol: sym, snap })); } catch { /* dropped */ }
  }
}

async function pollOne(index: 'SPX' | 'NDX', sym: Sym): Promise<void> {
  const day = todayNY();
  const rows = (await getNetDriftLive(index, day, 'ONE_MINUTE', abjNetDriftFilter(day)))
    .filter((r) => Number.isFinite(r.stock) && r.stock > 0);
  if (rows.length < 1) return;
  let cc = 0, cp = 0, cn = 0;
  const cum = rows.map((r) => { cc += r.netCall; cp += r.netPut; cn += (r.netCall - r.netPut); return { ...r, cc, cp, cn }; });
  const last = cum[cum.length - 1]!;
  const win = cum.slice(-SLOPE_WIN);
  const snap: DriftSnapshot = {
    type: 'drift', symbol: sym, index, ts: Math.floor(last.epoch_ms / 1000), session: day,
    price: last.stock, netCum: last.cn, netCallCum: last.cc, netPutCum: last.cp,
    slope10: win.length >= SLOPE_WIN ? slope(win.map((x) => x.cn)) : 0,
    priceSlope10: win.length >= SLOPE_WIN ? slope(win.map((x) => x.stock)) : 0,
    bias: last.cn >= 0 ? 'bull' : 'bear',
    stale: nowMs() - last.epoch_ms > STALE_MS,
  };
  forward(sym, snap);
}

async function pollAll(): Promise<void> {
  for (const { index, sym } of INDEXES) {
    try { await pollOne(index, sym); }
    catch (e: any) { console.log(`[drift-worker] ${index} poll err: ${String(e.message).slice(0, 100)}`); }
  }
}

function setActive(active: boolean): void {
  if (active && !polling) {
    console.log('[drift-worker] active → start polling SPX/NDX net-drift');
    polling = true;
    void pollAll();                              // immediate first paint
    timer = setInterval(() => void pollAll(), POLL_MS);
  } else if (!active && polling) {
    console.log('[drift-worker] idle → stop polling');
    polling = false;
    if (timer) { clearInterval(timer); timer = null; }
  }
}

function connect(): void {
  console.log(`[drift-worker] connecting → ${INGEST_URL}`);
  const sock = new WebSocket(INGEST_URL);
  ws = sock;
  sock.on('open', () => console.log('[drift-worker] connected to aggregator'));
  sock.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type?: string; active?: boolean };
      if (msg.type === 'active') setActive(!!msg.active);
    } catch { /* ignore */ }
  });
  sock.on('close', () => {
    if (ws === sock) ws = null;
    setActive(false);
    setTimeout(connect, RECONNECT_MS);
  });
  sock.on('error', () => { try { sock.close(); } catch { /* noop */ } });
}

process.on('SIGTERM', () => { setActive(false); process.exit(0); });
process.on('SIGINT', () => { setActive(false); process.exit(0); });

connect();
