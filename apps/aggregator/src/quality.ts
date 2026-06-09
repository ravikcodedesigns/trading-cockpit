import type { ConfluenceSignal } from '@trading/contracts';

// Signal Quality Tiers
//
// Calibrated against absorption-v2 signals (new scoring: speed+purity+context, no RS bonuses).
// v2 backtest (n=61 at 80+, May 13–19): 56% win rate, avg DD→win 6-7pts, stop=20pts.
//
// ACTIVE GOLD TIER:
//   RTH absorption score >= 80  — 56% win rate (90+: 56%, 80-89: 56%)
//   Requires same-direction H FLIP within 60m. No conviction gate (validated ineffective).
//
// SILENCED (DB only, never broadcast):
//   Absorption score < 80   — 29-39% win rate, no edge
//   ON absorption            — RTH-only focus
//   All sweeps               — high drawdown, reactive
//   All tape-speed           — no edge
//   All large-print          — 0% clean wins

type Session = 'overnight' | 'rth' | 'closed';

function classifySession(tsMs: number): Session {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);
  if (isWeekday && min >= 570 && min < 960) return 'rth';
  if (isWeekday) {
    if (min < 570) return 'overnight';
    if (weekday !== 'Fri' && min >= 1080) return 'overnight';
    return 'closed';
  }
  if (weekday === 'Sun' && min >= 1080) return 'overnight';
  return 'closed';
}

export type QualityTier = 'gold' | 'silenced';
export interface QualityDecision { tier: QualityTier; reason: string; }

// Context passed by the caller so quality.ts can check cross-signal state
// without reaching into the DB directly.
export interface QualityContext {
  // EXPL signals for the same symbol that fired within the lookback window.
  recentExpls?: { ts: number; direction: string }[];
  // Regime change detection — computed from session bars by state.ts.
  // All fields optional: absent = condition inactive (no block).
  cvdLast30m?: number;        // cumulative delta for last 30 bars before signal
  cvdPrev30m?: number;        // cumulative delta for the 30 bars before that
  failedSameDirExpls?: number; // same-dir EXPLs fired today whose entry price was later broken
  sessionHigh?: number;
  sessionLow?: number;
  sessionOpen?: number;
  currentPrice?: number;
  // Most recent H FLIP signal for the same symbol in the last 60 min (null = none).
  // Used by Strategy B: absorption only broadcasts when a same-direction FLIP
  // confirmed the regime within the lookback window.
  lastFlip?: { ts: number; direction: string; entry?: number } | null;
}

function classifyStrategyA(_rule: string, _session: Session, _score: number): QualityDecision {
  // Temporarily silenced — hiding all A signals to isolate EXPL + CLEAN on chart.
  // Reinstate when re-enabling: RTH delta-divergence >=90 (gold)
  return { tier: 'silenced', reason: 'A: temporarily silenced for CLEAN analysis' };
}

// Maximum price distance between the FLIP's entry and the absorption entry.
// Beyond this threshold the FLIP context is price-stale: the move is already extended
// and absorptions firing at a much lower/higher level ride into a bounce zone.
// Calibrated: today's bad shorts were 228-275pts from FLIP level; good signals <100pts.
const FLIP_STALENESS_PTS = 150;

function classifyStrategyB(
  _rule: string, _session: Session, _score: number, direction: string,
  _conviction?: string, _ctx: QualityContext = {}, _absEntry?: number
): QualityDecision {
  // Strategy B (absorption) — SILENCED COMPLETELY 2026-06-04.
  // Removed from V3 entry rules 2026-06-02, hidden from chart, Discord-muted.
  // No qualified signals trade, no chart display, no Discord — zero active use.
  // Detector still runs (no-op cost is minor) and logs to signals table for
  // future regime-change re-evaluation. Previous FLIP-context gate (81.8% WR
  // filtered) preserved in git history for future research.
  return { tier: 'silenced', reason: `B: absorption ${direction} — fully retired (no V3 trade, no chart, no Discord)` };
}

// EXPL conflict check for FLIP signals — REMOVED 2026-06-04.
// Rationale: EXPL itself was silenced (both directions losing — LONG 30% WR, SHORT 4% WR).
// Using a broken signal as a counter-indicator for FLIP made no theoretical sense.
// Empirical impact of removal (30-day simulation):
//   LONG: +5-8 marginal sigs, ~breakeven (~40% WR on the new ones)
//   SHORT: +1 sig (5/13 09:42), CLEAN WIN +80 pts
//   Net: +75 pts, code simplification
// Original ratio-check logic preserved in git history for future reference.

