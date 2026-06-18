// deriveMarketState — assembles the unified MarketState (engine-types.ts) from the
// current passive sources (rs-context + daily_levels) + a live price. Pure & testable.
//
// Phase-1 scaffolding: the MASTER_TABLE backbone is swapped in after live RTH
// validation (RS_ENGINE_SPEC §7/§8). For now levels come from daily_levels and
// confluence/gate from rs-context. dynHp/dynMhp (window.DYN_HP) land in a later step.
import type { RSContext, IrrationalRule } from '../rs-context.js';
import type { DailyLevels } from '@trading/contracts';
import type { Gate, MarketState } from './engine-types.js';

const uniqSort = (xs: number[]): number[] =>
  Array.from(new Set(xs.filter((x): x is number => x != null && Number.isFinite(x)))).sort((a, b) => a - b);

// Map a panel row name → its index. /EP & SPY = ES (S&P); /ENQ & QQQ = NQ; /RTY & IWM = RTY; UVXY = VX.
function indexOfName(name: string): 'NQ' | 'ES' | 'RTY' | 'VX' | null {
  if (/\/EP\b|SPY/i.test(name)) return 'ES';
  if (/\/ENQ\b|QQQ/i.test(name)) return 'NQ';
  if (/\/RTY\b|IWM/i.test(name)) return 'RTY';
  if (/UVXY/i.test(name)) return 'VX';
  return null;
}

/**
 * Derive the Layer-0 sit-out gate from the platform's irrational/unusual panel + vol env.
 * Encodes the 5 action rules (RS_ENGINE_SPEC §2b); break-STATE detection is read, not computed.
 * Catalyst-active-down / VX-RI-up / circuit-breaker are PARKED (causal) — runtime hooks only.
 */
export function deriveGate(_symbol: 'NQ' | 'ES', rs: RSContext): Gate {
  const rows: IrrationalRule[] = rs.irrational ?? [];
  const ddBandBreak: Gate['ddBandBreak'] = {};
  const mhpBreak: Gate['mhpBreak'] = {};
  const unusual: Gate['unusual'] = { indexDivergence: null, uvxyBullZoneBottom: null };

  for (const r of rows) {
    const idx = indexOfName(r.name);
    if (/DD-Band Break/i.test(r.name) && idx && idx !== 'VX') ddBandBreak[idx] = { state: r.state, dir: r.dir };
    else if (/MHP Break/i.test(r.name) && idx) mhpBreak[idx] = { state: r.state, dir: r.dir };
    else if (/Index Divergence/i.test(r.name)) unusual.indexDivergence = r.state;
    else if (/UVXY Bull Zone Bottom/i.test(r.name)) unusual.uvxyBullZoneBottom = r.state;
  }

  const reasons: string[] = [];
  let mode: Gate['mode'] = 'normal';
  let longOnly = false;
  let sizeDown = false;
  const rank: Record<Gate['mode'], number> = { normal: 0, 'strong-pivots-small': 1, 'sit-out': 2 };
  const escalate = (m: Gate['mode']) => { if (rank[m] > rank[mode]) mode = m; };

  // Priority: S&P > NASDAQ > Russell — an S&P break implies the others may follow.
  const order: Array<'ES' | 'NQ' | 'RTY'> = ['ES', 'NQ', 'RTY'];

  // Rule 1 — DD-band break (active) → S, long-only, strong-pivots-only.
  for (const ix of order) {
    if (ddBandBreak[ix]?.state === 'red') {
      escalate('strong-pivots-small'); longOnly = true;
      reasons.push(`${ix} DD-Band break ${ddBandBreak[ix]!.dir ?? ''}`.trim());
    }
  }
  // Rule 2 — index MHP break DOWN → S, strong-pivots-only (incl. MHP itself on the reverse).
  // (MHP break UP is bullish per the framework — chase it, no penalty.)
  for (const ix of order) {
    const b = mhpBreak[ix];
    if (b?.state === 'red' && b.dir === 'down') { escalate('strong-pivots-small'); reasons.push(`${ix} MHP break down`); }
  }
  // Rule 3 — UVXY MHP break UP → trade smaller (vol increasing). (UVXY down = vol calming, no penalty.)
  if (mhpBreak.VX?.state === 'red' && mhpBreak.VX.dir === 'up') { sizeDown = true; reasons.push('UVXY MHP break up (vol up)'); }
  // Unusual — UVXY bull-zone-bottom = "lit fuse" → trim/size down.
  if (unusual.uvxyBullZoneBottom === 'red') { sizeDown = true; reasons.push('UVXY bull-zone-bottom (lit fuse)'); }

  // Volatility sit-out — VX>BBB AND VVIX>100 → sit out; VX>BBB alone → spread/size down.
  if (rs.vxAboveBBB && rs.vvixElevated) { escalate('sit-out'); reasons.push('VX>BBB & VVIX>100'); }
  else if (rs.vxAboveBBB) { sizeDown = true; reasons.push('VX>BBB (spread entries)'); }

  // PARKED (causal, not predictable): catalyst-active-down, VX up 1 RI, circuit-breaker proximity.
  return { mode, longOnly, sizeDown, reasons, ddBandBreak, mhpBreak, unusual };
}

