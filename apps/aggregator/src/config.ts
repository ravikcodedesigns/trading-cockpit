import 'dotenv/config';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd(), '../..');

// Which strategy engine(s) to run.
// 'A' = bar-based (sweep + divergence) only
// 'B' = tick-based (absorption + sub-second divergence) only
// 'C' = RS level watcher only
// 'BOTH' = run A and B in parallel
// 'ALL'  = run A, B, and C
export type ActiveStrategy = 'A' | 'B' | 'C' | 'D' | 'E' | 'H' | 'BOTH' | 'ALL';

export const config = {
  port: parseInt(process.env.AGGREGATOR_PORT ?? '8787', 10),
  // '127.0.0.1' = localhost only (dev). Set AGGREGATOR_HOST=0.0.0.0 for remote access.
  host: process.env.AGGREGATOR_HOST ?? '127.0.0.1',
  dbPath: process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(repoRoot, 'data', 'trading.db'),
  levelsPath: process.env.LEVELS_PATH
    ? path.resolve(process.env.LEVELS_PATH)
    : path.join(repoRoot, 'daily_levels.json'),
  discordWebhook: process.env.DISCORD_WEBHOOK ?? '',
  flashAlpha: {
    url: process.env.FLASHALPHA_URL ?? '',
    pollMs: parseInt(process.env.FLASHALPHA_POLL_MS ?? '60000', 10),
  },
  logLevel: process.env.LOG_LEVEL ?? 'info',
  isProd: process.env.NODE_ENV === 'production',

  // Strategy engine control
  activeStrategy: (process.env.ACTIVE_STRATEGY ?? 'BOTH') as ActiveStrategy,

  // Tick-store connection (Strategy B reads ticks from here)
  tickStore: {
    baseUrl: process.env.TICK_STORE_URL ?? 'http://127.0.0.1:8788',
    pollMs: parseInt(process.env.TICK_STORE_POLL_MS ?? '500', 10),
  },

  // ── V3 — Combined-cooldown trade manager (post-research deploy)
  //
  // V3 layers ON TOP of the existing gold-tier quality gate. It does NOT
  // replace any current logic. When disabled or in 'off' mode, the live
  // system behaves exactly as it does today.
  //
  // activeMode:
  //   'off'    → V3 logic short-circuited. Zero behavior change. (DEFAULT)
  //   'shadow' → V3 records decisions to v3_decisions table but does NOT
  //              gate broadcasts. Chart and Discord unchanged. Used to verify
  //              live decisions match the offline backtest for ≥5 RTH days.
  //   'live'   → V3 gates broadcasts and emits trade-close events. Chart
  //              shows only V3-tradable signals + close markers.
  //
  // To silence V3 entirely in the future: set activeMode='off' and restart.
  // The new tables (open_trades, v3_decisions) remain but go unused.
  v3: {
    activeMode: (process.env.V3_ACTIVE_MODE ?? 'off') as 'off' | 'shadow' | 'live',

    // Symbols V3 manages. ES bypasses V3 entirely until calibrated.
    symbols: ['NQ'] as const,

    // 15:54 ET = 8 min before broker margin close at 15:55. Trades open at
    // this clock-tick are force-closed via TradeManager.onRthClose().
    rthCloseEt: '15:54:00',

    // CVD regime gates at signal entry (anchored at 09:30 ET).
    cvdLongFloor: -3000,   // LONG entries blocked when cvdSession ≤ this
    cvdShortFloor: 3000,   // SHORT entries blocked when cvdSession ≥ this

    // Direction-specific behavior baked in from backtest findings:
    dropFlipShorts: true,                  // qualified FLIP shorts → not traded
    requireQualifiedExitsLongs: true,      // only qualified opp signals close LONG trades
    requireQualifiedExitsShorts: false,    // any opposite signal closes SHORT trades

    // Per-rule TP/SL points. Number → both directions; { long, short } → asymmetric.
    perRule: {
      'absorption':          { tp: 80, sl: 140 },
      'clean-impulse-FLIP':  { tp: 80, sl: { long: 55, short: 105 } },
      'expl':                { tp: 80, sl: 70 },
    } as const,
  },
};
