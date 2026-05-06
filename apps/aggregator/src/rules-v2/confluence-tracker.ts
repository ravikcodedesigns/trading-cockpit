// Confluence Tracker
//
// Shared in-memory store that Strategy B rules use to signal their
// recent activity to other rules. Enables confluence detection without
// rules directly calling each other.
//
// Pattern:
//   1. tape-speed fires -> writes to confluenceTracker
//   2. absorption fires -> reads confluenceTracker to check if tape-speed
//      confirmed the same direction within the confluence window
//   3. absorption signal tagged with tapeSpeedConfirmed=true/false
//   4. Outcome tracker splits absorption results by this tag
//
// The window is intentionally short (60s) -- confluence means nearly
// simultaneous agreement, not loose temporal association.

const CONFLUENCE_WINDOW_MS = 60_000;

interface RecentSignal {
  ts: number;
  direction: 'long' | 'short';
  score: number;
  ruleId: string;
}

// Map: symbol -> list of recent signals from each rule
const _store = new Map<string, RecentSignal[]>();

function storeKey(symbol: string): string {
  return symbol;
}

// Called by any rule when it fires a signal
export function recordConfluenceSignal(
  symbol: string,
  ruleId: string,
  direction: 'long' | 'short',
  score: number,
  tsMs: number
): void {
  const key = storeKey(symbol);
  if (!_store.has(key)) _store.set(key, []);
  const list = _store.get(key)!;
  list.push({ ts: tsMs, direction, score, ruleId });
  // Evict old entries
  const cutoff = tsMs - CONFLUENCE_WINDOW_MS * 2;
  const fresh = list.filter(s => s.ts >= cutoff);
  _store.set(key, fresh);
}

// Called by absorption to check if tape-speed confirmed same direction
// within the confluence window
export function checkTapeSpeedConfirmed(
  symbol: string,
  direction: 'long' | 'short',
  nowMs: number
): boolean {
  const key = storeKey(symbol);
  const list = _store.get(key) ?? [];
  const cutoff = nowMs - CONFLUENCE_WINDOW_MS;
  return list.some(
    s => s.ruleId === 'tape-speed' &&
      s.direction === direction &&
      s.ts >= cutoff
  );
}

// Called by absorption to check if large-print confirmed same direction
export function checkLargePrintConfirmed(
  symbol: string,
  direction: 'long' | 'short',
  nowMs: number
): boolean {
  const key = storeKey(symbol);
  const list = _store.get(key) ?? [];
  const cutoff = nowMs - CONFLUENCE_WINDOW_MS;
  return list.some(
    s => s.ruleId === 'large-print' &&
      s.direction === direction &&
      s.ts >= cutoff
  );
}

// Get all recent confirming rules for a symbol+direction
export function getConfluenceRules(
  symbol: string,
  direction: 'long' | 'short',
  nowMs: number
): string[] {
  const key = storeKey(symbol);
  const list = _store.get(key) ?? [];
  const cutoff = nowMs - CONFLUENCE_WINDOW_MS;
  return [...new Set(
    list
      .filter(s => s.direction === direction && s.ts >= cutoff && s.ruleId !== 'absorption')
      .map(s => s.ruleId)
  )];
}
