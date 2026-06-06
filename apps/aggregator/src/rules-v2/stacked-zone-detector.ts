// stacked-zone-detector.ts — L2 passive wall lifecycle detector.
//
// MECHANIC: a "wall" is a displayed-depth level with size >= MIN_WALL_SIZE
// (default 30 contracts on NQ). We track its lifecycle through 4 states:
//
//   forming    — wall just appeared; not yet confirmed as institutional defense
//   persistent — wall has held above MIN_WALL_SIZE for >= MIN_PERSIST_MS
//   eroding    — size dropped below MIN_WALL_SIZE/2 (defense weakening)
//   broken     — size went to 0 (level removed)
//
// EVENTS EMITTED on state transitions:
//
//   WALL_FORMED   — forming → persistent. Institutional defense confirmed.
//   WALL_ERODING  — persistent → eroding. Defense weakening; price likely to break.
//   WALL_BROKEN   — persistent → broken. Defense fully failed; aggressive flow won.
//   WALL_HELD     — persistent stayed persistent for MIN_HOLD_MS more. Strong defense.
//   WALL_RECOVERED — eroding → persistent. Defense restored after dip.
//
// L2 LIMITATION (acknowledged): we cannot distinguish "wall eaten by trades"
// (institutional flow broke through) from "wall pulled by cancel" (no real
// defense). Both look identical here as a size decrease. This is fine for
// detection; trading interpretation will need L3 (MBO) for the cleanest read.
//
// PRICING: all prices in depth events are in DOLLARS (e.g., 30547.50 for NQ).
// Tick size for NQ is 0.25; for ES is 0.25; for MNQ/MES it's also 0.25.

// DepthEvent inlined to avoid cross-rootDir import
export interface DepthEvent {
  id: number;
  ts: number;
  symbol: string;
  side: 0 | 1;
  price: number;
  size: number;
}

export type WallEventType =
  | 'WALL_FORMED'
  | 'WALL_ERODING'
  | 'WALL_BROKEN'
  | 'WALL_HELD'
  | 'WALL_RECOVERED';

export type WallLifecycle = 'forming' | 'persistent' | 'eroding' | 'broken' | 'expired';

export interface WallEvent {
  type: WallEventType;
  ts: number;
  symbol: string;
  side: 0 | 1;            // 0 = bid (support), 1 = ask (resistance)
  price: number;
  // Wall context at event time
  currentSize: number;
  peakSize: number;
  firstSeenTs: number;
  ageMs: number;             // ts - firstSeenTs
  numUpdates: number;        // count of depth events seen at this level
  // Persistent-specific
  persistentSinceTs?: number;   // when wall entered persistent state
  persistentDurationMs?: number; // for WALL_BROKEN/WALL_ERODING/WALL_HELD: how long it was persistent
}

interface LevelState {
  symbol: string;
  side: 0 | 1;
  price: number;
  firstSeenTs: number;
  lastUpdateTs: number;
  currentSize: number;
  peakSize: number;
  numUpdates: number;
  lifecycle: WallLifecycle;
  persistentSinceTs?: number;
  lastHoldEmitTs?: number;       // throttle WALL_HELD emissions
}

export interface StackedZoneOpts {
  /** Wall threshold (contracts). Default 30 (~99.5th percentile on NQ overnight). */
  minWallSize?: number;
  /** Wall must hold above threshold for this long to become "persistent". Default 10s. */
  minPersistMs?: number;
  /** Size below this fraction of minWallSize signals erosion. Default 0.5. */
  erodeFraction?: number;
  /** Emit WALL_HELD every this many ms while persistent. Default 30_000 (30s). */
  holdEmitIntervalMs?: number;
  /** Forget levels with no activity for this long. Default 120_000 (2 min). */
  levelTtlMs?: number;
  /** Periodically evict stale levels when map size exceeds this. Default 50_000. */
  maxLevels?: number;
  onWallEvent: (e: WallEvent) => void;
}

export class StackedZoneDetector {
  private opts: Required<Omit<StackedZoneOpts, 'onWallEvent'>> & { onWallEvent: StackedZoneOpts['onWallEvent'] };
  private levels = new Map<string, LevelState>();

  constructor(opts: StackedZoneOpts) {
    this.opts = {
      minWallSize:          opts.minWallSize          ?? 30,
      minPersistMs:         opts.minPersistMs         ?? 10_000,
      erodeFraction:        opts.erodeFraction        ?? 0.5,
      holdEmitIntervalMs:   opts.holdEmitIntervalMs   ?? 30_000,
      levelTtlMs:           opts.levelTtlMs           ?? 120_000,
      maxLevels:            opts.maxLevels            ?? 50_000,
      onWallEvent:          opts.onWallEvent,
    };
  }

