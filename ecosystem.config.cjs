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
      name: 'trader',
      cwd: './apps/trader',
      script: 'pnpm',
      args: 'run start',
      autorestart: true,
      max_restarts: 5,
      min_uptime: '30s',
      // Trader is NOT started by default — start manually after paper-trading setup.
      // pm2 start ecosystem.config.cjs --only trader
      stop_exit_codes: [0],
    },
    {
      name: 'dd-logger',
      cwd: './apps/aggregator',
      script: 'node',
      args: 'node_modules/tsx/dist/cli.mjs scripts/dd_logger.ts',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
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