export interface DeriveInput {
  symbol: 'NQ' | 'ES';
  rs: RSContext;          // getContext(symbol)
  levels?: DailyLevels;   // today's levels for this symbol
  price?: number;         // live futures price
  open?: number;          // 9:30 ET futures open (else levels.openPrice)
  tsET?: string;
}

const findLevel = (levels: DailyLevels | undefined, label: RegExp): number | undefined =>
  levels?.additionalLevels?.find(a => label.test(a.label))?.price;

export function deriveMarketState(input: DeriveInput): MarketState {
  const { symbol, rs, levels, price } = input;
  const open = input.open ?? levels?.openPrice;
  const tsET = input.tsET ?? new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });

  // Dynamic/overnight HP/MHP are stored ETF-scale (window.DYN_HP). Convert to futures via
  // ratio = live futures price / live ETF (qqq for NQ, spy for ES); fall back to the ETF close.
  const sc = rs.bySymbol?.[symbol];
  const etfRef = (symbol === 'NQ' ? rs.qqq : rs.spy) ?? sc?.dynCloseEtf;
  const ratio = (price != null && etfRef) ? price / etfRef : undefined;
  const toFut = (etf?: number): number | undefined =>
    (ratio != null && etf != null) ? +(etf * ratio).toFixed(2) : undefined;

  const bzb = uniqSort([
    ...(levels?.bullZone ? [levels.bullZone.low] : []),
    ...(levels?.zones?.bull ?? []).map(z => z.low),
  ]);
  const brzt = uniqSort([
    ...(levels?.bearZone ? [levels.bearZone.high] : []),
    ...(levels?.zones?.bear ?? []).map(z => z.high),
  ]);

  return {
    symbol, tsET, price, open,
    prevClose: findLevel(levels, /^(NQ|ES) Close$/i),
    halfGap: findLevel(levels, /^HG$|half.?gap/i),
    levels: {
      bzb, brzt,
      hp: levels?.hedgePressure,
      mhp: levels?.mhp,
      dynHp: toFut(sc?.dynHpEtf),
      dynMhp: toFut(sc?.dynMhpEtf),
      onHp: findLevel(levels, /^ON HP$/i),
      onMhp: findLevel(levels, /^ON MHP$/i),
      ddUpper: levels?.ddBands?.upper,
      ddLower: levels?.ddBands?.lower,
    },
    lmCode: rs.lmCode ?? levels?.lmCode,
    confluence: {
      gm: rs.greaterMarket,
      ddRatio: rs.ddRatio,
      resWhite: rs.redistResilience,
      resBlue: rs.hpResilience,
      resOrange: rs.mhpResilience,
      mmBullish: rs.bySymbol?.[symbol]?.mmBullish,
      vx: rs.vx, bbb: rs.bbb, vvix: rs.vvix,
      vxAboveBBB: rs.vxAboveBBB, vvixElevated: rs.vvixElevated, isRational: rs.isRational,
    },
    gate: deriveGate(symbol, rs),
  };
}
