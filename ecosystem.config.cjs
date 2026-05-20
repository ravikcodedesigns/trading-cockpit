module.exports = {
  apps: [
    {
      name: 'aggregator',
      cwd: './apps/aggregator',
      script: 'pnpm',
      args: 'run start',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
        // Bind to all interfaces so the Cloudflare/Tailscale tunnel can reach it.
        // The cockpit SPA is served from the same port (no separate cockpit process).
        AGGREGATOR_HOST: '0.0.0.0',
      },
    },
    {
      name: 'bookmap-addon',
      script: 'python3',
      args: 'addons/bookmap/addon.py',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '5s',
    },
  ],
};
