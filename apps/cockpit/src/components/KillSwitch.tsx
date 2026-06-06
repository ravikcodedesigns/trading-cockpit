import { useEffect, useState } from 'react';

interface HaltState {
  halted: boolean;
  reason: string | null;
}

export function KillSwitch() {
  const [state, setState] = useState<HaltState | null>(null);
  const [busy, setBusy]   = useState(false);

  // Initial fetch + poll every 5s so the button reflects state if toggled
  // from a different cockpit instance or shell.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch('/trader/halt');
        if (!alive) return;
        if (res.ok) setState(await res.json());
      } catch { /* keep last */ }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const toggle = async () => {
    if (!state) return;
    if (!state.halted) {
      const ok = window.confirm('Halt the trader? All new signals will be blocked until you re-enable.');
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await fetch('/trader/halt', {
        method: state.halted ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: state.halted ? undefined : JSON.stringify({ reason: 'cockpit kill-switch button' }),
      });
      if (res.ok) setState(await res.json());
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <button disabled title="Loading trader status…" style={baseStyle('#444', '#888')}>
        AUTO …
      </button>
    );
  }

  const halted = state.halted;
  return (
    <button
      onClick={toggle}
      disabled={busy}
      title={halted ? `Trader HALTED — click to resume\nReason: ${state.reason ?? '—'}` : 'Trader running — click to HALT (kill-switch)'}
      style={baseStyle(halted ? '#3d1e1e' : '#1e3d28', halted ? '#ff5252' : '#2bb673')}
    >
      {halted ? '⛔ HALTED' : '✅ AUTO'}
    </button>
  );
}

function baseStyle(bg: string, color: string): React.CSSProperties {
  return {
    padding: '2px 8px',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.6,
    cursor: 'pointer',
    border: `1px solid ${color}`,
    borderRadius: 3,
    background: bg,
    color,
    fontFamily: 'var(--font-mono)',
    lineHeight: 1.4,
  };
}
