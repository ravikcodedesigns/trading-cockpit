import { useEffect, useState, useSyncExternalStore } from 'react';
import { connect, useStore } from './lib/ws';
import { StatusBar } from './components/StatusBar';
import { Chart } from './components/Chart';
import { SignalFeed } from './components/SignalFeed';
import { tradingDayFor } from '@trading/contracts';

// Reactive narrow-screen detector — re-renders on window resize.
function subscribe(cb: () => void) {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
}
function useIsMobile() {
  return useSyncExternalStore(subscribe, () => window.innerWidth < 768);
}

export function App() {
  useEffect(() => { connect(); }, []);

  const isMobile  = useIsMobile();
  const [tab, setTab] = useState<'chart' | 'signals'>('chart');
  const [signalPanelOpen, setSignalPanelOpen] = useState(true);

  const wsStatus = useStore((s) => s.wsStatus);
  const selectedSymbol = useStore((s) => s.selectedSymbol);
  const levelsByDay = useStore((s) => s.levelsByDay);
  const flashAlpha = useStore((s) => s.flashAlpha[s.selectedSymbol]);
  const today = tradingDayFor(Date.now());
  const levels = levelsByDay[today]?.[selectedSymbol];

  const disconnectBanner = wsStatus !== 'open' && (
    <div style={{
      padding: '6px 16px',
      background: 'var(--bg-2)',
      borderBottom: '1px solid var(--border)',
      fontSize: 11,
      color: 'var(--warn)',
      flexShrink: 0,
    }}>
      {wsStatus === 'connecting' ? 'Connecting to aggregator…' : 'Disconnected from aggregator. Retrying…'}
    </div>
  );

  // ── Desktop layout ─────────────────────────────────────────────────────────
  if (!isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw' }}>
        <StatusBar />
        {disconnectBanner}
        <div style={{
          flex: 1, overflow: 'hidden',
          display: 'grid',
          gridTemplateColumns: signalPanelOpen ? '1fr 14px 360px' : '1fr 14px',
        }}>
          {/* Chart area */}
          <div style={{ position: 'relative', overflow: 'hidden' }}>
            <Chart />
            <ContextStrip levels={levels} flashAlpha={flashAlpha} symbol={selectedSymbol} />
          </div>

          {/* Toggle strip — its own column, never clipped */}
          <div
            onClick={() => setSignalPanelOpen(o => !o)}
            title={signalPanelOpen ? 'Collapse signals' : 'Expand signals'}
            style={{
              background: '#141418',
              borderLeft: '1px solid #222228',
              borderRight: signalPanelOpen ? '1px solid #222228' : 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#444',
              fontSize: 12,
              userSelect: 'none',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = '#1e1e28'; (e.currentTarget as HTMLDivElement).style.color = '#999'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = '#141418'; (e.currentTarget as HTMLDivElement).style.color = '#444'; }}
          >
            {signalPanelOpen ? '›' : '‹'}
          </div>

          {/* Signals panel */}
          {signalPanelOpen && <SignalFeed />}
        </div>
      </div>
    );
  }

  // ── Mobile layout — tabbed fullscreen ──────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', width: '100vw', overflow: 'hidden' }}>
      <StatusBar />
      {disconnectBanner}

      {/* Main content area */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {/* Chart tab */}
        <div style={{ display: tab === 'chart' ? 'block' : 'none', height: '100%', position: 'relative' }}>
          <Chart />
          <ContextStrip levels={levels} flashAlpha={flashAlpha} symbol={selectedSymbol} />
        </div>
        {/* Signals tab */}
        <div style={{ display: tab === 'signals' ? 'flex' : 'none', height: '100%', flexDirection: 'column' }}>
          <SignalFeed />
        </div>
      </div>

      {/* Bottom tab bar */}
      <div style={{
        display: 'flex',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-1)',
        flexShrink: 0,
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        <TabButton label="Chart" active={tab === 'chart'} onClick={() => setTab('chart')} />
        <TabButton label="Signals" active={tab === 'signals'} onClick={() => setTab('signals')} />
      </div>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: '10px 0',
        background: 'none',
        border: 'none',
        borderTop: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
        color: active ? 'var(--text-0)' : 'var(--text-2)',
        fontSize: 12,
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        letterSpacing: 0.5,
      }}
    >
      {label}
    </button>
  );
}

function ContextStrip({
  levels,
  flashAlpha,
  symbol,
}: {
  levels: ReturnType<typeof useStore.getState>['levelsByDay'][string][keyof ReturnType<typeof useStore.getState>['levelsByDay'][string]];
  flashAlpha: ReturnType<typeof useStore.getState>['flashAlpha'][keyof ReturnType<typeof useStore.getState>['flashAlpha']];
  symbol: string;
}) {
  return (
    <div style={{
      position: 'absolute',
      top: 8,
      left: 8,
      padding: '6px 10px',
      background: 'rgba(10,10,11,0.85)',
      border: '1px solid var(--border)',
      fontSize: 11,
      color: 'var(--text-1)',
      backdropFilter: 'blur(4px)',
      pointerEvents: 'none',
      maxWidth: 360,
    }}>
      <div style={{ color: 'var(--text-0)', fontWeight: 500, letterSpacing: 0.5, marginBottom: 4 }}>{symbol}</div>
      {levels ? (
        <div className="mono" style={{ fontSize: 11, lineHeight: 1.5 }}>
          {levels.bullZone && (
            <div>bull <span style={{ color: 'var(--long)' }}>{levels.bullZone.low}–{levels.bullZone.high}</span></div>
          )}
          {levels.bearZone && (
            <div>bear <span style={{ color: 'var(--short)' }}>{levels.bearZone.low}–{levels.bearZone.high}</span></div>
          )}
          {levels.hedgePressure !== undefined && (
            <div>HP <span style={{ color: 'var(--warn)' }}>{levels.hedgePressure}</span></div>
          )}
          {!levels.bullZone && !levels.bearZone && !levels.hedgePressure && (
            <div style={{ color: 'var(--text-2)' }}>RS levels not tracked</div>
          )}
        </div>
      ) : (
        <div style={{ color: 'var(--text-2)', fontSize: 11 }}>no levels loaded</div>
      )}
      {flashAlpha && (
        <div className="mono" style={{ fontSize: 11, marginTop: 4, color: 'var(--accent)' }}>
          γ {flashAlpha.gammaRegime} · 0γ {flashAlpha.zeroGamma}
        </div>
      )}
    </div>
  );
}
