// Opening Range Mode (ORM) — per-symbol session regime tracker
//
// At 9:45 ET, classifies the opening 15 minutes:
//   TREND-UP   (net_move > +100pt): suppress SHORT signals for 45 min
//   TREND-DOWN (net_move < -100pt): suppress LONG signals for 45 min
//   CHOPPY     (|net| <= 100 but range > 120pt): suppress ALL signals until 10:30 ET
//   CALM       (else): no suppression
//
// Early-exit: if price reverses 80pt from the classified extreme, mode resets to CALM.
// State is per-symbol; resets each day at first bar after 9:30 ET.

export type RegimeMode = 'TREND-UP' | 'TREND-DOWN' | 'CHOPPY' | 'CALM';

export interface RegimeState {
  mode:         RegimeMode;
  lockedUntil:  number;   // ms — suppression expires at this timestamp
  extreme:      number;   // high (TREND-UP) or low (TREND-DOWN) at 9:45
  openPrice:    number;   // price at 9:30 open
}

const ORM_NET_THRESHOLD   = 100;             // pts net move 9:30→9:45 to classify as trending
const ORM_RANGE_CHOPPY    = 120;             // pts 9:30–9:45 range to classify as choppy
const ORM_LOCK_MS         = 45 * 60 * 1000; // 45 min trend suppression
const ORM_REVERSAL_UNLOCK = 80;             // pts reversal from extreme to cancel lock early
const RTH_START_MIN       = 570;             // 9:30 ET
const ORM_MEASURE_MIN     = 585;             // 9:45 ET — when classification fires
const CHOPPY_CLEAR_MIN    = 630;             // 10:30 ET — choppy lock expires here

interface SessionData {
  open930:         number | null;
  high945:         number;
  low945:          number;
  measurementDone: boolean;
  lastResetDate:   string;   // ET date 'YYYY-MM-DD'
}

const _states   = new Map<string, RegimeState>();
const _sessions = new Map<string, SessionData>();

function getState(symbol: string): RegimeState {
  if (!_states.has(symbol)) {
    _states.set(symbol, { mode: 'CALM', lockedUntil: 0, extreme: 0, openPrice: 0 });
  }
  return _states.get(symbol)!;
}

function getSession(symbol: string): SessionData {
  if (!_sessions.has(symbol)) {
    _sessions.set(symbol, {
      open930: null, high945: 0, low945: Infinity,
      measurementDone: false, lastResetDate: '',
    });
  }
  return _sessions.get(symbol)!;
}

function etDateStr(tsMs: number): string {
  return new Date(tsMs - 4 * 3600 * 1000).toISOString().slice(0, 10);
}

function etMinutes(tsMs: number): number {
  const d = new Date(tsMs - 4 * 3600 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * Call once per bar close (any strategy that fetches bars).
 * Updates opening-range tracking and classifies the regime at 9:45.
 */
export function updateRegime(symbol: string, nowMs: number, price: number): void {
  const etMin = etMinutes(nowMs);
  const today = etDateStr(nowMs);
  const sess  = getSession(symbol);

  // Reset on first bar of a new RTH session
  if (today !== sess.lastResetDate && etMin >= RTH_START_MIN) {
    sess.lastResetDate   = today;
    sess.open930         = price;
    sess.high945         = price;
    sess.low945          = price;
    sess.measurementDone = false;
    _states.set(symbol, { mode: 'CALM', lockedUntil: 0, extreme: 0, openPrice: price });
    return;
  }

  if (!sess.open930) return;  // haven't seen 9:30 yet today

  // Accumulate 9:30–9:45 range
  if (etMin >= RTH_START_MIN && etMin < ORM_MEASURE_MIN) {
    sess.high945 = Math.max(sess.high945, price);
    sess.low945  = Math.min(sess.low945,  price);
    return;
  }

  // At 9:45+: classify once per day
  if (etMin >= ORM_MEASURE_MIN && !sess.measurementDone) {
    sess.measurementDone = true;
    const netMove = price - sess.open930;
    const range   = sess.high945 - sess.low945;
    const lockExp = nowMs + ORM_LOCK_MS;

    let newState: RegimeState;
    if (netMove > ORM_NET_THRESHOLD) {
      newState = { mode: 'TREND-UP',   lockedUntil: lockExp, extreme: sess.high945, openPrice: sess.open930 };
    } else if (netMove < -ORM_NET_THRESHOLD) {
      newState = { mode: 'TREND-DOWN', lockedUntil: lockExp, extreme: sess.low945,  openPrice: sess.open930 };
    } else if (range > ORM_RANGE_CHOPPY) {
      const chopMs = Math.max(0, (CHOPPY_CLEAR_MIN - etMin) * 60 * 1000);
      newState = { mode: 'CHOPPY', lockedUntil: nowMs + chopMs, extreme: 0, openPrice: sess.open930 };
    } else {
      newState = { mode: 'CALM', lockedUntil: 0, extreme: 0, openPrice: sess.open930 };
    }
    _states.set(symbol, newState);
    return;
  }

  const st = getState(symbol);
  if (st.mode === 'CALM') return;

  // Lock expired → back to CALM
  if (nowMs > st.lockedUntil) {
    _states.set(symbol, { ...st, mode: 'CALM', lockedUntil: 0 });
    return;
  }

  // Early-exit: strong reversal from the classified extreme unlocks early
  if (st.mode === 'TREND-UP'   && st.extreme - price > ORM_REVERSAL_UNLOCK) {
    _states.set(symbol, { ...st, mode: 'CALM', lockedUntil: 0 });
  } else if (st.mode === 'TREND-DOWN' && price - st.extreme > ORM_REVERSAL_UNLOCK) {
    _states.set(symbol, { ...st, mode: 'CALM', lockedUntil: 0 });
  }
}

export function getRegime(symbol: string): RegimeState {
  return getState(symbol);
}

/**
 * Returns false if the regime suppresses this direction right now.
 * Call before emitting any signal.
 */
export function isSignalAllowed(symbol: string, direction: 'long' | 'short', nowMs: number): boolean {
  const st = getState(symbol);
  if (nowMs > st.lockedUntil) return true;   // lock expired
  if (st.mode === 'TREND-UP'   && direction === 'short') return false;
  if (st.mode === 'TREND-DOWN' && direction === 'long')  return false;
  if (st.mode === 'CHOPPY') return false;
  return true;
}
