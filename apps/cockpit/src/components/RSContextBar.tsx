import { useEffect, useState } from 'react';

interface RSContext {
  greaterMarket: 'bull' | 'bear' | 'neutral';
  ddRatio: number;
  lmCode?: string;
  mhpResilience: number;
  hpResilience: number;
  redistResilience: number;
  resilience: number;
  vx: number;
  bbb: number;
  vvix: number;
  spy?: number;               // SPY ETF live price (Yahoo) — green if > spyMhp
  qqq?: number;               // QQQ ETF live price (Yahoo) — green if > qqqMhp
  spyMhp?: number;            // SP500 MHP threshold (greater-market leg for ES)
  qqqMhp?: number;            // NQ100 MHP threshold (greater-market leg for NQ)
  qqqSpyRs?: number;          // QQQ %chg − SPY %chg (pct pts): >0 = Nasdaq leading (risk-on)
  vxVolState?: 'pinned' | 'above-mhp' | 'above-hp';  // VX (UVXY) vs gamma HP/MHP — vol inflection
  vxAboveBBB: boolean;
  vvixElevated: boolean;
  vvixGolden: boolean;
  isRational: boolean;
  setAt: string;
  vxn?: number;               // Nasdaq vol index — input to the expected-move band
  expectedRangePts?: number;  // ±1σ band width in points (high − low)
  em1Low?: number;            // expected-move ±1σ band low (price)
  em1High?: number;           // expected-move ±1σ band high (price)
}

function resLabel(v: number): string {
  if (v === 0) return '0';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v % 1 === 0 ? v : v.toFixed(1)}`;
}

function resColor(v: number): string {
  return v > 0 ? 'var(--long)' : v < 0 ? 'var(--short)' : 'var(--text-2)';
}

const POLL_MS = 30_000;

interface Props {
  /** Symbol to fetch per-symbol resilience for (NQ / ES). Omit for global defaults. */
  symbol?: string;
}

export function RSContextBar({ symbol }: Props = {}) {
  const [ctx, setCtx] = useState<RSContext | null>(null);

  useEffect(() => {
    const url = symbol ? `/context/rs?symbol=${encodeURIComponent(symbol)}` : '/context/rs';
    const fetch_ = () =>
      fetch(url)
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data) setCtx(data as RSContext); })
        .catch(() => {});

    fetch_();
    const id = setInterval(fetch_, POLL_MS);
    return () => clearInterval(id);
  }, [symbol]);

  if (!ctx) return null;

  const gmColor = ctx.greaterMarket === 'bull' ? 'var(--long)'
               : ctx.greaterMarket === 'bear' ? 'var(--short)'
               : 'var(--text-2)';

  const vxColor  = ctx.vxAboveBBB   ? 'var(--short)' : 'var(--long)';  // >BBB=stress(red), <BBB=calm(green)
  const vvixColor = ctx.vvixElevated ? 'var(--short)'
                  : ctx.vvixGolden  ? 'var(--long)'
                  : 'var(--text-1)';
  // ETF vs its MHP = the greater-market "index > MHP" leg (green=above/bullish).
  const etfColor = (price?: number, mhp?: number) =>
    price != null && mhp != null ? (price > mhp ? 'var(--long)' : 'var(--short)') : 'var(--text-1)';

  const chip = (label: string, value: string, color: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
      <span style={{ color: 'var(--text-1)', fontSize: 12, fontWeight: 700, letterSpacing: 0.5 }}>{label}</span>
      <span style={{ color, fontSize: 14, fontWeight: 700 }}>{value}</span>
    </span>
  );

  return (
    <div className="mono" style={{
      display: 'flex', alignItems: 'center', gap: 12,
      flexWrap: 'nowrap', whiteSpace: 'nowrap',
    }}>
      {chip('GM', ctx.greaterMarket.toUpperCase(), gmColor)}
      {ctx.lmCode && (
        <>
          <span style={{ color: 'var(--text-2)', fontSize: 12 }}>|</span>
          {chip('LM', ctx.lmCode, ctx.lmCode.startsWith('Br') ? 'var(--short)' : 'var(--long)')}
        </>
      )}
      <span style={{ color: 'var(--text-2)', fontSize: 12 }}>|</span>
      {chip('VX', ctx.vx.toFixed(2), vxColor)}
      {chip('BBB', ctx.bbb.toFixed(2), 'var(--text-1)')}
      <span style={{ color: 'var(--text-2)', fontSize: 12 }}>|</span>
      {chip('VVIX', ctx.vvix.toFixed(2), vvixColor)}
      {ctx.vxVolState && chip(
        'VXγ',
        ctx.vxVolState === 'above-mhp' ? '>MHP' : ctx.vxVolState === 'above-hp' ? '>HP' : '<MHP',
        ctx.vxVolState === 'above-mhp' ? 'var(--short)' : ctx.vxVolState === 'above-hp' ? '#f2a633' : 'var(--long)',
      )}
      <span style={{ color: 'var(--text-2)', fontSize: 12 }}>|</span>
      {chip('DD', ctx.ddRatio.toFixed(2), ctx.ddRatio > 0.5 ? 'var(--long)' : ctx.ddRatio < 0.5 ? 'var(--short)' : 'var(--text-1)')}
      {ctx.spy != null && (
        <>
          <span style={{ color: 'var(--text-2)', fontSize: 12 }}>|</span>
          {chip('SPY', ctx.spy.toFixed(2), etfColor(ctx.spy, ctx.spyMhp))}
        </>
      )}
      {ctx.qqq != null && chip('QQQ', ctx.qqq.toFixed(2), etfColor(ctx.qqq, ctx.qqqMhp))}
      {ctx.qqqSpyRs != null && chip(
        'Q/S',
        `${ctx.qqqSpyRs >= 0 ? '+' : ''}${ctx.qqqSpyRs.toFixed(2)}%`,
        ctx.qqqSpyRs > 0 ? 'var(--long)' : ctx.qqqSpyRs < 0 ? 'var(--short)' : 'var(--text-1)',
      )}
      <span style={{ color: 'var(--text-2)', fontSize: 12 }}>|</span>
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ color: 'var(--text-1)', fontSize: 12, fontWeight: 700, letterSpacing: 0.5 }}>MHP</span>
        <span style={{ color: resColor(ctx.mhpResilience), fontSize: 14, fontWeight: 700 }}>{resLabel(ctx.mhpResilience)}</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ color: 'var(--text-1)', fontSize: 12, fontWeight: 700, letterSpacing: 0.5 }}>HP</span>
        <span style={{ color: resColor(ctx.hpResilience), fontSize: 14, fontWeight: 700 }}>{resLabel(ctx.hpResilience)}</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ color: 'var(--text-1)', fontSize: 12, fontWeight: 700, letterSpacing: 0.5 }}>RES</span>
        <span style={{ color: resColor(ctx.resilience), fontSize: 14, fontWeight: 700 }}>{resLabel(ctx.resilience)}</span>
      </span>
      {ctx.expectedRangePts != null && (
        <>
          <span style={{ color: 'var(--text-2)', fontSize: 12 }}>|</span>
          {chip('RANGE', ctx.em1Low != null && ctx.em1High != null
            ? `${Math.round(ctx.expectedRangePts)}pt · ${Math.round(ctx.em1Low)}–${Math.round(ctx.em1High)}`
            : `${Math.round(ctx.expectedRangePts)}pt`, 'var(--text-1)')}
        </>
      )}
    </div>
  );
}
