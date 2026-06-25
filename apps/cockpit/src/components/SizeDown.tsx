import { useEffect, useState } from 'react';

// Toggles /tmp/trader.sizedown via the aggregator. ON = every signal forced to base 1×;
// OFF = differential 2× (FLIP-short / CONT-long) active. Live, no trader restart. Sibling of KillSwitch.
export function SizeDown() {
  const [sizedown, setSizedown] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  // Poll every 5s so the button reflects the flag if toggled elsewhere (shell / other cockpit).
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch('/trader/sizedown');
        if (!alive) return;
        if (res.ok) setSizedown(!!(await res.json()).sizedown);
      } catch { /* keep last */ }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const toggle = async () => {
    if (sizedown === null) return;
    const prev = sizedown;
    setSizedown(!prev);   // optimistic
    setBusy(true);
    try {
      const res = await fetch('/trader/sizedown', prev ? { method: 'DELETE' } : { method: 'POST' });
      if (res.ok) setSizedown(!!(await res.json()).sizedown);
      else setSizedown(prev);
    } catch { setSizedown(prev); } finally { setBusy(false); }
  };

  if (sizedown === null) {
    return <button disabled title="Loading sizing…" style={baseStyle('#444', '#888')}>SIZE …</button>;
  }
  return (
    <button
      onClick={toggle}
      disabled={busy}
      title={sizedown
        ? 'Sizing FORCED to 1× — click to restore differential 2× (FLIP-short / CONT-long)'
        : 'Differential 2× active (FLIP-short / CONT-long) — click to force ALL signals to 1×'}
      style={baseStyle(sizedown ? '#3d3320' : '#1e3d28', sizedown ? '#ffb300' : '#2bb673')}
    >
      {sizedown ? '① SIZE 1×' : '② SIZE 2×'}
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
