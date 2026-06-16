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
  vxAboveBBB: boolean;
  vvixElevated: boolean;
  vvixGolden: boolean;
  isRational: boolean;
  setAt: string;
  vxn?: number;               // Nasdaq vol index (prior close) — input to the range forecast
  expectedRangePts?: number;  // forecast next-day NQ High-Low in points (VXN->range, R^2 0.40)
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

  const vxColor  = ctx.vxAboveBBB   ? 'var(--short)' : 'var(--text-1)';
  const vvixColor = ctx.vvixElevated ? 'var(--short)'
                  : ctx.vvixGolden  ? 'var(--long)'
                  : 'var(--text-1)';

  const chip = (label: string, value: string, color: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
      <span style={{ color: 'var(--text-1)', fontSize: 13, fontWeight: 700, letterSpacing: 0.5 }}>{label}</span>
      <span style={{ color, fontSize: 15, fontWeight: 700 }}>{value}</span>
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
          <span style={{ color: 'var(--text-2)', fontSize: 13 }}>|</span>
          {chip('LM', ctx.lmCode, ctx.lmCode.startsWith('Br') ? 'var(--short)' : 'var(--long)')}
        </>
      )}
      <span style={{ color: 'var(--text-2)', fontSize: 13 }}>|</span>
      {chip('VX', ctx.vx.toFixed(2), vxColor)}
      {chip('BBB', ctx.bbb.toFixed(2), 'var(--text-1)')}
      <span style={{ color: 'var(--text-2)', fontSize: 13 }}>|</span>
      {chip('VVIX', ctx.vvix.toFixed(0), vvixColor)}
      <span style={{ color: 'var(--text-2)', fontSize: 13 }}>|</span>
      {chip('DD', ctx.ddRatio.toFixed(2), ctx.ddRatio > 0.5 ? 'var(--long)' : ctx.ddRatio < 0.5 ? 'var(--short)' : 'var(--text-1)')}
      <span style={{ color: 'var(--text-2)', fontSize: 13 }}>|</span>
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ color: 'var(--text-1)', fontSize: 13, fontWeight: 700, letterSpacing: 0.5 }}>MHP</span>
        <span style={{ color: resColor(ctx.mhpResilience), fontSize: 15, fontWeight: 700 }}>{resLabel(ctx.mhpResilience)}</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ color: 'var(--text-1)', fontSize: 13, fontWeight: 700, letterSpacing: 0.5 }}>HP</span>
        <span style={{ color: resColor(ctx.hpResilience), fontSize: 15, fontWeight: 700 }}>{resLabel(ctx.hpResilience)}</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ color: 'var(--text-1)', fontSize: 13, fontWeight: 700, letterSpacing: 0.5 }}>RES</span>
        <span style={{ color: resColor(ctx.resilience), fontSize: 15, fontWeight: 700 }}>{resLabel(ctx.resilience)}</span>
      </span>
      {ctx.expectedRangePts != null && (
        <>
          <span style={{ color: 'var(--text-2)', fontSize: 13 }}>|</span>
          {chip('PRICE RANGE', `${Math.round(ctx.expectedRangePts)}pt`, 'var(--text-1)')}
        </>
      )}
    </div>
  );
}
