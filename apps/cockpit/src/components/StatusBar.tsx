import { useStore } from '../lib/ws';
import type { ConnectionStatus, SourceName } from '@trading/contracts';
import { RSContextBar } from './RSContextBar';
import { KillSwitch } from './KillSwitch';
import { TraderStatus } from './TraderStatus';

const SOURCES: SourceName[] = ['bookmap', 'flashalpha', 'levels', 'tradovate'];

const dot = (status: ConnectionStatus | undefined) => {
  if (status === 'connected') return '#2bb673';
  if (status === 'disconnected') return '#d64545';
  return '#6e6e78';
};

export function StatusBar() {
  const { wsStatus, isStale, connections, eventsLogged, uptimeSec,
    selectedSymbol, setSymbol,
    selectedTimeframe, setTimeframe,
    soundOn, setSoundOn,
  } = useStore();

  const formatUptime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg-1)',
      fontSize: 12,
      color: 'var(--text-1)',
      flexShrink: 0,
    }}>
      {/* ── Row 1: controls + status ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 16px',
        height: 36,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-0)', fontWeight: 500 }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: wsStatus === 'open' ? '#2bb673' : wsStatus === 'connecting' ? '#f2a633' : '#d64545',
          }} />
          COCKPIT
        </div>

        {isStale && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '2px 8px', borderRadius: 3,
            background: '#3d2c10', border: '1px solid #f2a633',
            color: '#f2a633', fontWeight: 600, fontSize: 11, letterSpacing: 0.5,
          }}>
            ⚠ STALE
          </div>
        )}

        {/* Symbol selector */}
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

        <span style={{ color: 'var(--border)', userSelect: 'none' }}>│</span>

        {/* Timeframe switcher */}
        <div style={{ display: 'flex', gap: 3 }}>
          {([1, 5, 15] as const).map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 0.4,
                cursor: 'pointer',
                border: 'none',
                borderRadius: 3,
                background: selectedTimeframe === tf ? 'var(--accent, #5a9bff)' : 'var(--bg-2, #2a2a3a)',
                color: selectedTimeframe === tf ? '#fff' : 'var(--text-1, #888)',
                fontFamily: 'var(--font-mono)',
                transition: 'background 0.15s',
              }}
            >
              {tf}m
            </button>
          ))}
        </div>

        {/* Sound toggle */}
        <button
          onClick={() => setSoundOn(!soundOn)}
          title={soundOn ? 'Mute signal sounds' : 'Unmute signal sounds'}
          style={{
            padding: '2px 7px',
            fontSize: 12,
            cursor: 'pointer',
            border: 'none',
            borderRadius: 3,
            background: 'var(--bg-2, #2a2a3a)',
            color: soundOn ? '#f59e0b' : 'var(--text-1, #555)',
            lineHeight: 1,
          }}
        >
          {soundOn ? '🔔' : '🔕'}
        </button>

        {/* Trader state badge (open position + pnl + errors) */}
        <TraderStatus />

        {/* Trader kill-switch */}
        <KillSwitch />

        {/* Source dots + uptime — pushed to the right */}
        <div style={{ display: 'flex', gap: 14, marginLeft: 'auto', flexShrink: 0 }}>
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

        <div className="mono" style={{ color: 'var(--text-2)', flexShrink: 0 }}>
          events: {eventsLogged.toLocaleString()} · up: {formatUptime(uptimeSec)}
        </div>
      </div>

      {/* ── Row 2: RS context strip ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '3px 16px',
        borderTop: '1px solid var(--border)',
        minHeight: 26,
      }}>
        <RSContextBar />
      </div>
    </div>
  );
}