// Regime change gate for LONG signals (2-of-3 independent conditions).
// Returns true when the market has likely flipped from bull to bear intraday.
// Only applied to long signals — short regime detection is separate (not yet calibrated).
function isRegimeBearish(signal: ConfluenceSignal, ctx: QualityContext): boolean {
  if (signal.direction !== 'long') return false;

  // Condition A: CVD momentum reversal — sellers dominated the last 30 bars
  // relative to the prior 30 bars. Threshold -3000 = ~100 contracts/bar net selling
  // sustained for 30 minutes: a meaningful shift, not noise.
  const condA =
    ctx.cvdLast30m !== undefined &&
    ctx.cvdPrev30m !== undefined &&
    (ctx.cvdLast30m - ctx.cvdPrev30m) < -3000;

  // Condition B: EXPL bid zone failure — same-direction EXPL(s) from earlier today
  // had their entry level broken, meaning institutional buyers at those levels left.
  const condB = (ctx.failedSameDirExpls ?? 0) >= 1;

  // Condition C: big-move afternoon distribution — we gave back 40%+ of session gain
  // on a day where the session ran 100+ pts, and it's past 1 PM ET.
  // Signature of afternoon distribution / exhaustion after a strong trending morning.
  const condC = (() => {
    if (!ctx.sessionHigh || !ctx.sessionOpen || !ctx.currentPrice) return false;
    const sessionGain = ctx.sessionHigh - ctx.sessionOpen;
    if (sessionGain < 100) return false;
    const givenBack = (ctx.sessionHigh - ctx.currentPrice) / sessionGain;
    if (givenBack < 0.4) return false;
    const hour = parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', hour12: false,
      }).format(new Date(signal.ts)),
      10
    );
    return hour >= 13;
  })();

  const score = (condA ? 1 : 0) + (condB ? 1 : 0) + (condC ? 1 : 0);
  return score >= 2;
}

