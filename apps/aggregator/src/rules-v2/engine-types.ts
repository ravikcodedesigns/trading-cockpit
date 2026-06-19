// RS level auto-trader — engine types. See RS_ENGINE_SPEC.md (§1 stack, §3 schemas).
import type { GreaterMarket } from '../rs-context.js';

export type SizeTier = 'N' | 'M' | 'S' | '0';   // 0 = no-position leg (LM-Summary only; EST never 0)
export type Dir = 'long' | 'short';
export type GateMode = 'normal' | 'strong-pivots-small' | 'sit-out';
export type BreakState = 'red' | 'yellow' | 'green' | null;  // active / caution / none
export type SetupFamily = 'EST' | 'LM' | 'ZONE' | 'DDBAND' | 'RDZ' | 'BZ';
export type BounceVsBreak = 'bounce' | 'break' | 'reclaim' | 'hold-through';

/** Layer-0 global sit-out gate, derived from the platform's irrational/unusual panel + vol. */
export interface Gate {
  mode: GateMode;
  longOnly: boolean;   // irrational DD-band break → long-only
  sizeDown: boolean;   // MHP-break-up / VX>BBB / lit-fuse → trade smaller
  reasons: string[];
  // normalized per-index break states (S&P > NASDAQ > Russell priority applied by callers)
  ddBandBreak: Partial<Record<'NQ' | 'ES' | 'RTY', { state: BreakState; dir: 'up' | 'down' | null }>>;
  mhpBreak: Partial<Record<'NQ' | 'ES' | 'RTY' | 'VX', { state: BreakState; dir: 'up' | 'down' | null }>>;
  unusual: { indexDivergence: BreakState; uvxyBullZoneBottom: BreakState };
  // PARKED runtime hooks (causal, not predictable): set externally when implemented.
  catalystActiveDown?: boolean;
  vxRiUp?: boolean;
  circuitBreakerNear?: boolean;
}

/** The unified market state the setup engine evaluates against (one symbol, one tick). */
export interface MarketState {
  symbol: 'NQ' | 'ES';
  tsET: string;
  price?: number;
  open?: number;        // 9:30 ET open (black diamond)
  prevClose?: number;
  halfGap?: number;
  levels: {
    bzb: number[];      // bull-zone bottoms (EST long)
    brzt: number[];     // bear-zone tops (EST long/short)
    hp?: number;
    mhp?: number;
    dynHp?: number;     // overnight estimate (Phase 1: from DYN_HP)
    dynMhp?: number;
    onHp?: number;      // manual, pre-session (Discord)
    onMhp?: number;
    ddUpper?: number;
    ddLower?: number;
  };
  lmCode?: string;
  confluence: {
    gm: GreaterMarket;
    ddRatio: number;       // >0.5 bull
    resWhite: number;      // redistribution/half-gap resilience (sign = dir)
    resBlue: number;       // weekly-HP resilience
    resOrange: number;     // MHP resilience
    mmBullish?: boolean;
    vx: number; bbb: number; vvix: number;
    vxAboveBBB: boolean; vvixElevated: boolean; isRational: boolean;
  };
  gate: Gate;
}

/** A candidate setup the engine emits for shadow-logging / (later) execution. */
export interface Setup {
  family: SetupFamily;
  pivot: string;          // 'MHP' | 'BZB' | 'BrZT' | 'LP' | 'IP' | 'DD-lower' …
  level: number;
  direction: Dir;
  sizeTier: SizeTier;
  entry: number;
  stop: number;
  targets: number[];
  bounceVsBreak: BounceVsBreak;
  baseProb: number;       // framework-stated; ⚠️ verify-live
  confluenceNote: string;
}

export interface Decision {
  symbol: 'NQ' | 'ES';
  tsET: string;
  gate: GateMode;
  setups: Setup[];
}
