import type { ConfluenceSignal } from '@trading/contracts';

// Signal Quality Tiers
//
// Calibrated against 1,351 matured signals through 2026-05-06.
//
// THREE ACTIVE GOLD TIER SIGNALS:
//
//   1. RTH absorption 70-79   n=15: hit30@15=47%, cln@15=27%, dd@5m=15.0
//      Best overall signal. Trend filter applied (5-min HH/HL structure).
//      Counter-trend requires score >= 80.
//
//   2. ON absorption 65-79    n=161: hit30@15=40%, cln@15=20%, dd@5m=10.5
//      Best overnight signal. Lowered from 70 to 65 (n=115 at 60-69,
//      37% hit30@15, 17% cln@15 -- meaningful enough for gold tier).
//      No trend filter overnight (low dd@5m protects adequately).
//
//   3. RTH divergence 90+     n=16: hit30@15=44%, cln@15=13%, hit30@60=81%
//      Slow burner, hold 45-60 min, 25pt stops.
//
// ARCHIVED (DB only, never broadcast):
//   All sweeps        -- high drawdown, reactive, incompatible with clean focus
//   All tape-speed    -- 409 samples, no edge, degrades absorption confluence
//   All large-print   -- 0% clean wins across all bands
//   ON divergence     -- 0% clean wins
//   RTH absorption 80+ -- too few samples (n=3 RTH 80-89)
//   ON absorption 80+  -- archived pending more data (behavior changes at 80+)
//   Absorption 90+     -- exhaustion signal, collapses at high scores

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

function classifyStrategyA(rule: string, session: Session, score: number): QualityDecision {
  // Sweeps: archived -- DB only
  if (rule === 'sweep') {
    return { tier: 'silenced', reason: 'A: sweep archived' };
  }
  // RTH divergence 90+ only -- slow burner, 81% hit@30 at 60min
  if (rule === 'delta-divergence' && session === 'rth' && score >= 90) {
    return { tier: 'gold', reason: 'A: RTH divergence >=90' };
  }
  return { tier: 'silenced', reason: `A: ${rule} ${session} score=${score} below threshold` };
}

function classifyStrategyB(rule: string, session: Session, score: number): QualityDecision {
  // RTH absorption 70-79 -- trend filter applied in absorption.ts
  // Counter-trend signals with score < 80 are already filtered before reaching here
  if (rule === 'absorption' && session === 'rth' && score >= 70 && score <= 79) {
    return { tier: 'gold', reason: 'B: RTH absorption 70-79' };
  }
  // ON absorption 65-79 -- lowered from 70 based on 60-69 data (n=115, 37% hit30@15)
  if (rule === 'absorption' && session === 'overnight' && score >= 65 && score <= 79) {
    return { tier: 'gold', reason: 'B: ON absorption 65-79' };
  }
  // Everything else silenced
  return { tier: 'silenced', reason: `B: ${rule} ${session} below threshold` };
}

export function classifySignalQuality(signal: ConfluenceSignal): QualityDecision {
  const session = classifySession(signal.ts);
  const strategy = signal.strategyVersion ?? 'A';
  if (strategy === 'A') return classifyStrategyA(signal.ruleId, session, signal.score);
  if (strategy === 'B') return classifyStrategyB(signal.ruleId, session, signal.score);
  return { tier: 'silenced', reason: `unknown strategy ${strategy}` };
}
