import { useEffect, useState } from 'react';

interface PipelineState {
  pipelineMode: 'shadow' | 'live';
  v3Mode: 'off' | 'shadow' | 'live';
  symbols: readonly string[];
}

/**
 * Small status badge showing which decision path is authoritative for live
 * trading. Polls /pipeline/state every 30s so the badge updates when the env
 * is flipped (PIPELINE_ACTIVE_MODE=live) and the aggregator is restarted.
 *
 * SHADOW = legacy V3 cascade drives broadcasts + tradeManager.
 * LIVE   = new signal-pipeline (tradable_signals) drives broadcasts +
 *          tradeManager. V3 still computes its decision for divergence
 *          detection but performs no side effects.
 */
export function PipelineModeBadge() {
  const [state, setState] = useState<PipelineState | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch('/pipeline/state');
        if (!alive) return;
        if (res.ok) setState(await res.json());
      } catch { /* keep last */ }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!state) {
    return (
      <span style={baseStyle('#444', '#888')} title="Loading pipeline mode…">
        PIPE …
      </span>
    );
  }

  const live = state.pipelineMode === 'live';
  // Color: green for LIVE (new pipeline authoritative), yellow for SHADOW
  // (legacy V3 still in charge — flag the visual difference so it's obvious).
  const bg    = live ? '#1e3d28' : '#3a2e0e';
  const fg    = live ? '#2bb673' : '#e6b800';
  const label = live ? 'PIPE LIVE' : 'PIPE SHADOW';
  const tip   = live
    ? `Pipeline authoritative (mode=live)\nSymbols: ${state.symbols.join(', ')}`
    : `Legacy V3 cascade authoritative (pipeline mode=shadow, V3=${state.v3Mode})\nFlip env PIPELINE_ACTIVE_MODE=live + restart aggregator to cut over.`;

  return (
    <span style={baseStyle(bg, fg)} title={tip}>
      {label}
    </span>
  );
}

function baseStyle(bg: string, color: string): React.CSSProperties {
  return {
    padding: '2px 8px',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.6,
    border: `1px solid ${color}`,
    borderRadius: 3,
    background: bg,
    color,
    fontFamily: 'var(--font-mono)',
    lineHeight: 1.4,
    userSelect: 'none',
  };
}
