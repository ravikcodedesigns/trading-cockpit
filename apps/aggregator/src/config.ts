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
    // 2026-06-17: cvdLongFloor -3000 → -1000 (armed on 4 trades, 0W/4L, p≈0.025;
    // the comment itself said "not a proven edge").
    // 2026-07-08: LONG FLOOR DISABLED (user-approved). Its own forward sample
    // inverted the founding claim: 40 vetoed longs = 20W/19L +10.6pt avg, and
    // the DEEPEST-CVD cohort (-28k..-5k) was the BEST at +24.5pt/trade while
    // kept longs lost -3.3pt on the same window. Session-CVD alignment is a
    // directional-alignment filter — a class already rejected OOS for FLIP
    // (fires against momentum by design; Friday 06-12 post-mortem). Registered
    // CVD-LONGFLOOR-OFF (live-book family); newly-opened rows tagged
    // '[CVD-LFO...]' in reason + marked on the chart for forward tracking.
    // Short floor UNCHANGED: its forward sample blocks real losers (-16pt avg).
    cvdLongFloor: -999_999, // LONG floor DISABLED 2026-07-08 (was -1000; see above)
    cvdShortFloor: 3000,    // SHORT entries blocked when cvdSession ≥ this

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
    //   - expl: SILENCED + force-shadow. LONG 30% WR / -19 EV; SHORT 4% WR /
    //     -62 EV. Both losing; detector kept for research.
    // es-flip removed 2026-07-08 (retired: OOS-dead at n=266).
    forceShadowRules: ['expl'] as string[],

    // ── FLIP-long delta15_ratio gate (2026-06-12) ──────────────────────────
    //
    // Backtest on 72 historical FLIP-long signals (May → mid-June 2026):
    //   • Baseline                       n=72 WR=44.4% Net=+$2,260 ($31/trade)
    //   • delta15_ratio ≤ -0.02 filter   n=50 WR=54.0% Net=+$2,890 ($58/trade)
    //
    // Permutation test (10k shuffles) — multiple-comparison corrected:
    //   • Sweep-corrected p(Net$) = 0.007 → significant
    //   • Sweep-corrected p(WR)   = 0.168 → NOT significant on WR alone
    //
    // Conclusion: there's a real $-edge but the WR lift might be partly
    // overfit. We shadow-track for ~1 week (live aggregator emits the marker
    // but does NOT skip the trade), then review and decide whether to flip
    // `enabled` to true.
    //
    // Env override: FLIP_LONG_DELTA15_GATE=enabled flips it live.
    flipLongDelta15Gate: {
      enabled: (process.env.FLIP_LONG_DELTA15_GATE ?? 'shadow') === 'enabled',
      // Threshold derived from sweep — best $-edge with sample preserved at 69%.
      threshold: -0.02,
    },

    // ── FLIP-long trap veto (2026-06-18) ───────────────────────────────────
    //
    // Skip a FLIP LONG when a SAME-direction (long) trap fired within windowMs
    // before the signal. A trap is a fast spike+reclaim fade at a structural
    // level; a flip long arriving right after a same-dir trap is a LATE ECHO of
    // a reversal the trap already captured (or the level is being chopped), and
    // underperforms badly.
    //
    // Validated on the NQ tradable book (97 OPEN flips, May–Jun 2026), longs only:
    //   • flip-long baseline      n=68  WR=53%  +$2,044
    //   • same-dir trap veto      kept 52  WR=60%  +$2,437  (drops 16 @ 33% WR)
    //   • June (held-out) OOS      42% → 47%
    //   • permutation: pnl p=0.030, WR p=0.051 (flagged n=16)
    // LONGS ONLY — flip shorts already 71% WR and show no benefit (veto flags
    // only n=2, not significant). Subtractive-only: it can only SKIP a flip,
    // never opens/sizes/flips a trade. Env FLIP_TRAP_VETO=off reverts instantly.
    flipTrapVeto: {
      enabled: (process.env.FLIP_TRAP_VETO ?? 'enabled') !== 'off',
      windowMs: 30 * 60_000,
    },

    // Per-rule TP/SL points. Number → both directions; { long, short } → asymmetric.
    perRule: {
      'absorption':              { tp: 80, sl: 140 },
      'clean-impulse-FLIP':      { tp: 80, sl: { long: 55, short: 105 } },
      'expl':                    { tp: 80, sl: 70 },
      'wall-broken-fade':        { tp: 20, sl: 10 },
      // compression-realwall + flip-long-pmcore RETIRED 2026-07-09 (never fired/never wired).
      // 2026-06-03: cont-reentry (Strategy CONT). SHADOW pending more signal accumulation.
      // Empirical analysis on n=24 (May 20 – Jun 3) at TP=80/SL=70 → 66.7% WR, +30.5 EV/sig,
      // +733 pts total. Wide stops required — median time-to-peak 73 min, median DD on
      // losers 72pt. Rule's shipped stopDist=25pt would kill 7/17 winners.
      'cont-reentry':            { tp: 80, sl: 70 },
      // Derived via labelled-swing analysis on 8 train days, validated on 8 test days.
      // LONG K=4 / SHORT K=5 with swing-confirmation gate (±5 bars).
      // Test results: LONG 60.7% WR / +2.9 EV / 7.2 sig/day; SHORT 50% WR / +2.7 EV / 1.5 sig/day.
      // Symmetric TP=20/SL=20 for simplicity.
    } as const,
  },
};
