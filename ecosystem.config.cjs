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
      },
    },
    {
      name: 'cockpit',
      cwd: './apps/cockpit',
      script: 'pnpm',
      args: 'run preview',
      autorestart: true,
      max_restarts: 10,
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