export function classifySignalQuality(signal: ConfluenceSignal, ctx: QualityContext = {}): QualityDecision {
  const session = classifySession(signal.ts);
  const strategy = signal.strategyVersion ?? 'A';
  // ── Special-case: wall-broken-fade is visual-monitor mode ────────────────
  // Backtest shows 64-78% WR depending on peak size. Signal is promoted to
  // GOLD so it broadcasts via the bus to the cockpit chart, but discord.ts
  // suppresses notifications for this ruleId (avoid spam during validation).
  // Trader does NOT act on it because wall-broken-fade is not in TRADER_ENABLED_RULES.
  if (signal.ruleId === 'wall-broken-fade') {
    return { tier: 'gold', reason: `WBF visual-monitor mode: score=${signal.score}` };
  }
  // compression-realwall (shipped 2026-06-03): SHADOW pending multi-day MBO validation.
  // Single-day MBO produced 0 qualifying setups (no confluence formed on the bull-trend test day).
  // Force 'silenced' tier — signals still log to qualified_signals/v3_decisions for
  // accumulation but don't broadcast to chart/Discord and don't auto-trade.
  if (signal.ruleId === 'compression-realwall') {
    return { tier: 'silenced', reason: 'compression-realwall: shadow pending multi-day MBO data' };
  }
  // es-flip (2026-06-03): ES-tuned FLIP detector. SHADOW mode — gold tier so signals
  // broadcast to chart for visual monitoring. V3 logs decisions to v3_decisions but
  // doesn't auto-trade (forceShadowRules list).
  if (signal.ruleId === 'es-flip') {
    const ext = signal as any;
    return {
      tier: 'gold',
      reason: `ES-FLIP shadow: ${signal.direction} K=${ext.passCount ?? '?'}/5 score=${signal.score}`,
    };
  }
  if (strategy === 'A') return classifyStrategyA(signal.ruleId, session, signal.score);
  if (strategy === 'B') return classifyStrategyB(signal.ruleId, session, signal.score, signal.direction, (signal as any).conviction, ctx, (signal as any).entry);
  // Strategy C: all signals are gold — the level watcher is the quality gate.
  // Minimum score 50 is enforced inside strategy-c.ts before emission.
  if (strategy === 'C') return { tier: 'silenced', reason: 'C: temporarily silenced for CLEAN analysis' };
  if (strategy === 'D') return { tier: 'silenced', reason: 'D: temporarily silenced for CLEAN analysis' };
  if (strategy === 'E') return { tier: 'silenced', reason: 'E: temporarily silenced for CLEAN analysis' };
  // Strategy EXPL: SILENCED COMPLETELY (2026-06-04).
  // Performance through 06-02:
  //   LONG qualified (n=59): 30.5% WR / -19.1 EV / -1,130 pts
  //   SHORT raw (n=49):       4.1% WR / -61.6 EV / -3,018 pts
  // Both directions losing significantly. Detector keeps logging to signals/v3_decisions
  // for future research; gate returns silenced → hidden from chart, not in qualified_signals.
  // Also added to config.pipeline.forceShadowRules so V3 never opens an EXPL trade even if
  // promoted to live mode.
  if (strategy === 'EXPL') {
    return { tier: 'silenced', reason: `EXPL: silenced ${signal.direction} — both sides losing (LONG 30% WR, SHORT 4% WR)` };
  }
  // Strategy H: CLEAN impulse (FLIP only). Filters on FLIP:
  //   1. Delta15 gate: long FLIPs require net-bearish 15-bar background (delta15 < 500).
  //      A positive delta15 means buyers are still dominant — no exhaustion to reverse.
  //      Calibrated: 5/12 09:53 failure had delta15=+1726; all confirmed good longs had delta15 < 500.
  //   2. Delta5 direction gate: |delta5| >= 1000 in the wrong-direction sign for the FLIP.
  //   3. Regime gate: 2-of-3 bearish conditions block long FLIPs when market has flipped.
  // EXPL conflict check removed 2026-06-04 — EXPL was retired (both directions losing),
  //   so using it as counter-indicator made no sense. See checkExplConflict comment.
  // Delta5 EXPL-zone exception (800 threshold) also removed — uniformly 1000 now.
  if (strategy === 'H') {
    if ((signal as any).pattern === 'FLIP') {
      const ext = signal as any;

      // Delta15 gate (LONG only): need sellers to have dominated the 15-bar background.
      // Threshold >= 500: catches strong buyer dominance (+1726 failure case) while
      // ignoring neutral/noise readings like +83 which had zero directional conviction.
      if (signal.direction === 'long') {
        const d15 = ext.delta15 ?? null;
        if (d15 !== null && d15 >= 500) {
          return {
            tier: 'silenced',
            reason: `H: FLIP long buyers-dominant background delta15=+${d15} (need delta15 < 500)`,
          };
        }
      }

      // Delta5 direction gate: SHORT needs d5 >= 1000 (buyers were pushing up); LONG needs
      // d5 <= -1000 (sellers were pushing down). The "EXPL-zone substitute" (800 threshold)
      // was removed 2026-06-04 when EXPL was silenced — uniformly 1000 now.
      const d5 = ext.delta5 ?? 0;
      const d5Threshold = 1000;
      const d5Passes = signal.direction === 'short' ? d5 >= d5Threshold : d5 <= -d5Threshold;
      if (!d5Passes) {
        return {
          tier: 'silenced',
          reason: `H: FLIP ${signal.direction} wrong-direction background delta5=${d5} (short needs d5>=${d5Threshold}, long needs d5<=-${d5Threshold})`,
        };
      }

      // Regime gate disabled pending threshold calibration.
    }
    return { tier: 'gold', reason: `H: clean-impulse ${(signal as any).pattern ?? ''} score=${signal.score}` };
  }
  if (strategy === 'I') return { tier: 'gold', reason: `I: passive-seller score=${signal.score}` };
  // Strategy CONT: trend continuation re-entry. SHADOW mode (2026-06-03 promoted from silenced).
  // Empirical analysis on n=24 (May 20 – Jun 3) at TP=80/SL=70 → 66.7% WR, +30.5 EV/sig, +733 pts.
  // Promoted to gold-tier so signals broadcast to chart for visual monitoring. V3 will log
  // decisions to v3_decisions but won't auto-trade until OOS sample reaches ~50+ signals.
  if (strategy === 'CONT') {
    const ext = signal as any;
    const parentAgoMin = Math.round((signal.ts - (ext.parentTs ?? signal.ts)) / 60_000);
    return {
      tier: 'gold',
      reason: `CONT shadow: ${signal.direction} +${ext.extensionPts?.toFixed(0) ?? '?'}pt parent ${parentAgoMin}m ago retrace=${((ext.retracePct ?? 0) * 100).toFixed(0)}%`,
    };
  }
  // Strategy J: silenced pending structural pre-filter (RS level proximity + session context).
  // Backtested across all CVD/spike/recovery/buffer combos — no profitable configuration found.
  if (strategy === 'J') return { tier: 'silenced', reason: `J: TRAP silenced — no edge without structural pre-filter` };
  return { tier: 'silenced', reason: `unknown strategy ${strategy}` };
}
