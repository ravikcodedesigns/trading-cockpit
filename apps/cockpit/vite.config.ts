import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      // Proxy /ws/cockpit to the aggregator so the React app uses a same-origin WS.
      '/ws': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
