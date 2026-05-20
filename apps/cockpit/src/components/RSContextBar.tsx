import { useEffect, useState } from 'react';

interface RSContext {
  greaterMarket: 'bull' | 'bear' | 'neutral';
  ddRatio: number;
  mhpResilience: -1 | 0 | 1;
  hpResilience: -1 | 0 | 1;
  redistResilience: -1 | 0 | 1;
  vx: number;
  bbb: number;
  vvix: number;
  vxAboveBBB: boolean;
  vvixElevated: boolean;
  vvixGolden: boolean;
  isRational: boolean;
  setAt: string;
}

function resLabel(v: -1 | 0 | 1): string {
  return v === 1 ? '+1' : v === -1 ? '-1' : '0';
}

function resColor(v: -1 | 0 | 1): string {
  return v === 1 ? 'var(--long)' : v === -1 ? 'var(--short)' : 'var(--text-2)';
}

const POLL_MS = 30_000;

export function RSContextBar() {
  const [ctx, setCtx] = useState<RSContext | null>(null);

  useEffect(() => {
    const fetch_ = () =>
      fetch('/context/rs')
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data) setCtx(data as RSContext); })
        .catch(() => {});

    fetch_();
    const id = setInterval(fetch_, POLL_MS);
    return () => clearInterval(id);
  }, []);

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
      <span style={{ color: 'var(--text-1)', fontSize: 11, fontWeight: 600, letterSpacing: 0.5 }}>{label}</span>
      <span style={{ color, fontSize: 13, fontWeight: 800 }}>{value}</span>
    </span>
  );

  return (
    <div className="mono" style={{
      display: 'flex', alignItems: 'center', gap: 12,
      flexWrap: 'nowrap', whiteSpace: 'nowrap',
    }}>
      {chip('GM', ctx.greaterMarket.toUpperCase(), gmColor)}
      <span style={{ color: 'var(--text-2)', fontSize: 11 }}>|</span>
      {chip('VX', ctx.vx.toFixed(2), vxColor)}
      {chip('BBB', ctx.bbb.toFixed(2), 'var(--text-1)')}
      <span style={{ color: 'var(--text-2)', fontSize: 11 }}>|</span>
      {chip('VVIX', ctx.vvix.toFixed(0), vvixColor)}
      <span style={{ color: 'var(--text-2)', fontSize: 11 }}>|</span>
      {chip('DD', ctx.ddRatio.toFixed(2), ctx.ddRatio > 0.5 ? 'var(--long)' : ctx.ddRatio < 0.5 ? 'var(--short)' : 'var(--text-1)')}
      <span style={{ color: 'var(--text-2)', fontSize: 11 }}>|</span>
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ color: 'var(--text-1)', fontSize: 11, fontWeight: 600, letterSpacing: 0.5 }}>MHP</span>
        <span style={{ color: resColor(ctx.mhpResilience), fontSize: 13, fontWeight: 800 }}>{resLabel(ctx.mhpResilience)}</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ color: 'var(--text-1)', fontSize: 11, fontWeight: 600, letterSpacing: 0.5 }}>HP</span>
        <span style={{ color: resColor(ctx.hpResilience), fontSize: 13, fontWeight: 800 }}>{resLabel(ctx.hpResilience)}</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ color: 'var(--text-1)', fontSize: 11, fontWeight: 600, letterSpacing: 0.5 }}>RES</span>
        <span style={{ color: resColor(ctx.redistResilience), fontSize: 13, fontWeight: 800 }}>{resLabel(ctx.redistResilience)}</span>
      </span>
    </div>
  );
}
