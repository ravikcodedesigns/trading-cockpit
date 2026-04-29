import { useStore } from '../lib/ws';
import type { ConnectionStatus, SourceName } from '@trading/contracts';

const SOURCES: SourceName[] = ['bookmap', 'flashalpha', 'levels', 'tradovate'];

const dot = (status: ConnectionStatus | undefined) => {
  if (status === 'connected') return '#2bb673';
  if (status === 'disconnected') return '#d64545';
  return '#6e6e78';
};

export function StatusBar() {
  const { wsStatus, connections, eventsLogged, uptimeSec, selectedSymbol, setSymbol } = useStore();

  const formatUptime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 24,
      padding: '0 16px',
      height: 36,
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg-1)',
      fontSize: 12,
      color: 'var(--text-1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-0)', fontWeight: 500 }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: wsStatus === 'open' ? '#2bb673' : wsStatus === 'connecting' ? '#f2a633' : '#d64545',
        }} />
        COCKPIT
      </div>

      <div style={{ display: 'flex', gap: 4 }}>
        {(['NQ', 'ES'] as const).map((s) => (
          <button key={s}
            onClick={() => setSymbol(s)}
            style={{
              borderColor: s === selectedSymbol ? 'var(--accent)' : 'var(--border)',
              color: s === selectedSymbol ? 'var(--accent)' : 'var(--text-1)',
              fontFamily: 'var(--font-mono)',
              fontWeight: 500,
            }}>
            {s}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 14, marginLeft: 'auto' }}>
        {SOURCES.map((src) => (
          <div key={src} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: dot(connections[src]),
            }} />
            <span style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>{src}</span>
          </div>
        ))}
      </div>

      <div className="mono" style={{ color: 'var(--text-2)' }}>
        events: {eventsLogged.toLocaleString()} · up: {formatUptime(uptimeSec)}
      </div>
    </div>
  );
}
