import { useEffect, useState } from 'react';
import type { DriftSnapshot, Symbol as Sym } from '@trading/contracts';

// Live filtered NET-DRIFT HUD — a compact strip showing the cumulative ABJ-filtered
// (0DTE/OTM/aggressor) call-vs-put premium for the index that maps to the selected future
// (NQ→NDX, ES→SPX), its 10-min slope (the signal), and a price-momentum(10m) slope (the
// placebo). SHADOW ONLY — this is the display of the forward-validation signal registered in
// apps/aggregator/scripts/NETDRIFT_FWD_PREREG.md; it gates nothing. Streamed from the drift
// worker over /ws/drift; mounted only while the DRIFT toggle is on (worker polls lazily).

function useDrift(symbol: Sym): DriftSnapshot | null {
  const [snap, setSnap] = useState<DriftSnapshot | null>(null);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let sock: WebSocket;
      try { sock = new WebSocket(`${proto}://${location.host}/ws/drift?symbol=${symbol}`); }
      catch { reconnect = setTimeout(connect, 1500); return; }
      ws = sock;
      sock.onmessage = (ev) => {
        try { const m = JSON.parse(ev.data as string); if (m.type === 'drift' && m.symbol === symbol) setSnap(m as DriftSnapshot); }
        catch { /* ignore */ }
      };
      sock.onopen = () => { ping = setInterval(() => { try { sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ type: 'ping' })); } catch { /* noop */ } }, 15000); };
      sock.onclose = () => { if (ping) clearInterval(ping); if (!closed) reconnect = setTimeout(connect, 1500); };
      sock.onerror = () => { try { sock.close(); } catch { /* noop */ } };
    };
    setSnap(null);
    const initial = setTimeout(connect, 80);   // survive StrictMode double-mount (see FlowHud)
    return () => { closed = true; clearTimeout(initial); if (reconnect) clearTimeout(reconnect); if (ping) clearInterval(ping); try { ws?.close(); } catch { /* noop */ } };
  }, [symbol]);
  return snap;
}

const LONG = 'var(--long)';
const SHORT = 'var(--short)';
const MUTE = 'var(--text-2)';
const LUM = '#67e8f9';

// Compact dollar premium: 2_488_393 → "+$2.5M", −751_670 → "−$0.75M".
const dfmt = (n: number): string => {
  const s = n < 0 ? '−' : '+';
  const a = Math.abs(n);
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}k`;
  return `${s}$${Math.round(a)}`;
};
// Slope in $/min → compact.
const sfmt = (n: number): string => {
  const s = n < 0 ? '−' : '+';
  const a = Math.abs(n);
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(1)}k`;
  return `${s}${Math.round(a)}`;
};
const signColor = (n: number) => (n > 0 ? LONG : n < 0 ? SHORT : 'var(--text-1)');
const arrow = (n: number) => (n > 0 ? '↑' : n < 0 ? '↓' : '·');

const Key = ({ t, title }: { t: string; title?: string }) => (
  <span title={title} style={{ color: LUM, fontSize: 10, fontWeight: 800, letterSpacing: 0.7 }}>{t}</span>
);

export function DriftHud({ symbol }: { symbol: Sym }) {
  const d = useDrift(symbol);
  return (
    <div className="mono" style={{
      display: 'inline-flex', flexDirection: 'column', gap: 3,
      padding: '5px 12px', marginTop: 6,
      background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 4,
      whiteSpace: 'nowrap', opacity: d ? 1 : 0.5,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ color: '#22d3ee', fontSize: 11, fontWeight: 800, letterSpacing: 0.5 }}>DRIFT·{symbol}</span>
        {d && <span style={{ color: MUTE, fontSize: 10 }}>{d.index} 0DTE·OTM·aggr {d.stale ? '· stale' : ''}</span>}
      </div>

      {!d ? (
        <span style={{ color: MUTE, fontSize: 11 }}>…connecting</span>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(96px, 1fr))', columnGap: 16, rowGap: 2, alignItems: 'baseline' }}>
          <Key t="NET DRIFT" title="Cumulative net (call − put) filtered premium this session. >0 = calls dominating (bullish tilt)." />
          <Key t="10m SLOPE" title="Least-squares slope of the net-drift curve over the last 10 min ($/min). The directional signal — ↑ = calls building, ↓ = puts building." />
          <Key t="PX 10m" title="Price-momentum placebo: 10-min slope of the index spot. The signal must beat THIS to be worth anything (they are ~0.69 correlated)." />
          <span style={{ fontSize: 14, fontWeight: 700, color: signColor(d.netCum) }}>{dfmt(d.netCum)}<span style={{ fontSize: 10, color: MUTE, fontWeight: 600 }}> {d.bias === 'bull' ? 'BULL' : 'BEAR'}</span></span>
          <span style={{ fontSize: 14, fontWeight: 700, color: signColor(d.slope10) }}>{sfmt(d.slope10)} {arrow(d.slope10)}<span style={{ fontSize: 9, color: MUTE }}>/m</span></span>
          <span style={{ fontSize: 14, fontWeight: 700, color: signColor(d.priceSlope10) }}>{d.priceSlope10 > 0 ? '+' : ''}{d.priceSlope10.toFixed(2)} {arrow(d.priceSlope10)}</span>
        </div>
      )}
    </div>
  );
}
