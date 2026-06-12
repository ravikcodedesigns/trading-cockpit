import { useMemo, useState } from 'react';
import { useStore } from '../lib/ws';
import type { ConfluenceSignal, RSTier } from '@trading/contracts';

// ── RS visual helpers ──────────────────────────────────────────────────────────

const TIER_COLOR: Record<RSTier, string> = {
  PRIME:    '#a855f7',   // bright violet
  HIGH:     '#f2a633',   // amber
  MODERATE: '#4a8fdc',   // blue
  WEAK:     '#707078',   // dim gray
  PASS:     '#3a3a44',   // very dim
};

const TIER_FILLED: Record<RSTier, number> = {
  PRIME: 4, HIGH: 3, MODERATE: 2, WEAK: 1, PASS: 0,
};

function RSOrbs({ tier }: { tier: RSTier }) {
  const color  = TIER_COLOR[tier];
  const filled = TIER_FILLED[tier];
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
      {[0, 1, 2, 3].map(i => (
        <span key={i} style={{
          width: 6, height: 6, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
          background: i < filled ? color : 'transparent',
          border: `1px solid ${i < filled ? color : 'var(--border-strong)'}`,
        }} />
      ))}
    </span>
  );
}

// ── Resilience conviction helpers ─────────────────────────────────────────────

function resFmt(v: number): string {
  if (v === 0) return '0';
  const sign = v > 0 ? '+' : '';
  return `${sign}${Math.abs(v) % 1 === 0 ? v : v.toFixed(1)}`;
}

function ResConviction({ resContext, direction }: {
  resContext: NonNullable<ConfluenceSignal['resContext']>;
  direction: 'long' | 'short';
}) {
  const { res, hpRes, mhpRes, isRational } = resContext;

  const markers = [
    { label: 'MHP', value: mhpRes, lineColor: '#f2a633' },  // orange
    { label: 'HP',  value: hpRes,  lineColor: '#4a8fdc' },  // blue
    { label: 'Res', value: res,    lineColor: '#9ca3af' },  // gray
  ];

  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
      {!isRational && (
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--short)', letterSpacing: 0.5, marginBottom: 2 }}>
          IRRATIONAL — res unreliable
        </span>
      )}
      {markers.map(({ label, value, lineColor }) => {
        const agrees  = direction === 'long' ? value > 0 : value < 0;
        const neutral = value === 0;
        const valueColor = neutral ? 'var(--text-2)' : agrees ? 'var(--long)' : 'var(--short)';
        return (
          <div key={label} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: lineColor, letterSpacing: 0.5, width: 28 }}>
              {label}
            </span>
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: valueColor }}>
              {resFmt(value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Signal name + rationale helpers ───────────────────────────────────────────

function signalDisplayName(ruleId: string, direction: 'long' | 'short'): string {
  const arrow = direction === 'long' ? '↑' : '↓';
  const map: Record<string, string> = {
    'clean-impulse':        `Flip`,
    'passive-seller':       `Passive Seller`,
    'absorption-scalp':     `Absorption`,
    'absorption-scalp-15m': `Absorption`,
    'compression-breakout': `Compression`,
    'absorption':           `Absorption`,
    'expl':                 `EXPL`,
  };
  return map[ruleId] ?? ruleId;
}

// Strip leading "SIGNAL-TYPE DIRECTION: " prefix from rationale text
function stripRationalePrefix(text: string): string {
  return text.replace(/^[A-Z][A-Z0-9\s\-\[\]→m]+:\s*/, '');
}

// Build the full RS label line with score prefix: "RS 88 · BZB · First test · GM bull · BLD"
function buildLabelLine(sig: ConfluenceSignal): string | undefined {
  if (!sig.rsLabelLine && sig.rsScore === undefined) return undefined;
  const scorePart = sig.rsScore !== undefined ? `RS ${sig.rsScore}` : undefined;
  const linePart  = sig.rsLabelLine ?? undefined;
  if (scorePart && linePart) return `${scorePart} · ${linePart}`;
  return scorePart ?? linePart;
}

// ── Signal card ────────────────────────────────────────────────────────────────

function SignalCard({ sig }: { sig: ConfluenceSignal }) {
  const tone      = sig.direction === 'long' ? 'var(--long)' : 'var(--short)';
  const tier      = sig.rsTier;
  const name      = signalDisplayName(sig.ruleId, sig.direction);
  const labelLine = buildLabelLine(sig);
  const rationale = stripRationalePrefix(sig.rationale ?? '');
  const deadZone  = (sig as any).deadZone === true;

  return (
    <div style={{
      padding: '9px 13px',
      borderLeft: `2px solid ${tone}`,
      background: 'var(--bg-2)',
      marginBottom: 6,
    }}>
      {/* Row 1: NQ.LONG.EXPL  91  [DT]  |  12:34:01 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span className="mono" style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
          <span style={{ color: tone, fontWeight: 700, fontSize: 13, letterSpacing: 0.4 }}>
            {sig.symbol}.{sig.direction.toUpperCase()}.{name.toUpperCase()}
            <span style={{ color: 'var(--text-0, #e8e8ec)', fontWeight: 600 }}>{'  '}{sig.score}</span>
          </span>
          {deadZone && (
            <span style={{
              fontSize: 10, fontWeight: 800, letterSpacing: 0.8,
              color: '#f59e0b', background: 'rgba(245,158,11,0.12)',
              padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(245,158,11,0.35)',
            }}>DT</span>
          )}
        </span>
        <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', flexShrink: 0 }}>
          {fmtTime(sig.ts)}
        </span>
      </div>

      {/* Row 2a: [orbs] PRIME */}
      {tier && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 7 }}>
          <RSOrbs tier={tier} />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, color: TIER_COLOR[tier] }}>
            {tier}
          </span>
        </div>
      )}

      {/* Row 2b: level=50 | context=28 | confirm=10 */}
      {sig.rsComponents && (
        <div style={{ marginTop: 3 }}>
          <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)' }}>
            level={sig.rsComponents.level} | context={sig.rsComponents.context} | confirm={sig.rsComponents.confirm}
          </span>
        </div>
      )}

      {/* Row 3: RS 88 · BZB · First test · GM bull · DD-long · BLD */}
      {labelLine && (
        <div style={{ marginTop: 5, fontSize: 12, fontWeight: 600, color: 'var(--text-1)', letterSpacing: 0.2, lineHeight: 1.4 }}>
          {labelLine}
        </div>
      )}

      {/* Row 4: MHP ±N▲▼  HP ±N▲▼  Res ±N▲▼ */}
      {sig.resContext && (
        <ResConviction resContext={sig.resContext} direction={sig.direction} />
      )}

      {/* Row 5: rationale */}
      {rationale && (
        <div style={{ marginTop: 5, fontSize: 12, fontWeight: 500, color: 'var(--text-1)', lineHeight: 1.5 }}>
          {rationale}
        </div>
      )}
    </div>
  );
}

