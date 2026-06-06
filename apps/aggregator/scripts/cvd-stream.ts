// Live CVD streamer — tails the active MBO capture .log files in real time,
// computes per-symbol RTH-anchored CVD using MBO-quality aggressor flags,
// and exposes the running value over HTTP.
//
// Why this exists:
//   ticks.db's `is_bid_aggressor` is inferred by the Bookmap tick-store relay
//   and disagrees with the raw MBO feed by 3-4x (under-counts net selling).
//   This script consumes the MBO .log files Bookmap writes continuously and
//   produces an accurate live CVD that V3 can read instead of ticks.db.
//
// Conventions (matched to src/cvd-session.ts):
//   - RTH window: [09:30 ET, 16:00 ET), EDT-fixed (May-Oct).
//   - is_bid_aggressor=1 is BUY (per ticks_nq_is_mnq + Python-addon empirical).
//   - +size for buys, -size for sells.
//   - New ET day → counter resets when first in-RTH tick arrives.
//
// Usage:
//   pnpm --filter @trading/aggregator exec tsx scripts/cvd-stream.ts
//
//   Env:
//     CVD_STREAM_PORT  HTTP port (default 4711)
//     CVD_STREAM_DIR   capture dir (default ~/cockpit-mbo-capture)
//     CVD_POLL_MS      tail poll interval (default 500ms)
//
// Endpoints:
//   GET /cvd                 → { "MNQ": -27543, "MES": -8211, asOfMs: ... }
//   GET /cvd?symbol=MNQ      → { symbol, cvd, etDate, trades, lastTradeMs, ... }
//   GET /healthz             → { ok, files:[{symbol,file,bytes,trades,cvd,lastTradeMs}] }

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const HOME = process.env.HOME ?? '';
const CAPTURE_DIR = process.env.CVD_STREAM_DIR ?? path.join(HOME, 'cockpit-mbo-capture');
const PORT = Number(process.env.CVD_STREAM_PORT ?? 4711);
const POLL_MS = Number(process.env.CVD_POLL_MS ?? 500);

// ─── RTH window logic — matches src/cvd-session.ts ───────────────────
const ET_OFFSET_MS = 4 * 60 * 60_000;            // EDT
const RTH_OPEN_ET  = { h: 9,  m: 30 };
const RTH_CLOSE_ET = { h: 16, m: 0  };

