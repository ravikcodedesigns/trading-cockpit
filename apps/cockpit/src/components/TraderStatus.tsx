import { useEffect, useState } from 'react';

// Persistent visual badge: trader's current open position + today's pnl.
// Polls /trader/state every 2 seconds.
//
// Critical UX after 2026-06-04 09:59 incident — user must see at a glance
// whether the trader has an open position and where SL/TP are set.

interface OpenPos {
  id: number;
  symbol: string;
  direction: 'long' | 'short';
  rule_id: string;
  qty: number;
  fill_price: number | null;
  sl_price: number | null;
  tp_price: number | null;
  status: string;
}
interface TraderState {
  open: OpenPos | null;
  todayPnl: number;
  recentErrors: number;
  halted: boolean;
}

export function TraderStatus() {
  const [state, setState] = useState<TraderState | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch('/trader/state');
        if (!alive) return;
        if (r.ok) setState(await r.json());
      } catch { /* keep last */ }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!state) return null;

  // 4 visual states ranked by alert level (loudest first)
  // 1. ERROR (red flashing): recentErrors > 0 in last hour → something went wrong
  // 2. NAKED POSITION (red): open with no SL or no TP set
  // 3. OPEN (yellow): healthy bracket, position live
  // 4. IDLE (gray): no open position
  if (state.recentErrors > 0) {
    return (
      <Badge bg="#3d1e1e" color="#ff5252" border="#ff5252" pulse>
        ⚠ TRADER ERROR ({state.recentErrors} in 1h)
      </Badge>
    );
  }
  if (state.open) {
    const o = state.open;
    const naked = !o.sl_price || !o.tp_price;
    if (naked) {
      return (
        <Badge bg="#3d1e1e" color="#ff5252" border="#ff5252" pulse>
          🚨 NAKED {o.direction.toUpperCase()} {o.symbol} @ {o.fill_price ?? '?'}
        </Badge>
      );
    }
    const dir = o.direction === 'long' ? '↑' : '↓';
    return (
      <Badge bg="#3d2c10" color="#f2a633" border="#f2a633">
        {dir} {o.direction.toUpperCase()} {o.symbol} @ {o.fill_price} · SL {o.sl_price} · TP {o.tp_price}
      </Badge>
    );
  }
  // Idle — show today's pnl as a small inline label
  const pnlStr = state.todayPnl >= 0 ? `+$${state.todayPnl.toFixed(2)}` : `-$${Math.abs(state.todayPnl).toFixed(2)}`;
  const pnlColor = state.todayPnl >= 0 ? '#2bb673' : '#d64545';
  return (
    <Badge bg="#1e3d28" color="#888" border="#333">
      IDLE · <span style={{ color: pnlColor, marginLeft: 6 }}>{pnlStr}</span>
    </Badge>
  );
}

function Badge(props: { bg: string; color: string; border: string; pulse?: boolean; children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '2px 8px',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.4,
        border: `1px solid ${props.border}`,
        borderRadius: 3,
        background: props.bg,
        color: props.color,
        fontFamily: 'var(--font-mono)',
        lineHeight: 1.4,
        animation: props.pulse ? 'traderPulse 1s ease-in-out infinite' : undefined,
      }}
    >
      <style>{`@keyframes traderPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.55 } }`}</style>
      {props.children}
    </div>
  );
}
