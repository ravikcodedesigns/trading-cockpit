import { useEffect } from 'react';
import { connect, useStore } from './lib/ws';
import { StatusBar } from './components/StatusBar';
import { Chart } from './components/Chart';
import { SignalFeed } from './components/SignalFeed';

export function App() {
  useEffect(() => { connect(); }, []);

  const wsStatus = useStore((s) => s.wsStatus);
  const selectedSymbol = useStore((s) => s.selectedSymbol);
  const levels = useStore((s) => s.levels[s.selectedSymbol]);
  const flashAlpha = useStore((s) => s.flashAlpha[s.selectedSymbol]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw' }}>
      <StatusBar />

      {wsStatus !== 'open' && (
        <div style={{
          padding: '6px 16px',
          background: 'var(--bg-2)',
          borderBottom: '1px solid var(--border)',
          fontSize: 11,
          color: 'var(--warn)',
        }}>
          {wsStatus === 'connecting' ? 'Connecting to aggregator…' : 'Disconnected from aggregator. Retrying…'}
        </div>
      )}

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 360px', overflow: 'hidden' }}>
        <div style={{ position: 'relative', overflow: 'hidden' }}>
          <Chart />
          <ContextStrip levels={levels} flashAlpha={flashAlpha} symbol={selectedSymbol} />
        </div>
        <SignalFeed />
      </div>
    </div>
  );
}

function ContextStrip({
  levels,
  flashAlpha,
  symbol,
}: {
  levels: ReturnType<typeof useStore.getState>['levels'][keyof ReturnType<typeof useStore.getState>['levels']];
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
          <div>bull <span style={{ color: 'var(--long)' }}>{levels.bullZone.low}–{levels.bullZone.high}</span></div>
          <div>bear <span style={{ color: 'var(--short)' }}>{levels.bearZone.low}–{levels.bearZone.high}</span></div>
          <div>HP <span style={{ color: 'var(--warn)' }}>{levels.hedgePressure}</span></div>
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
