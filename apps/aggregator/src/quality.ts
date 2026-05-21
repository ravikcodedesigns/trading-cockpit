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
  _rule: string, session: Session, score: number, direction: string,
  conviction?: string, ctx: QualityContext = {}, absEntry?: number
): QualityDecision {
  if (session !== 'rth') return { tier: 'silenced', reason: 'B: ON absorption silenced (RTH-only focus)' };
  if (score < 80) {
    return { tier: 'silenced', reason: `B: score=${score} below threshold` };
  }
  // Require a same-direction H FLIP within the last 60 min.
  // Backtest (n=33): FLIP-filtered win rate 81.8% vs 31.8% unfiltered.
  // Signals with no FLIP context avg -4.37 net — worst performing bucket.
  const flip = ctx.lastFlip;
  if (flip === undefined) {
    // Context not injected (snapshot path without regime data) — allow through.
    // Live applySignal() always injects lastFlip so this only affects old snapshots.
    return { tier: 'gold', reason: `B: RTH absorption score=${score} (no flip ctx)` };
  }
  if (flip === null || flip.direction !== direction) {
    const why = flip === null ? 'no FLIP in 60m window' : `last FLIP=${flip.direction} (opposing)`;
    return { tier: 'silenced', reason: `B: ${why} — needs same-dir FLIP context` };
  }
  // Price-staleness gate: if the market has moved >150pts from the FLIP entry,
  // that FLIP is no longer representative of current structure. Absorptions this
  // deep into an extended move have large bounce risk before the trend resumes.
  if (flip.entry !== undefined && absEntry !== undefined) {
    const ptsDrift = Math.abs(absEntry - flip.entry);
    if (ptsDrift > FLIP_STALENESS_PTS) {
      return {
        tier: 'silenced',
        reason: `B: FLIP@${flip.entry} is ${ptsDrift.toFixed(0)}pts from absorption@${absEntry} (>${FLIP_STALENESS_PTS}pt staleness gate)`,
      };
    }
  }
  const agoMin = Math.round((Date.now() - flip.ts) / 60_000);
  return { tier: 'gold', reason: `B: RTH absorption score=${score} FLIP-confirmed ${agoMin}m ago` };
}

