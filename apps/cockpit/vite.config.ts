import { defineConfig } from 'vite';
import type { ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, Vite proxies all aggregator paths to 8787.
// In production the aggregator serves the built files directly (same origin),
// so all /ws, /context, /history, etc. resolve without a proxy.
const AGG    = 'http://127.0.0.1:8787';
const AGG_WS = 'ws://127.0.0.1:8787';

// http-proxy leaves the raw client/upstream sockets without error handlers, so a
// peer that vanishes mid-write (aggregator restart, feed reconnect, browser tab
// close) surfaces as an unhandled EPIPE/ECONNRESET and Vite dumps a full stack.
// These are expected disconnects — swallow them, log anything else once.
const BENIGN = new Set(['EPIPE', 'ECONNRESET', 'ECONNABORTED']);
const configure: ProxyOptions['configure'] = (proxy) => {
  const quiet = (s: { on: (e: string, cb: (err: Error) => void) => void }) =>
    s.on('error', (err: NodeJS.ErrnoException) => {
      if (!BENIGN.has(err.code ?? '')) console.warn('[proxy] socket error:', err.message);
    });
  proxy.on('error', (err: NodeJS.ErrnoException) => {
    if (!BENIGN.has(err.code ?? '')) console.warn('[proxy] error:', err.message);
  });
  // attach to both sides of a WS upgrade so neither can throw unhandled
  proxy.on('proxyReqWs', (_req, _res, socket) => quiet(socket));
  proxy.on('open', (proxySocket) => quiet(proxySocket));
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      // real-time price lane from the TICK-STORE (8788, not the aggregator): the addon delivers
      // every trade to 8788 instantly, so this is the lowest-latency price source available.
      // Rewritten to /ws/live because '/ws' below owns the aggregator's websocket namespace.
      '/tickstream': { target: 'ws://127.0.0.1:8788', ws: true, changeOrigin: true, configure, rewrite: (p) => p.replace(/^\/tickstream/, '/ws/live') },
      '/ws':         { target: AGG_WS, ws: true, changeOrigin: true, configure },
      '/context':    { target: AGG, changeOrigin: true, configure },
      '/history':    { target: AGG, changeOrigin: true, configure },
      '/post-entry': { target: AGG, changeOrigin: true, configure },
      '/test':       { target: AGG, changeOrigin: true, configure },
      '/health':     { target: AGG, changeOrigin: true, configure },
      '/ingest':     { target: AGG, changeOrigin: true, configure },
      '/levels':     { target: AGG, changeOrigin: true, configure },
      '/calendar':   { target: AGG, changeOrigin: true, configure },
      '/trader':     { target: AGG, changeOrigin: true, configure },
      // /signals/marks for chart-marker timestamps, /signals/<other> for
      // future fetches. Without this, requests fall through to Vite's SPA
      // fallback which returns the index HTML — fetch() resolves with a 200
      // text/html body, JSON.parse() throws, and the marks-fetcher swallows
      // the error silently so qualifiedTsRef stays empty.
      '/signals':    { target: AGG, changeOrigin: true, configure },
      // /tape/history — durable TAPE-event backfill for historical marker rendering.
      // Same SPA-fallback trap as /signals above: without this, fetch() gets index.html.
      '/tape':       { target: AGG, changeOrigin: true, configure },
      // research overlay label save/load (carmine-fade-extreme etc.).
      // NOTE: /exp-api only — static render dumps live under public/exp/ and
      // must be served by Vite, so we do NOT proxy the bare /exp prefix.
      '/exp-api':    { target: AGG, changeOrigin: true, configure },
    },
  },
});
