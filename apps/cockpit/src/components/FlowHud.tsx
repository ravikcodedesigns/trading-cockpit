import { useEffect, useState } from 'react';
import type { FlowSnapshot, Symbol as Sym } from '@trading/contracts';

// Live L3 order-flow HUD — a compact strip of tape/book gauges derived from the full MBO
// stream (order add/cancel/replace + attributed trades), streamed from the flow worker over
// /ws/flow. Mounted only while the FLOW toggle is on, so the WS (and the worker's lazy
// tailing) live exactly as long as the strip is visible.

function useFlow(symbol: Sym): FlowSnapshot | null {
  const [snap, setSnap] = useState<FlowSnapshot | null>(null);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let sock: WebSocket;
      try { sock = new WebSocket(`${proto}://${location.host}/ws/flow?symbol=${symbol}`); }
      catch { reconnect = setTimeout(connect, 1500); return; }
      ws = sock;
      sock.onmessage = (ev) => {
        try { const m = JSON.parse(ev.data as string); if (m.type === 'flow' && m.symbol === symbol) setSnap(m as FlowSnapshot); }
        catch { /* ignore */ }
      };
      sock.onopen = () => { ping = setInterval(() => { try { sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ type: 'ping' })); } catch { /* noop */ } }, 15000); };
      sock.onclose = () => { if (ping) clearInterval(ping); if (!closed) reconnect = setTimeout(connect, 1500); };
      sock.onerror = () => { try { sock.close(); } catch { /* noop */ } };
    };
    setSnap(null);
    // Delay the first connect so React StrictMode's synchronous mount→unmount→mount
    // cancels the throwaway attempt before any socket is created — otherwise the rapid
    // connect/close/connect churn wedges the 2nd socket in CONNECTING through the WS proxy.
    const initial = setTimeout(connect, 80);
    return () => { closed = true; clearTimeout(initial); if (reconnect) clearTimeout(reconnect); if (ping) clearInterval(ping); try { ws?.close(); } catch { /* noop */ } };
  }, [symbol]);
  return snap;
}

const LONG = 'var(--long)';
const SHORT = 'var(--short)';
const MUTE = 'var(--text-2)';
const LUM = '#67e8f9';    // luminescent key/label color (was gray & invisible)
const WIN = '#e2e8f0';    // window-label color (bright)

// Compact contract count: 2143 → "2.1k", 340 → "340".
const kfmt = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
};
const signColor = (n: number) => (n > 0 ? LONG : n < 0 ? SHORT : 'var(--text-1)');
const arrow = (n: number) => (n > 0 ? '↑' : n < 0 ? '↓' : '·');
const winLabel = (sec: number) => (sec === 60 ? '1m' : sec === 300 ? '5m' : sec === 900 ? '15m' : `${sec}s`);

// A luminescent metric key (column header).
const Key = ({ t, title }: { t: string; title?: string }) => (
  <span title={title} style={{ color: LUM, fontSize: 10, fontWeight: 800, letterSpacing: 0.7 }}>{t}</span>
);

export function FlowHud({ symbol }: { symbol: Sym }) {
  const f = useFlow(symbol);
  const wins = f?.windows ?? [];
  const cvdArrow = wins[0] ? arrow(wins[0].delta) : '·';   // arrow = 1m slope

  return (
    <div className="mono" style={{
      display: 'inline-flex', flexDirection: 'column', gap: 3,
      padding: '5px 12px', marginTop: 6,
      background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 4,
      whiteSpace: 'nowrap', opacity: f ? 1 : 0.5,
    }}>
      {/* Header: session context (same across windows) */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ color: '#22d3ee', fontSize: 11, fontWeight: 800, letterSpacing: 0.5 }}>FLOW·{symbol}</span>
        {f && (
          <>
            <Key t="CVD" title="Session cumulative volume delta (true, order-attributed). Arrow = 1m slope." />
            <span style={{ color: signColor(f.cvd), fontSize: 13, fontWeight: 700 }}>{f.cvd > 0 ? '+' : ''}{Math.round(f.cvd).toLocaleString('en-US')} {cvdArrow}</span>
            <Key t="SP" title="Spread in ticks (best ask − best bid)" />
            <span style={{ color: f.spreadTicks > 1 ? '#f59e0b' : 'var(--text-1)', fontSize: 13, fontWeight: 700 }}>{f.spreadTicks}t</span>
          </>
        )}
      </div>

      {!f ? (
        <span style={{ color: MUTE, fontSize: 11 }}>…connecting</span>
      ) : (
        // 3-window confluence grid: rows = 1m / 5m / 15m, columns = IMB / Δ / TAPE / TEMP.
        <div style={{ display: 'grid', gridTemplateColumns: '2.6em repeat(4, minmax(74px, 1fr))', columnGap: 16, rowGap: 3, alignItems: 'baseline' }}>
          <span />
          <Key t="IMB"  title={`Trailing-avg resting book imbalance within ±${f.bandTicks} ticks of mid (>0 = bid-stacked)`} />
          <Key t="Δ"    title="Aggressor delta over the window (market buys − sells)" />
          <Key t="TAPE" title="Tape velocity — trades / sec" />
          <Key t="TEMP" title="Book temperature — MBO messages / sec (adds+cancels+replaces)" />
          {wins.map((w) => (
            <FlowRow key={w.sec} w={w} />
          ))}
        </div>
      )}
    </div>
  );
}

function FlowRow({ w }: { w: import('@trading/contracts').FlowWindow }) {
  const val: React.CSSProperties = { fontSize: 13, fontWeight: 700 };
  return (
    <>
      <span style={{ color: WIN, fontSize: 12, fontWeight: 800 }}>{winLabel(w.sec)}</span>
      <span style={{ ...val, color: signColor(w.imb) }}>{w.imb > 0 ? '+' : ''}{kfmt(w.imb)}</span>
      <span style={{ ...val, color: signColor(w.delta) }}>
        {w.delta > 0 ? '+' : ''}{kfmt(w.delta)} {arrow(w.delta)}
        <span style={{ fontSize: 9, color: MUTE, fontWeight: 600 }}> {winLabel(w.deltaSec)}</span>
        {/* deltaPct = delta / total volume: the regime-comparable read (+300 at the open ≠ +300 at lunch) */}
        {w.deltaPct != null && w.vol != null && w.vol > 0 && (
          <span style={{ fontSize: 9, color: MUTE, fontWeight: 600 }} title="Δ as % of total aggressor volume in the sub-window"> {(w.deltaPct * 100).toFixed(0)}%</span>
        )}
      </span>
      <span style={{ ...val, color: 'var(--text-1)' }}>{w.tps.toFixed(1)}<span style={{ fontSize: 9, color: MUTE }}>/s</span></span>
      <span style={{ ...val, color: w.mps > 400 ? '#f59e0b' : w.mps > 150 ? '#eab308' : 'var(--text-1)' }}>{kfmt(w.mps)}<span style={{ fontSize: 9, color: MUTE }}>/s</span></span>
    </>
  );
}