// (Event log panel removed 2026-06-08 — heartbeat + bar events dominated, and
// the actually-interesting events were already covered by chart markers and
// Pushover. Reclaimed panel space went to the signals list.)

// ── Test signal injection ──────────────────────────────────────────────────────

function injectTestSignals(price: number, direction: 'long' | 'short', notifyDiscord: boolean) {
  fetch('/test/signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'NQ', price, direction, discord: notifyDiscord }),
  }).catch(() => {});
}

// ── Feed ───────────────────────────────────────────────────────────────────────

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

export function SignalFeed() {
  const recentSignals  = useStore((s) => s.recentSignals);
  const selectedSymbol = useStore((s) => s.selectedSymbol);

  const filteredSignals = useMemo(
    // 2026-06-04: hide wall-broken-fade from the panel (user request, live trading).
    () => recentSignals.filter((s) => s.symbol === selectedSymbol && (s as any).ruleId !== 'wall-broken-fade'),
    [recentSignals, selectedSymbol]
  );

  const [testPrice, setTestPrice] = useState('29151');
  const [testDiscord, setTestDiscord] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-1)', borderLeft: '1px solid var(--border)' }}>
      <div style={{
        padding: '6px 12px',
        borderBottom: '1px solid var(--border)',
        fontSize: 11, letterSpacing: 1, color: 'var(--text-2)', textTransform: 'uppercase',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6,
      }}>
        <span>Signals · {selectedSymbol}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            value={testPrice}
            onChange={e => setTestPrice(e.target.value)}
            style={{
              width: 70, fontSize: 11, padding: '1px 4px', background: 'var(--bg-3)',
              border: '1px solid var(--border-strong)', color: 'var(--text-1)', borderRadius: 3,
            }}
          />
          <button onClick={() => injectTestSignals(parseFloat(testPrice), 'long', testDiscord)} style={{
            fontSize: 9, padding: '2px 5px', cursor: 'pointer',
            background: 'var(--bg-3)', border: '1px solid var(--long)',
            color: 'var(--long)', borderRadius: 3, letterSpacing: 0.5,
          }}>L</button>
          <button onClick={() => injectTestSignals(parseFloat(testPrice), 'short', testDiscord)} style={{
            fontSize: 9, padding: '2px 5px', cursor: 'pointer',
            background: 'var(--bg-3)', border: '1px solid var(--short)',
            color: 'var(--short)', borderRadius: 3, letterSpacing: 0.5,
          }}>S</button>
          <button
            onClick={() => setTestDiscord(d => !d)}
            title="Also send to Discord"
            style={{
              fontSize: 9, padding: '2px 5px', cursor: 'pointer', borderRadius: 3,
              background: testDiscord ? '#5865f2' : 'var(--bg-3)',
              border: `1px solid ${testDiscord ? '#5865f2' : 'var(--border-strong)'}`,
              color: testDiscord ? '#fff' : 'var(--text-2)', letterSpacing: 0.5,
            }}>D</button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {filteredSignals.length === 0 && (
          <div style={{ padding: '12px 4px', color: 'var(--text-2)', fontSize: 11 }}>
            no signals yet — observe-only mode
          </div>
        )}
        {filteredSignals.map((s, i) => <SignalCard key={`${s.ts}-${i}`} sig={s} />)}
      </div>
    </div>
  );
}