  ingest(event: DepthEvent): void {
    const key = `${event.symbol}|${event.side}|${event.price}`;
    const state = this.levels.get(key);
    const erodeThreshold = this.opts.minWallSize * this.opts.erodeFraction;

    // Case 1: level removed (size=0)
    if (event.size === 0) {
      if (state) {
        if (state.lifecycle === 'persistent' || state.lifecycle === 'eroding') {
          this.emitEvent('WALL_BROKEN', state, event.ts);
        }
        this.levels.delete(key);
      }
      return;
    }

    // Case 2: existing level
    if (state) {
      state.currentSize = event.size;
      state.lastUpdateTs = event.ts;
      state.numUpdates++;
      if (event.size > state.peakSize) state.peakSize = event.size;

      switch (state.lifecycle) {
        case 'forming': {
          // Did we hit the persistence threshold?
          if (event.size >= this.opts.minWallSize &&
              event.ts - state.firstSeenTs >= this.opts.minPersistMs) {
            state.lifecycle = 'persistent';
            state.persistentSinceTs = event.ts;
            state.lastHoldEmitTs = event.ts;
            this.emitEvent('WALL_FORMED', state, event.ts);
          } else if (event.size < this.opts.minWallSize / 2) {
            // Wall faded before becoming persistent — leave as forming, will TTL-out
          }
          break;
        }
        case 'persistent': {
          if (event.size <= erodeThreshold) {
            state.lifecycle = 'eroding';
            this.emitEvent('WALL_ERODING', state, event.ts);
          } else {
            // Still persistent — emit periodic WALL_HELD throttled by interval
            const lastHold = state.lastHoldEmitTs ?? state.persistentSinceTs ?? state.firstSeenTs;
            if (event.ts - lastHold >= this.opts.holdEmitIntervalMs) {
              state.lastHoldEmitTs = event.ts;
              this.emitEvent('WALL_HELD', state, event.ts);
            }
          }
          break;
        }
        case 'eroding': {
          if (event.size >= this.opts.minWallSize) {
            state.lifecycle = 'persistent';
            state.lastHoldEmitTs = event.ts;
            this.emitEvent('WALL_RECOVERED', state, event.ts);
          }
          break;
        }
        case 'broken':
        case 'expired':
          // Should not happen — state would have been deleted
          break;
      }
      return;
    }

    // Case 3: new level — only track if it appears at-or-above the wall threshold
    if (event.size >= this.opts.minWallSize) {
      this.levels.set(key, {
        symbol: event.symbol,
        side: event.side,
        price: event.price,
        firstSeenTs: event.ts,
        lastUpdateTs: event.ts,
        currentSize: event.size,
        peakSize: event.size,
        numUpdates: 1,
        lifecycle: 'forming',
      });
    }

    // Opportunistic eviction
    if (this.levels.size > this.opts.maxLevels) {
      this.evictStale(event.ts);
    }
  }

  /** Remove levels that haven't updated within TTL. Useful at end of stream or periodically. */
  evictStale(nowTs: number): number {
    let removed = 0;
    for (const [key, state] of this.levels) {
      if (nowTs - state.lastUpdateTs > this.opts.levelTtlMs) {
        this.levels.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Snapshot for diagnostics. */
  snapshot(): { totalTracked: number; byLifecycle: Record<WallLifecycle, number> } {
    const byLifecycle: Record<WallLifecycle, number> = {
      forming: 0, persistent: 0, eroding: 0, broken: 0, expired: 0,
    };
    for (const s of this.levels.values()) byLifecycle[s.lifecycle]++;
    return { totalTracked: this.levels.size, byLifecycle };
  }

  private emitEvent(type: WallEventType, state: LevelState, ts: number): void {
    const event: WallEvent = {
      type, ts,
      symbol: state.symbol, side: state.side, price: state.price,
      currentSize: state.currentSize,
      peakSize: state.peakSize,
      firstSeenTs: state.firstSeenTs,
      ageMs: ts - state.firstSeenTs,
      numUpdates: state.numUpdates,
      persistentSinceTs: state.persistentSinceTs,
      persistentDurationMs: state.persistentSinceTs ? ts - state.persistentSinceTs : undefined,
    };
    this.opts.onWallEvent(event);
  }
}
