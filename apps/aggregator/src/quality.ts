import type { ConfluenceSignal } from '@trading/contracts';

// Signal Quality Tiers
//
// Centralized classifier that decides which signals get broadcast to
// Discord + cockpit vs only logged to DB.
//
// This is the ONE place to adjust signal-tier policy across the system.
// Both Strategy A and Strategy B signals flow through here.
//
// Current thresholds (calibrated against outcome data through 2026-05-04):
//
// Strategy A gold tier:
//   - RTH sweep score >= 70       (n=23: 91% hit@30pts, 69% hit@40pts)
//   - RTH divergence score >= 80  (n=9: 100% hit@20pts, 100% hit@30pts)
//   - Overnight divergence >= 80  (n=2: kept by user choice, small sample)
//
// Strategy B gold tier (absorption):
//   - RTH absorption score >= 60  (initial threshold, calibrate after 2 weeks)
//   - Overnight absorption >= 70  (higher bar given lower overnight liquidity)
//
// Silenced (DB only, for ongoing outcome validation):
//   - All overnight sweeps (n=312, score doesn't predict outcomes)
//   - RTH sweeps below 70
//   - All divergences below 80
//   - Absorption below threshold

type Session = 'overnight' | 'rth' | 'closed';

function classifySession(tsMs: number): Session {
  const d = new Date(tsMs);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const minutesOfDay = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  const RTH_START = 570;
  const RTH_END = 960;
  const ON_RESUME = 1080;
  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);
  if (isWeekday && minutesOfDay >= RTH_START && minutesOfDay < RTH_END) return 'rth';
  if (isWeekday) {
    if (minutesOfDay < RTH_START) return 'overnight';
    if (weekday !== 'Fri' && minutesOfDay >= ON_RESUME) return 'overnight';
    return 'closed';
  }
  if (weekday === 'Sun' && minutesOfDay >= ON_RESUME) return 'overnight';
  return 'closed';
}

export type QualityTier = 'gold' | 'silenced';

export interface QualityDecision {
  tier: QualityTier;
  reason: string;
}

// Strategy A thresholds (bar-based rules)
function classifyStrategyA(rule: string, session: Session, score: number): QualityDecision {
  if (rule === 'sweep' && session === 'rth' && score >= 70) {
    return { tier: 'gold', reason: 'A: RTH sweep >=70' };
  }
  if (rule === 'delta-divergence' && session === 'rth' && score >= 80) {
    return { tier: 'gold', reason: 'A: RTH divergence >=80' };
  }
  if (rule === 'delta-divergence' && session === 'overnight' && score >= 80) {
    return { tier: 'gold', reason: 'A: ON divergence >=80' };
  }
  return { tier: 'silenced', reason: `A: ${rule} ${session} score=${score} below threshold` };
}

// Strategy B thresholds (tick-based rules)
// Conservative initially — tighten or loosen based on outcome data after 2 weeks.
function classifyStrategyB(rule: string, session: Session, score: number): QualityDecision {
  if (rule === 'absorption' && session === 'rth' && score >= 60) {
    return { tier: 'gold', reason: 'B: RTH absorption >=60' };
  }
  if (rule === 'absorption' && session === 'overnight' && score >= 70) {
    return { tier: 'gold', reason: 'B: ON absorption >=70' };
  }
  return { tier: 'silenced', reason: `B: ${rule} ${session} score=${score} below threshold` };
}

export function classifySignalQuality(signal: ConfluenceSignal): QualityDecision {
  const session = classifySession(signal.ts);
  const strategy = signal.strategyVersion ?? 'A';

  if (strategy === 'A') {
    return classifyStrategyA(signal.ruleId, session, signal.score);
  }
  if (strategy === 'B') {
    return classifyStrategyB(signal.ruleId, session, signal.score);
  }

  // Fallback: silence unknown strategies
  return { tier: 'silenced', reason: `unknown strategy ${strategy}` };
}