// ── Compact chart overlay card (used by Chart.tsx) ────────────────────────────

export function SignalChartCard({ sig }: { sig: ConfluenceSignal }) {
  const tone      = sig.direction === 'long' ? 'var(--long)' : 'var(--short)';
  const tier      = sig.rsTier;
  const name      = signalDisplayName(sig.ruleId, sig.direction);
  const labelLine = buildLabelLine(sig);
  const rationale = stripRationalePrefix(sig.rationale ?? '');
  const deadZone  = (sig as any).deadZone === true;

  return (
    <div style={{
      padding: '9px 13px',
      background: 'transparent',
      borderRadius: '0 4px 4px 0',
      borderLeft: `2px solid ${tone}`,
      minWidth: 240,
      maxWidth: 320,
      pointerEvents: 'none',
    }}>
      {/* Row 1: NQ.LONG.EXPL  91  [DT]  |  12:34:01 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span className="mono" style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
          <span style={{ color: tone, fontWeight: 700, fontSize: 13, letterSpacing: 0.4 }}>
            {sig.symbol}.{sig.direction.toUpperCase()}.{name.toUpperCase()}
            <span style={{ color: 'var(--text-0, #e8e8ec)', fontWeight: 600 }}>{'  '}{sig.score}</span>
          </span>
          {deadZone && (
            <span style={{
              fontSize: 10, fontWeight: 800, letterSpacing: 0.8,
              color: '#f59e0b', background: 'rgba(245,158,11,0.12)',
              padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(245,158,11,0.35)',
            }}>DT</span>
          )}
        </span>
        <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', flexShrink: 0 }}>
          {fmtTime(sig.ts)}
        </span>
      </div>

      {/* Row 2a: [orbs] PRIME */}
      {tier && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 7 }}>
          <RSOrbs tier={tier} />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, color: TIER_COLOR[tier] }}>
            {tier}
          </span>
        </div>
      )}

      {/* Row 2b: level=50 | context=28 | confirm=10 */}
      {sig.rsComponents && (
        <div style={{ marginTop: 3 }}>
          <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)' }}>
            level={sig.rsComponents.level} | context={sig.rsComponents.context} | confirm={sig.rsComponents.confirm}
          </span>
        </div>
      )}

      {/* Row 3: RS 88 · BZB · First test · GM bull · DD-long · BLD */}
      {labelLine && (
        <div style={{ marginTop: 5, fontSize: 12, fontWeight: 600, color: 'var(--text-1)', letterSpacing: 0.2, lineHeight: 1.4 }}>
          {labelLine}
        </div>
      )}

      {/* Row 4: MHP ±N▲▼  HP ±N▲▼  Res ±N▲▼ */}
      {sig.resContext && (
        <ResConviction resContext={sig.resContext} direction={sig.direction} />
      )}

      {/* Row 5: rationale */}
      {rationale && (
        <div style={{ marginTop: 5, fontSize: 12, fontWeight: 500, color: 'var(--text-1)', lineHeight: 1.5 }}>
          {rationale}
        </div>
      )}
    </div>
  );
}
