import { useMemo } from 'react';
import { useStore } from '../lib/ws';
import type { AggregatorEvent, ConfluenceSignal } from '@trading/contracts';

function fmtTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false });
}

function eventLabel(e: AggregatorEvent): { tag: string; detail: string; tone: string } {
  if (e.source === 'bookmap' && e.type === 'absorption') {
    return {
      tag: `ABS ${e.side.toUpperCase()}`,
      detail: `${e.symbol} @ ${e.price} · ${e.size} contracts · ${e.durationMs}ms`,
      tone: e.side === 'bid' ? 'var(--long)' : 'var(--short)',
    };
  }
  if (e.source === 'bookmap' && e.type === 'iceberg') {
    return {
      tag: `ICE ${e.side.toUpperCase()}`,
      detail: `${e.symbol} @ ${e.price} · ~${e.estimatedTotalSize}`,
      tone: 'var(--accent)',
    };
  }
  if (e.source === 'bookmap' && e.type === 'heartbeat') {
    return { tag: 'HB', detail: 'bookmap', tone: 'var(--text-2)' };
  }
  if (e.source === 'bookmap' && e.type === 'bar') {
    return {
      tag: 'BAR',
      detail: `${e.symbol} ${e.close} · vol ${e.volume}`,
      tone: 'var(--text-2)',
    };
  }
  if (e.source === 'bookmap' && e.type === 'sweep') {
    const arrow = e.direction === 'long' ? '↑' : '↓';
    return {
      tag: `SWEEP ${arrow}`,
      detail: `${e.symbol} · ${e.levels} lvls · ${e.volume} ct · ${e.durationMs}ms · ${e.startPrice}→${e.endPrice}`,
      tone: e.direction === 'long' ? 'var(--long)' : 'var(--short)',
    };
  }
  if (e.source === 'flashalpha' && e.type === 'snapshot') {
    return {
      tag: 'GEX',
      detail: `${e.symbol} · ${e.gammaRegime} · 0γ ${e.zeroGamma}`,
      tone: 'var(--accent)',
    };
  }
  if (e.source === 'levels' && e.type === 'daily') {
    return { tag: 'LVL', detail: `${e.symbol} loaded`, tone: 'var(--text-1)' };
  }
  if (e.source === 'tradovate' && e.type === 'tick') {
    return { tag: 'TICK', detail: `${e.symbol} ${e.price}`, tone: 'var(--text-2)' };
  }
  if (e.source === 'rules' && e.type === 'confluence') {
    return {
      tag: `SIG ${e.direction.toUpperCase()}`,
      detail: `${e.ruleId} · score ${e.score}`,
      tone: e.direction === 'long' ? 'var(--long)' : 'var(--short)',
    };
  }
  return { tag: e.type.toUpperCase(), detail: e.source, tone: 'var(--text-2)' };
}

function SignalCard({ sig }: { sig: ConfluenceSignal }) {
  const tone = sig.direction === 'long' ? 'var(--long)' : 'var(--short)';
  return (
    <div style={{
      padding: '8px 12px',
      borderLeft: `2px solid ${tone}`,
      background: 'var(--bg-2)',
      marginBottom: 6,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ color: tone, fontWeight: 500, letterSpacing: 0.5 }}>
          {sig.direction.toUpperCase()} · {sig.symbol}
        </span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>
          {fmtTime(sig.ts)} · {sig.score}
        </span>
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-1)' }}>
        {sig.ruleId}
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-1)', lineHeight: 1.4 }}>
        {sig.rationale}
      </div>
    </div>
  );
}

export function SignalFeed() {
  const recentEvents = useStore((s) => s.recentEvents);
  const recentSignals = useStore((s) => s.recentSignals);
  const selectedSymbol = useStore((s) => s.selectedSymbol);

  const filteredEvents = useMemo(
    () => recentEvents.filter((e) => !('symbol' in e) || !e.symbol || e.symbol === selectedSymbol).slice(-100).reverse(),
    [recentEvents, selectedSymbol]
  );
  const filteredSignals = useMemo(
    () => recentSignals.filter((s) => s.symbol === selectedSymbol),
    [recentSignals, selectedSymbol]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-1)', borderLeft: '1px solid var(--border)' }}>
      <div style={{
        padding: '10px 12px 6px',
        borderBottom: '1px solid var(--border)',
        fontSize: 11,
        letterSpacing: 1,
        color: 'var(--text-2)',
        textTransform: 'uppercase',
      }}>
        Signals · {selectedSymbol}
      </div>
      <div style={{ padding: 8, maxHeight: '40%', overflowY: 'auto' }}>
        {filteredSignals.length === 0 && (
          <div style={{ padding: '12px 4px', color: 'var(--text-2)', fontSize: 11 }}>
            no signals yet — observe-only mode
          </div>
        )}
        {filteredSignals.map((s, i) => <SignalCard key={`${s.ts}-${i}`} sig={s} />)}
      </div>

      <div style={{
        padding: '10px 12px 6px',
        borderTop: '1px solid var(--border)',
        borderBottom: '1px solid var(--border)',
        fontSize: 11,
        letterSpacing: 1,
        color: 'var(--text-2)',
        textTransform: 'uppercase',
      }}>
        Event log
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {filteredEvents.map((e, i) => {
          const { tag, detail, tone } = eventLabel(e);
          return (
            <div key={`${e.ts}-${i}`} style={{
              display: 'grid',
              gridTemplateColumns: '64px 56px 1fr',
              gap: 8,
              padding: '3px 12px',
              fontSize: 11,
              borderBottom: '1px solid var(--bg-2)',
              alignItems: 'baseline',
            }}>
              <span className="mono" style={{ color: 'var(--text-2)' }}>{fmtTime(e.ts)}</span>
              <span style={{ color: tone, fontWeight: 500 }}>{tag}</span>
              <span style={{ color: 'var(--text-1)' }}>{detail}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
