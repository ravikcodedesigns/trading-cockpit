# Trading Cockpit

Local signal aggregation system for futures day trading. Receives data from Bookmap (orderflow), FlashAlpha MCP (GEX/dealer state), Tradovate (live price), and a daily levels JSON file (RocketScooter), runs confluence rules, and visualizes everything in a React cockpit. Pings Discord on signals and system events.

**v1 is observe-only.** The rules engine logs and alerts; it does not place trades.

## Layout

```
trading-cockpit/
├── apps/
│   ├── aggregator/        Node service: ingests sources, runs rules, pushes to cockpit
│   └── cockpit/           React + Lightweight Charts UI (port 5173)
├── addons/
│   └── bookmap/           Python script bridging Bookmap to the aggregator
├── packages/
│   └── contracts/         Shared TypeScript types (the event schema)
├── data/                  SQLite database lives here
├── daily_levels.json      Update each morning with RocketScooter levels
├── ecosystem.config.cjs   pm2 process config
└── .env.example           Copy to .env and fill in
```

## First-run setup

Prerequisites: Node 20+, pnpm 9+, Python 3.10+, pm2 (`npm i -g pm2`).

```bash
# 1. Clone / extract
cd trading-cockpit

# 2. Install JS deps
pnpm install

# 3. Install Python deps for the Bookmap bridge
pip3 install websockets

# 4. Configure
cp .env.example .env
# Edit .env — at minimum, paste in your DISCORD_WEBHOOK URL.

# 5. Run everything in dev mode (hot reload on aggregator + cockpit)
pnpm dev
```

You should see:
- `aggregator` listening on `127.0.0.1:8787`
- `cockpit` on `http://127.0.0.1:5173`
- Bookmap addon (heartbeat stub) connected, "bookmap" pill turning green in the cockpit
- A "✓ Aggregator started" message in your Discord channel

Open `http://127.0.0.1:5173` in your browser.

## Running the Bookmap addon separately

If `pnpm dev` doesn't pick up the Python script, run it manually in another terminal:

```bash
python3 addons/bookmap/addon.py
```

## Production mode (pm2)

```bash
pnpm build           # build aggregator + cockpit
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup          # follow the printed instructions to enable on boot
```

`pm2 logs` for combined logs, `pm2 monit` for live process stats.

## How to update levels

Edit `daily_levels.json`. The aggregator file-watches it and reloads automatically — the cockpit chart redraws within ~5 seconds. No restart needed.

## How to add a confluence rule

`apps/aggregator/src/rules/index.ts`. Each rule is a function that takes an event, optionally checks levels/FA state, and returns a `ConfluenceSignal` or null. Keep `observeOnly: true` until you've watched the rule fire in live markets for at least 2-3 weeks and verified it's not noise.

## Architecture

```
Bookmap ─┐
Tradov.  ├──► /ws/sources  ─►  aggregator  ─► SQLite
FlashA.  ┘                       │  │  ▲
                                 │  ▼  │
levels.json ──► file watcher ────┘  ▼  │
                                  rules ──► Discord
                                    │
                                    ▼
                               /ws/cockpit
                                    │
                                    ▼
                                 cockpit (React)
```

## What's NOT in v1

- Trade execution (intentionally separated).
- Backtesting framework.
- Real Bookmap absorption detection — Day 2 work.
- Real Tradovate price stream — Day 1 cockpit uses placeholder candles.
- Real FlashAlpha integration — depends on your specific MCP setup.

See the build plan in the conversation for the day-by-day path.

## Troubleshooting

**"bookmap" pill stays red.** The Python script can't reach the aggregator. Check `pm2 logs bookmap-addon` — usually means the aggregator isn't running yet, or port 8787 is in use.

**Discord not sending.** `DISCORD_WEBHOOK` not set in `.env`, or the webhook URL was rotated. Test with: `curl -X POST $DISCORD_WEBHOOK -H 'Content-Type: application/json' -d '{"content":"test"}'`.

**Cockpit shows "Disconnected".** Aggregator crashed or hot-reload triggered. Check the aggregator terminal. The cockpit auto-reconnects with exponential backoff.

**Database getting big.** SQLite WAL means it grows fast under heavy traffic. Run `data/trading.db` through `sqlite3 data/trading.db 'VACUUM;'` weekly. Long-term we'll add a rotation job.
