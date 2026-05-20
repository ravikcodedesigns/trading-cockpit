import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, Vite proxies all aggregator paths to 8787.
// In production the aggregator serves the built files directly (same origin),
// so all /ws, /context, /history, etc. resolve without a proxy.
const AGG    = 'http://127.0.0.1:8787';
const AGG_WS = 'ws://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/ws':         { target: AGG_WS, ws: true, changeOrigin: true },
      '/context':    { target: AGG, changeOrigin: true },
      '/history':    { target: AGG, changeOrigin: true },
      '/post-entry': { target: AGG, changeOrigin: true },
      '/test':       { target: AGG, changeOrigin: true },
      '/health':     { target: AGG, changeOrigin: true },
      '/ingest':     { target: AGG, changeOrigin: true },
      '/levels':     { target: AGG, changeOrigin: true },
      '/calendar':   { target: AGG, changeOrigin: true },
    },
  },
});