// EXPL conflict check for FLIP signals.
// Block when the most recent EXPL in the lookback window opposes the flip direction
// AND the flip's exhaustion ratio > 0.25 (i.e. it is NOT a structural exhaustion
// of the EXPL itself — a ratio < 0.25 means the candle moved hard against the
// prevailing delta, which is the signature of a genuine EXPL completion reversal).
function checkExplConflict(signal: ConfluenceSignal, ctx: QualityContext): QualityDecision | null {
  const expls = ctx.recentExpls;
  if (!expls || expls.length === 0) return null;

  const sameDir = expls.filter(e => e.direction === signal.direction);
  const oppDir  = expls.filter(e => e.direction !== signal.direction);
  const lastSame = sameDir.at(-1);
  const lastOpp  = oppDir.at(-1);

  const isConflict = !!lastOpp && (!lastSame || lastOpp.ts > lastSame.ts);
  if (!isConflict) return null;

  const ext   = signal as any;
  const dT    = Math.abs(ext.deltaT    ?? 0);
  const d5    = Math.abs(ext.delta5    ?? 0);
  const dl    = Math.abs(ext.delta_last3 ?? 0);
  const denom = Math.max(d5, dl);
  const ratio = denom === 0 ? 999 : dT / denom;

  if (ratio <= 0.25) return null; // structural exhaustion of the EXPL — allow through

  const agoMin = Math.round((signal.ts - lastOpp.ts) / 60_000);
  return {
    tier: 'silenced',
    reason: `H: FLIP ${signal.direction} blocked — EXPL ${lastOpp.direction} active ${agoMin}m ago (ratio=${ratio.toFixed(2)})`,
  };
}

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
  if (strategy === 'A') return classifyStrategyA(signal.ruleId, session, signal.score);
  if (strategy === 'B') return classifyStrategyB(signal.ruleId, session, signal.score, signal.direction, (signal as any).conviction, ctx, (signal as any).entry);
  // Strategy C: all signals are gold — the level watcher is the quality gate.
  // Minimum score 50 is enforced inside strategy-c.ts before emission.
  if (strategy === 'C') return { tier: 'silenced', reason: 'C: temporarily silenced for CLEAN analysis' };
  if (strategy === 'D') return { tier: 'silenced', reason: 'D: temporarily silenced for CLEAN analysis' };
  if (strategy === 'E') return { tier: 'silenced', reason: 'E: temporarily silenced for CLEAN analysis' };
  // Strategy EXPL: pre-explosive move detector. Score gate enforced inside
  // strategy-expl.ts (MIN_SCORE_TO_FIRE = 3). All signals that reach here passed.
  // SHORT side is silenced — only 2 historical signals, both failures (0% hit 20pt,
  // avg MAE 68pt). SHORT detector needs calibration before going live.
  if (strategy === 'EXPL') {
    if (signal.direction === 'short') return { tier: 'silenced', reason: 'EXPL: short side uncalibrated (n=2, 0% win rate)' };
    // Require at least one stacked bid zone — every historical good EXPL had one;
    // the two signals without bid zones both failed immediately (2026-05-13 14:38, 15:16).
    const bidZones = (signal as any).stackedBidZones as unknown[] | undefined;
    if (!bidZones || bidZones.length === 0) {
      return { tier: 'silenced', reason: `EXPL: no stacked bid zones (score=${signal.score})` };
    }
    // Zone position filter: reject longs where bid zone is in the lower half of the
    // 60-min range (rangePct < 0.5). Low-range zones indicate buyers are absorbing
    // near the session low, not near a compression breakout area — weaker setup.
    // Historical calibration: all good EXPLs had rangePct > 0.56; 5/13 09:30 failure = 0.319.
    const rangePct = (signal as any).rangePct as number | null | undefined;
    if (signal.direction === 'long' && rangePct !== null && rangePct !== undefined && rangePct < 0.5) {
      return { tier: 'silenced', reason: `EXPL: bid zone too low in range (rangePct=${rangePct.toFixed(2)} < 0.50)` };
    }
    // Regime gate disabled pending threshold calibration.
    // condA (CVD slope) never fires in practice — bookmap CVD recovers at signal times
    // even on bearish-looking sessions. condB+condC alone (2-of-3 without CVD) has 2
    // collateral vs 1 correct block and misses the 5/08 afternoon cluster entirely.
    // Re-enable once condA threshold is calibrated against more session data.
    return { tier: 'gold', reason: `EXPL: explosive move setup score=${signal.score} zones=${bidZones.length}` };
  }
  // Strategy H: CLEAN impulse (FLIP + CONT, both directions). Filters on FLIP:
  //   1. EXPL conflict: opposing EXPL most recent in 60-min window + ratio > 0.25 → silenced
  //   2. Delta15 gate: long FLIPs require net-bearish 15-bar background (delta15 < 0).
  //      A positive delta15 means buyers are still dominant — no exhaustion to reverse.
  //      Calibrated: 5/12 09:53 failure had delta15=+1726; all confirmed good longs had delta15 < 0.
  //   3. Delta5 gate: |delta5| >= 1000 without EXPL zone context, >= 800 with it.
  //      EXPL zone confirmation substitutes for raw delta magnitude — the zone
  //      absorbs sellers so the flip needs less background pressure to be valid.
  //   4. Regime gate: 2-of-3 bearish conditions block long FLIPs when market has flipped.
  if (strategy === 'H') {
    if ((signal as any).pattern === 'FLIP') {
      const conflict = checkExplConflict(signal, ctx);
      if (conflict) return conflict;

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

      const absd5 = Math.abs(ext.delta5 ?? 0);
      const hasSameDirExpl = (ctx.recentExpls ?? []).some(e => e.direction === signal.direction);
      const d5Threshold = hasSameDirExpl ? 800 : 1000;
      if (absd5 < d5Threshold) {
        return {
          tier: 'silenced',
          reason: `H: FLIP ${signal.direction} weak background delta5=${ext.delta5 ?? 0} (need |d5|>=${d5Threshold}${hasSameDirExpl ? ' EXPL-zone' : ''})`,
        };
      }

      // Regime gate disabled pending threshold calibration.
      // See EXPL block above for rationale — same issue applies here.
    }
    return { tier: 'gold', reason: `H: clean-impulse ${(signal as any).pattern ?? ''} score=${signal.score}` };
  }
  if (strategy === 'I') return { tier: 'gold', reason: `I: passive-seller score=${signal.score}` };
  // Strategy CONT: trend continuation re-entry. Observe-only pending calibration.
  // Backtest (n=11, May 4–19): 45% win rate overall, 60% at score>=90.
  // n too small for production — collecting data until n>=30 before enabling.
  if (strategy === 'CONT') {
    const ext = signal as any;
    const parentAgoMin = Math.round((signal.ts - (ext.parentTs ?? signal.ts)) / 60_000);
    return {
      tier: 'silenced',
      reason: `CONT: observe-only (n=11, 45% WR) — ${signal.direction} +${ext.extensionPts?.toFixed(0) ?? '?'}pt parent ${parentAgoMin}m ago retrace=${((ext.retracePct ?? 0) * 100).toFixed(0)}%`,
    };
  }
  // Strategy J: silenced pending structural pre-filter (RS level proximity + session context).
  // Backtested across all CVD/spike/recovery/buffer combos — no profitable configuration found.
  if (strategy === 'J') return { tier: 'silenced', reason: `J: TRAP silenced — no edge without structural pre-filter` };
  return { tier: 'silenced', reason: `unknown strategy ${strategy}` };
}
