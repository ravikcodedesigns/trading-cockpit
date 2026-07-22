import type { TapeEvent } from '@trading/contracts';

// ── LIVE TAPE READ ────────────────────────────────────────────────────────────
// Collapses the marker storm into ONE glanceable state so you don't have to decode
// dozens of opposite-firing markers in real time. The rule (from the 2026-07-22
// trading-plan discussion):
//   • individual markers are events, not signals — in chop they cancel;
//   • the read lives in the RESOLUTION of a fight at an edge, not in each flare;
//   • passive defence (iceberg / wall / absorption) outranks exhaustion (stop-run /
//     trapped), which outranks bare aggression (sweeps/blocks never drive the tag);
//   • stop-runs ACCEPTED in BOTH directions inside the window = two-sided harvest =
//     nobody in charge = ROTATION (stand aside).
// Pure + deterministic: same events + clock → same read. All knobs live in REGIME_CFG.

export interface RegimeCfg {
  windowSec: number;    // lookback for the two-sided-harvest scan
  freshSec: number;     // a resolution older than this no longer drives the current read
  contestSec: number;   // opposite top-tier resolutions this close together = contested → ROTATION
  minIcebergCt: number; // ignore trivially small iceberg resolutions
}

export const REGIME_CFG: RegimeCfg = {
  windowSec: 300,
  freshSec: 120,
  contestSec: 60,
  minIcebergCt: 15,
};

export type RegimeKind = 'ROTATION' | 'EDGE_HELD' | 'EDGE_BROKE';

export interface RegimeRead {
  regime: RegimeKind;
  dir: 1 | 0 | -1;      // +1 bullish lean · -1 bearish lean · 0 none (rotation)
  action: string;       // the one-liner: "lean long" / "stand aside" / …
  detail: string;       // source + price, e.g. "bid iceberg held 29299"
  ageSec: number | null;// seconds since the driving resolution (null for pure rotation)
}

// tier: passive defence beats exhaustion; bare aggression never qualifies as a driver.
const DEFENCE = new Set<string>(['iceberg', 'wall', 'absorption']);
const EXHAUST = new Set<string>(['stoprun', 'trapped']);

interface Resolution { lean: 1 | -1; tier: 2 | 1; hold: boolean; t: number; price: number; label: string; }

// Map a single event to a directional resolution (or null if it isn't a decision point).
// lean: +1 bullish / -1 bearish.  hold: true = level defended (fade toward it) / false = level gave way (go with break).
function toResolution(e: TapeEvent, minIce: number): Resolution | null {
  const s = e.state;
  const bid = e.side === 'buy';   // for defence kinds, side = the DEFENDER
  switch (e.kind) {
    case 'iceberg': {
      if (e.size < minIce) return null;
      if (s === 'held') return { lean: bid ? 1 : -1, tier: 2, hold: true,  t: e.t, price: e.price, label: `${bid ? 'bid' : 'ask'} iceberg held` };
      if (s === 'broke') return { lean: bid ? -1 : 1, tier: 2, hold: false, t: e.t, price: e.price, label: `${bid ? 'bid' : 'ask'} iceberg broke` };
      return null;  // 'active' = still contested, not yet a read
    }
    case 'wall': {
      if (s === 'hold')  return { lean: bid ? 1 : -1, tier: 2, hold: true,  t: e.t, price: e.price, label: `${bid ? 'bid' : 'ask'} wall held` };
      // break emits side = the WINNER who ran it over: buy → up, sell → down
      if (s === 'break') return { lean: bid ? 1 : -1, tier: 2, hold: false, t: e.t, price: e.price, label: `${bid ? 'ask' : 'bid'} wall broke` };
      return null;   // active / pulled → no directional read
    }
    case 'absorption':
      // a held pin: defender side = lean; treat as a hold
      return { lean: bid ? 1 : -1, tier: 2, hold: true, t: e.t, price: e.price, label: `${bid ? 'buyers' : 'sellers'} absorbing` };
    case 'stoprun': {
      // side = run direction (buy = up-run through resistance / sell = down-run through support)
      if (s === 'accepted')  return { lean: bid ? 1 : -1, tier: 1, hold: false, t: e.t, price: e.price, label: `stop-run ${bid ? 'up' : 'down'} accepted` };
      if (s === 'reclaimed') return { lean: bid ? -1 : 1, tier: 1, hold: true,  t: e.t, price: e.price, label: `stop-run ${bid ? 'up' : 'down'} reclaimed` };  // spring against the run
      return null;
    }
    case 'trapped': {
      // side = the direction the trapped cohort PUKES (continuation); flushed = it fired
      if (s === 'flushed') return { lean: bid ? 1 : -1, tier: 1, hold: false, t: e.t, price: e.price, label: `trapped ${bid ? 'shorts' : 'longs'} flushed` };
      return null;   // active / recovered → no read
    }
    default:
      return null;   // sweep / block / stacked / unfinished / spoof never DRIVE the tag
  }
}

const ROTATION = (action: string, detail: string): RegimeRead => ({ regime: 'ROTATION', dir: 0, action, detail, ageSec: null });

/** Classify the current live tape read from the recent event stream. */
export function classifyRegime(events: TapeEvent[], nowSec: number, cfg: RegimeCfg = REGIME_CFG): RegimeRead {
  const wFrom = nowSec - cfg.windowSec;

  // two-sided stop harvest — accepted runs BOTH ways inside the window
  let accBuy = false, accSell = false;
  for (const e of events) {
    if (e.t < wFrom) continue;
    if (e.kind === 'stoprun' && e.state === 'accepted') { if (e.side === 'buy') accBuy = true; else accSell = true; }
  }
  const twoSidedHarvest = accBuy && accSell;

  // fresh directional resolutions
  const fFrom = nowSec - cfg.freshSec;
  const res: Resolution[] = [];
  for (const e of events) {
    if (e.t < fFrom || e.t > nowSec + 1) continue;
    const r = toResolution(e, cfg.minIcebergCt);
    if (r) res.push(r);
  }

  if (res.length) {
    const topTier = Math.max(...res.map((r) => r.tier)) as 2 | 1;
    const tierRes = res.filter((r) => r.tier === topTier).sort((a, b) => b.t - a.t);
    const freshest = tierRes[0]!;
    // contested: an opposite-lean resolution of the same tier landed within contestSec → nobody won
    const contested = tierRes.some((r) => r !== freshest && r.lean !== freshest.lean && (freshest.t - r.t) <= cfg.contestSec);
    if (contested) return ROTATION('stand aside', 'edge contested both ways');
    // exhaustion-only read gets vetoed by a two-sided harvest (the run got harvested back)
    if (twoSidedHarvest && topTier < 2) return ROTATION('stand aside', 'stops run both ways');

    const dir = freshest.lean;
    const px = freshest.price.toFixed(2);
    if (freshest.hold) {
      return { regime: 'EDGE_HELD', dir, action: dir > 0 ? 'lean long' : 'lean short', detail: `${freshest.label} ${px}`, ageSec: Math.max(0, Math.round(nowSec - freshest.t)) };
    }
    return { regime: 'EDGE_BROKE', dir, action: dir > 0 ? 'momentum up' : 'momentum down', detail: `${freshest.label} ${px}`, ageSec: Math.max(0, Math.round(nowSec - freshest.t)) };
  }

  if (twoSidedHarvest) return ROTATION('stand aside', 'stops run both ways');
  return ROTATION('stand aside', 'no clean edge');
}
