import type { ConfluenceSignal } from '@trading/contracts';

/**
 * Signal Quality Tiers
 *
 * Centralized classifier that decides which signals get broadcast to
 * Discord + cockpit vs only logged to DB. Based on empirical outcome
 * data through 2026-05-01:
 *
 * Gold tier (broadcast):
 *   - RTH sweep score >= 70 (n=13: 92% hit at 20+, 92% at 30+, 69% at 40+)
 *   - RTH divergence score >= 80 (n=5: 100% hit at 20+, 100% at 30+)
 *   - Overnight divergence score >= 80 (n=2: 100% hit at 20+, small sample
 *     but kept by user choice)
 *
 * Silenced (DB only):
 *   - All overnight sweeps (n=230, score doesn't predict outcomes)
 *   - RTH sweeps below 70
 *   - RTH divergences below 80
 *   - Overnight divergences below 80
 *
 * As more data accumulates, thresholds here should be re-tuned. This is
 * the ONE place to adjust signal-tier policy across the system.
 */

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
  const RTH_START = 570;   // 09:30
  const RTH_END = 960;     // 16:00
  const ON_RESUME = 1080;  // 18:00
  const isWeekday = ['Mon','Tue','Wed','Thu','Fri'].includes(weekday);
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
  reason: string;  // human-readable explanation, useful for logging
}

export function classifySignalQuality(signal: ConfluenceSignal): QualityDecision {
  const session = classifySession(signal.ts);
  const score = signal.score;
  const rule = signal.ruleId;

  // Gold tier matches
  if (rule === 'sweep' && session === 'rth' && score >= 70) {
    return { tier: 'gold', reason: 'RTH sweep score >=70' };
  }
  if (rule === 'delta-divergence' && session === 'rth' && score >= 80) {
    return { tier: 'gold', reason: 'RTH divergence score >=80' };
  }
  if (rule === 'delta-divergence' && session === 'overnight' && score >= 80) {
    return { tier: 'gold', reason: 'Overnight divergence score >=80' };
  }

  // Everything else is silenced
  return {
    tier: 'silenced',
    reason: `${rule} ${session} score=${score} below tier threshold`,
  };
}
