/**
 * Per-session signal thresholds.
 *
 * Markets behave differently in overnight vs RTH; the same numerical bar
 * for "this is a meaningful sweep" doesn't apply across sessions. This
 * module computes the current session from time-of-day (NY time) and
 * exposes the right thresholds for that session.
 *
 * Initial overnight values were calibrated empirically from ~hours of
 * MNQ overnight data: 90th percentile of sweep volume = 119, levels = 13.
 * RTH values are placeholders (rough 1.8x scaling vs overnight) until we
 * collect actual RTH data and recalibrate.
 *
 * Recalibration plan: every Sunday, run a script over the past 7 days of
 * sweep events grouped by session, recompute 90th/95th percentiles, and
 * update the constants here. Self-tuning over time.
 */

export type Session = 'overnight' | 'rth' | 'closed';

/**
 * Determines the current trading session for a given UTC timestamp.
 * Boundaries (in NY time, handling EST/EDT automatically):
 *   - RTH:        weekdays  09:30 - 16:00 NY
 *   - Overnight:  weekdays  18:00 - next-day 09:30 NY  (and Sunday 18:00 onward)
 *   - Closed:     other times (Saturday, weekday 16:00-18:00, etc.)
 */
export function classifySession(tsMs: number = Date.now()): Session {
  const date = new Date(tsMs);

  // Convert to NY-time components via Intl. We get the wall clock at America/New_York.
  // This auto-handles DST transitions twice a year without us caring.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const minutesOfDay = hour * 60 + minute;

  // Weekday checks (Mon-Fri have RTH and overnight; weekend mostly closed)
  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);
  const isSaturday = weekday === 'Sat';
  const isSunday = weekday === 'Sun';

  const RTH_START = 9 * 60 + 30;   // 09:30
  const RTH_END = 16 * 60;         // 16:00
  const ON_RESUME = 18 * 60;       // 18:00 (Globex re-open)

  if (isWeekday && minutesOfDay >= RTH_START && minutesOfDay < RTH_END) {
    return 'rth';
  }

  // Overnight session windows:
  //   - Mon-Thu 18:00 to next-day 09:30 (the "next day" portion is captured below)
  //   - Mon-Fri before 09:30
  //   - Friday after 16:00 -> closed (CME close 17:00 Fri to 18:00 Sun)
  //   - Sunday from 18:00 onward
  if (isWeekday) {
    // After 16:00 on Mon-Thu = overnight starts at 18:00, so 16:00-18:00 is closed
    if (minutesOfDay < RTH_START) return 'overnight';
    if (weekday !== 'Fri' && minutesOfDay >= ON_RESUME) return 'overnight';
    return 'closed'; // 16:00-18:00 weekday gap, or Friday after 16:00
  }
  if (isSunday && minutesOfDay >= ON_RESUME) return 'overnight';

  // Saturday and most of Sunday: closed
  return 'closed';
}

/** Per-session thresholds for the sweep rule. */
export interface SweepThresholds {
  minVolume: number;
  minLevels: number;
}

/** Per-session thresholds for the delta divergence rule. */
export interface DivergenceThresholds {
  minMagnitude: number;       // 0-100; only fire if event magnitude >= this
  minDeltaDiff: number;       // raw cumulative-delta difference between extremes
}

const SWEEP_THRESHOLDS: Record<Session, SweepThresholds> = {
  // Overnight: ~90th percentile of observed MNQ overnight burst sizes
  overnight: { minVolume: 120, minLevels: 13 },

  // RTH: placeholder. Estimated 1.8x scaling vs overnight to account for
  // higher participant volume during regular hours. Recalibrate from
  // actual RTH data after we collect a few sessions.
  rth: { minVolume: 215, minLevels: 18 },

  // Closed (weekend, Mon-Thu 16:00-18:00 gap): no signals fire.
  // Effectively impossible thresholds.
  closed: { minVolume: Number.POSITIVE_INFINITY, minLevels: Number.POSITIVE_INFINITY },
};

const DIVERGENCE_THRESHOLDS: Record<Session, DivergenceThresholds> = {
  // Overnight: addon emits at deltaDiff >= 100. Aggregator gate: only fire
  // signal when deltaDiff >= 200 AND magnitude >= 50.
  overnight: { minMagnitude: 50, minDeltaDiff: 200 },

  // RTH: placeholder. Higher-volume sessions need higher diff thresholds
  // to filter normal activity. Recalibrate from data.
  rth: { minMagnitude: 60, minDeltaDiff: 400 },

  // Closed: no signals.
  closed: { minMagnitude: Number.POSITIVE_INFINITY, minDeltaDiff: Number.POSITIVE_INFINITY },
};

export function sweepThresholdsForSession(session: Session): SweepThresholds {
  return SWEEP_THRESHOLDS[session];
}

export function divergenceThresholdsForSession(session: Session): DivergenceThresholds {
  return DIVERGENCE_THRESHOLDS[session];
}

/** Convenience: classify + lookup in one call. */
export function currentSweepThresholds(tsMs: number = Date.now()): {
  session: Session;
  thresholds: SweepThresholds;
} {
  const session = classifySession(tsMs);
  return { session, thresholds: sweepThresholdsForSession(session) };
}

export function currentDivergenceThresholds(tsMs: number = Date.now()): {
  session: Session;
  thresholds: DivergenceThresholds;
} {
  const session = classifySession(tsMs);
  return { session, thresholds: divergenceThresholdsForSession(session) };
}