function etDateOf(tsMs: number): string {
  const d = new Date(tsMs - ET_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function rthBoundsForEtDate(etDate: string): { openMs: number; closeMs: number } {
  const [y, m, d] = etDate.split('-').map(Number) as [number, number, number];
  const openMs  = Date.UTC(y, m - 1, d, RTH_OPEN_ET.h  + 4, RTH_OPEN_ET.m, 0, 0);
  const closeMs = Date.UTC(y, m - 1, d, RTH_CLOSE_ET.h + 4, RTH_CLOSE_ET.m, 0, 0);
  return { openMs, closeMs };
}
function isInsideRth(tsMs: number): boolean {
  const { openMs, closeMs } = rthBoundsForEtDate(etDateOf(tsMs));
  return tsMs >= openMs && tsMs < closeMs;
}

// ─── Filename parser (same logic as mbo_ingest.ts) ───────────────────
function parseFilename(p: string): { date: string; symbol: string } | null {
  const base = path.basename(p, '.log');
  const m = base.match(/^(\d{4}-\d{2}-\d{2})-([A-Z]+)/);
  if (!m) return null;
  return { date: m[1]!, symbol: m[2]! };
}

// ─── Per-symbol state ────────────────────────────────────────────────
interface SymbolState {
  symbol: string;
  filePath: string;
  offsetBytes: number;
  carry: string;             // partial trailing line carried across reads
  etDate: string;
  cvd: number;
  trades: number;
  lastTradeMs: number;
  buyVol: number;
  sellVol: number;
}

const stateBySymbol = new Map<string, SymbolState>();

function resetForNewDay(s: SymbolState, etDate: string): void {
  s.etDate   = etDate;
  s.cvd      = 0;
  s.trades   = 0;
  s.buyVol   = 0;
  s.sellVol  = 0;
}

// Fast-path filter avoids JSON.parse on non-trade lines (~85% of lines).
function applyTradeLine(s: SymbolState, line: string): void {
  if (!line || line.length < 20 || line[0] !== '{') return;
  if (line.indexOf('"trade"') < 0) return;
  let rec: any;
  try { rec = JSON.parse(line); } catch { return; }
  if (rec.kind !== 'trade') return;
  const ts = rec.ts_ms as number;
  if (!Number.isFinite(ts)) return;
  const etDate = etDateOf(ts);
  if (etDate !== s.etDate) resetForNewDay(s, etDate);
  if (!isInsideRth(ts)) return;
  const data = rec.data ?? {};
  const size = Number(data.size);
  if (!Number.isFinite(size) || size <= 0) return;
  const isBuy = !!data.is_bid_aggressor;
  if (isBuy) { s.cvd += size; s.buyVol  += size; }
  else       { s.cvd -= size; s.sellVol += size; }
  s.trades++;
  s.lastTradeMs = ts;
}

// ─── Find today's active capture file per symbol ────────────────────
function findTodayFiles(): Array<{ symbol: string; filePath: string }> {
  if (!fs.existsSync(CAPTURE_DIR)) {
    console.error(`[fatal] capture dir does not exist: ${CAPTURE_DIR}`);
    process.exit(1);
  }
  const today = etDateOf(Date.now());
  const out: Array<{ symbol: string; filePath: string }> = [];
  for (const f of fs.readdirSync(CAPTURE_DIR)) {
    if (!f.endsWith('_BMD.log')) continue;
    if (!f.startsWith(today))    continue;
    const parsed = parseFilename(f);
    if (parsed) out.push({ symbol: parsed.symbol, filePath: path.join(CAPTURE_DIR, f) });
  }
  return out;
}

// ─── Initial backfill: read entire file, apply RTH filter ───────────
async function backfillFromOpen(s: SymbolState): Promise<void> {
  const t0 = Date.now();
  console.log(`[backfill] ${s.symbol}: scanning ${path.basename(s.filePath)} from byte 0`);
  const stream = fs.createReadStream(s.filePath, { start: 0 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let bytes = 0;
  for await (const line of rl) {
    bytes += Buffer.byteLength(line, 'utf8') + 1;
    applyTradeLine(s, line);
  }
  s.offsetBytes = bytes;
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[backfill] ${s.symbol}: cvd=${s.cvd} trades=${s.trades} buy=${s.buyVol} sell=${s.sellVol} bytes=${bytes.toLocaleString()} in ${dt}s`);
}

// ─── Live tail: poll file size, read deltas, handle rollover ────────
function readDelta(s: SymbolState, endByte: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(s.filePath, { start: s.offsetBytes, end: endByte - 1 });
    const chunks: Buffer[] = [];
    stream.on('data', c => chunks.push(c as Buffer));
    stream.on('end', () => {
      const text = s.carry + Buffer.concat(chunks).toString('utf8');
      const lastNL = text.lastIndexOf('\n');
      if (lastNL >= 0) {
        for (const line of text.slice(0, lastNL).split('\n')) applyTradeLine(s, line);
        s.carry = text.slice(lastNL + 1);
      } else {
        s.carry = text;
      }
      s.offsetBytes = endByte;
      resolve();
    });
    stream.on('error', reject);
  });
}

async function tailLoop(s: SymbolState): Promise<void> {
  while (true) {
    try {
      const st = fs.statSync(s.filePath);
      if (st.size > s.offsetBytes) {
        await readDelta(s, st.size);
      } else if (st.size < s.offsetBytes) {
        console.warn(`[tail] ${s.symbol}: file shrank (${s.offsetBytes}→${st.size}); restarting from 0`);
        s.offsetBytes = 0;
        s.carry = '';
      }
    } catch (err) {
      console.warn(`[tail] ${s.symbol}: stat error: ${(err as Error).message}`);
    }
    await new Promise(r => setTimeout(r, POLL_MS));

    // Day rollover: if today's file changed path, swap to the new file.
    const today = etDateOf(Date.now());
    if (!s.filePath.includes(today)) {
      const todays = findTodayFiles();
      const swap = todays.find(f => f.symbol === s.symbol);
      if (swap && swap.filePath !== s.filePath) {
        console.log(`[rollover] ${s.symbol}: switching to ${path.basename(swap.filePath)}`);
        s.filePath    = swap.filePath;
        s.offsetBytes = 0;
        s.carry       = '';
        resetForNewDay(s, today);
      }
    }
  }
}

// ─── HTTP server ────────────────────────────────────────────────────
function startHttp(): void {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    res.setHeader('content-type', 'application/json');
    const asOfMs = Date.now();

    if (url.pathname === '/healthz') {
      res.end(JSON.stringify({
        ok: true,
        asOfMs,
        files: [...stateBySymbol.values()].map(s => ({
          symbol:      s.symbol,
          file:        path.basename(s.filePath),
          bytes:       s.offsetBytes,
          trades:      s.trades,
          cvd:         s.cvd,
          buyVol:      s.buyVol,
          sellVol:     s.sellVol,
          etDate:      s.etDate,
          lastTradeMs: s.lastTradeMs,
          stale_s:     s.lastTradeMs ? Math.round((asOfMs - s.lastTradeMs) / 1000) : null,
        })),
      }));
      return;
    }

    if (url.pathname === '/cvd') {
      const sym = url.searchParams.get('symbol');
      if (sym) {
        const s = stateBySymbol.get(sym.toUpperCase());
        if (!s) {
          res.statusCode = 404;
          res.end(JSON.stringify({ symbol: sym, error: 'unknown_symbol' }));
          return;
        }
        res.end(JSON.stringify({
          symbol:      s.symbol,
          cvd:         s.cvd,
          buyVol:      s.buyVol,
          sellVol:     s.sellVol,
          etDate:      s.etDate,
          trades:      s.trades,
          lastTradeMs: s.lastTradeMs,
          offsetBytes: s.offsetBytes,
          asOfMs,
        }));
        return;
      }
      const out: Record<string, number | string> = { asOfMs };
      for (const [k, s] of stateBySymbol) out[k] = s.cvd;
      res.end(JSON.stringify(out));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[ready] cvd-stream listening on http://127.0.0.1:${PORT}`);
    console.log(`[ready] symbols: ${[...stateBySymbol.keys()].join(', ')}`);
  });
}

// ─── Bootstrap ──────────────────────────────────────────────────────
async function main() {
  const todayFiles = findTodayFiles();
  if (todayFiles.length === 0) {
    console.error(`[fatal] no capture files for today (${etDateOf(Date.now())}) in ${CAPTURE_DIR}`);
    console.error(`        Expected files like 2026-06-05-MNQM6_CME_BMD.log`);
    process.exit(1);
  }

  const today = etDateOf(Date.now());
  for (const f of todayFiles) {
    const s: SymbolState = {
      symbol:      f.symbol,
      filePath:    f.filePath,
      offsetBytes: 0,
      carry:       '',
      etDate:      today,
      cvd:         0,
      trades:      0,
      lastTradeMs: 0,
      buyVol:      0,
      sellVol:     0,
    };
    stateBySymbol.set(f.symbol, s);
    await backfillFromOpen(s);
    void tailLoop(s);
  }

  startHttp();
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
