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

  // ── Pipeline — signal evaluation + trade management ──────────────────────
  //
  // The pipeline replaces the old V3 cascade (deleted 2026-06-09). It writes
  // every evaluated signal to tradable_signals, drives broadcasts to the
  // cockpit + Discord, and manages tradeManager state (open/close on each
  // signal per the policies below).
  //
  // activeMode:
  //   'shadow' → pipeline writes tradable_signals as an observer but does NOT
  //              broadcast or call tradeManager. Use for safe experimentation
  //              when actively iterating on rule logic.
  //   'live'   → pipeline drives broadcasts + tradeManager (default). The
  //              trader subscribes to bus 'signal' events to place broker
  //              orders. Halt-file (/tmp/trader.halt) is still the kill switch.
  //
  // Scope (symbols): only signals on symbols in `symbols` go through the
  // pipeline. Non-pipeline symbols fall through to the legacy gold-tier
  // broadcast (just publishes to cockpit; trader ignores them).
  pipeline: {
    activeMode: (process.env.PIPELINE_ACTIVE_MODE ?? 'live') as 'shadow' | 'live',

    // Symbols the pipeline manages. ES is not yet promoted (still calibrating).
    symbols: ['NQ'] as const,

    // 15:54 ET = 8 min before broker margin close at 15:55. Trades open at
    // this clock-tick are force-closed via TradeManager.onRthClose().
    rthCloseEt: '15:54:00',

    // CVD regime gates at signal entry (anchored at 09:30 ET).
    cvdLongFloor: -3000,   // LONG entries blocked when cvdSession ≤ this
    cvdShortFloor: 3000,   // SHORT entries blocked when cvdSession ≥ this

    // Direction-specific behavior baked in from backtest findings:
    // dropFlipShorts: 2026-06-04 flipped TRUE → FALSE after 30-day analysis showed
    // qualified FLIP-SHORTs at 77.8% WR / +38.9 EV / +700 pts (n=18) — strongest
    // single signal in the system. Previous TRUE setting was leaving ~$3,500/short
    // on the table.
    dropFlipShorts: false,                 // qualified FLIP shorts ELIGIBLE for OPEN

    // ── Exit policy (Variant A — any-kind FLIP+CONT, 2026-06-08) ──
    //
    // A trade closes on any qualified opposing-direction signal whose rule_id
    // is in this allow-list. Validated by backtest_exit_variants.ts on
    // FLIP+CONT cohort: 40 trades, 67.5% WR, +1,138.5 pts ← chosen.
    // Keep in sync with signal-pipeline.ts:isTradableRule().
    tradableExitRules: ['clean-impulse', 'cont-reentry'] as string[],

    // forceShadowRules: rules evaluated and logged to tradable_signals but
    // NEVER open a trade (action=SKIP_FORCE_SHADOW). Used for rules that need
    // OOS sample accumulation before promotion.
    //   - es-flip: n=41 test / 60.7% LONG / 50% SHORT WR. Needs OOS.
    //   - expl: SILENCED + force-shadow. LONG 30% WR / -19 EV; SHORT 4% WR /
    //     -62 EV. Both losing; detector kept for research.
    forceShadowRules: ['es-flip', 'expl'] as string[],

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
