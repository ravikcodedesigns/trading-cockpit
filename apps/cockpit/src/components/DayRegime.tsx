import { useEffect, useState } from 'react';

// At-a-glance "how's the day" badge for the top bar (next to the kill switch):
// greater-market direction (bullish/bearish) + volatility environment (calm/stressed).
// Plain wording on purpose — "risk-on/off" was confusing.
interface Ctx {
  greaterMarket: 'bull' | 'bear' | 'neutral';
  isRational: boolean;     // VX < BBB AND VVIX not elevated → calm
}

const POLL_MS = 30_000;

export function DayRegime({ symbol }: { symbol?: string }) {
  const [ctx, setCtx] = useState<Ctx | null>(null);

  useEffect(() => {
    const url = symbol ? `/context/rs?symbol=${encodeURIComponent(symbol)}` : '/context/rs';
    const fetch_ = () =>
      fetch(url).then(r => (r.ok ? r.json() : null)).then(d => { if (d) setCtx(d as Ctx); }).catch(() => {});
    fetch_();
    const id = setInterval(fetch_, POLL_MS);
    return () => clearInterval(id);
  }, [symbol]);

  if (!ctx) return null;

  const bull = ctx.greaterMarket === 'bull';
  const calm = ctx.isRational;
  const dir = bull ? 'BULLISH' : ctx.greaterMarket === 'bear' ? 'BEARISH' : 'NEUTRAL';
  const vol = calm ? 'CALM' : 'STRESSED';
  // Green when bullish + calm (best for longs), red when bearish + stressed (worst),
  // amber for the mixed states (bullish-but-stressed / bearish-but-calm).
  const color = bull && calm ? 'var(--long)'
              : !bull && !calm ? 'var(--short)'
              : '#f2a633';

  return (
    <div
      className="mono"
      title="Day regime — greater-market direction + volatility environment"
      style={{
        display: 'inline-flex', alignItems: 'baseline', gap: 7,
        padding: '4px 12px', borderRadius: 6, border: `2px solid ${color}`,
        color, fontWeight: 800, fontSize: 14, letterSpacing: 0.6, whiteSpace: 'nowrap',
      }}
    >
      <span style={{ opacity: 0.65, fontWeight: 700, fontSize: 11 }}>DAY</span>
      <span>{dir} · {vol}</span>
    </div>
  );
}
