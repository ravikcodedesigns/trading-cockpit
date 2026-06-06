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
  // Extra per-instrument levels files merged on top of the primary file.
  // 2026-06-03: ES Step 1 expansion — separate file lets us iterate on ES
  // without polluting the NQ-centric daily_levels.json.
  levelsExtraPaths: [
    path.join(repoRoot, 'daily_levels_es.json'),
  ] as string[],
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
    // dropFlipShorts: 2026-06-04 flipped TRUE → FALSE after 30-day analysis showed
    // qualified FLIP-SHORTs at 77.8% WR / +38.9 EV / +700 pts (n=18) — strongest single
    // signal in the system. Previous TRUE setting was leaving ~$3,500/short on the table.
    dropFlipShorts: false,                 // qualified FLIP shorts now ELIGIBLE for V3 OPEN
    requireQualifiedExitsLongs: true,      // only qualified opp signals close LONG trades
    // closeShortsOnlyOnFlipLong: 2026-06-04 — when ON, an open SHORT can ONLY be closed
    // by a qualified FLIP-LONG signal (clean-impulse rule_id, FLIP pattern). Prevents
    // weak opposing signals (tape-speed, large-print, absorption) from exiting profitable
    // shorts early. Overrides requireQualifiedExitsShorts when ON.
    closeShortsOnlyOnFlipLong: true,
    requireQualifiedExitsShorts: false,    // (legacy — superseded by closeShortsOnlyOnFlipLong)

    // forceShadowRules: rules in this list are evaluated by V3 (decisions logged
    // to v3_decisions) but NEVER open a trade — even when V3 is in 'live' mode.
    // Used for rules that need OOS sample accumulation before going live.
    //   - cont-reentry (2026-06-03): n=24 / 67% WR / +30.5 EV. Needs ~50+ OOS sigs.
    //   - es-flip (2026-06-03): n=41 test / 60.7% LONG / 50% SHORT WR. Needs OOS.
    //   - expl (2026-06-04): SILENCED + force-shadow. LONG 30% WR / -19 EV / -1,130 pts;
    //     SHORT 4% WR / -62 EV / -3,018 pts. Both losing; detector kept for research.
    forceShadowRules: ['cont-reentry', 'es-flip', 'expl'] as string[],

    // Per-rule TP/SL points. Number → both directions; { long, short } → asymmetric.
    perRule: {
      'absorption':              { tp: 80, sl: 140 },
      'clean-impulse-FLIP':      { tp: 80, sl: { long: 55, short: 105 } },
      'expl':                    { tp: 80, sl: 70 },
      'wall-broken-fade':        { tp: 20, sl: 10 },
      // 2026-06-03: compression+real-wall+capitulation. SHADOW only — single-day
      // MBO produced zero qualifying setups (no confluence formed on bull-trend day).
      // R:R 1:4 strict. Re-validate when 2+ weeks of MBO accumulated.
      'compression-realwall':    { tp: 24, sl: 6 },
      // 2026-06-03: flip-long-pmcore. FLIP-long filtered to 10:30-13:30 ET window +
      // deltaLast3 ≤ -300 (strong prior bearish). Backtested on 41 historical signals
      // (60-day window) achieving 69.6% WR (16W/7L/8 BE-scratch) at TP=60/SL=40 R:R 1.5.
      // Per-trade slipped ~+21 pts. SHADOW pending live validation.
      'flip-long-pmcore':        { tp: 60, sl: 40 },
      // 2026-06-03: cont-reentry (Strategy CONT). SHADOW pending more signal accumulation.
      // Empirical analysis on n=24 (May 20 – Jun 3) at TP=80/SL=70 → 66.7% WR, +30.5 EV/sig,
      // +733 pts total. Wide stops required — median time-to-peak 73 min, median DD on
      // losers 72pt. Rule's shipped stopDist=25pt would kill 7/17 winners.
      'cont-reentry':            { tp: 80, sl: 70 },
      // 2026-06-03: es-flip (ES-tuned FLIP detector). SHADOW pending OOS validation.
      // Derived via labelled-swing analysis on 8 train days, validated on 8 test days.
      // LONG K=4 / SHORT K=5 with swing-confirmation gate (±5 bars).
      // Test results: LONG 60.7% WR / +2.9 EV / 7.2 sig/day; SHORT 50% WR / +2.7 EV / 1.5 sig/day.
      // Symmetric TP=20/SL=20 for simplicity.
      'es-flip':                 { tp: 20, sl: 20 },
    } as const,
  },
};
