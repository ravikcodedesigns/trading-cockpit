type Cell = 'go' | 'skip' | 'no-data';

const ROWS: { window: string; lo: number; hi: number; cf: Cell; cfs: Cell; expl: Cell; abso: Cell }[] = [
  { window: '09:30–09:53', lo: 570, hi: 594, cf: 'skip', cfs: 'go',      expl: 'go',   abso: 'go'   },
  { window: '09:54–10:29', lo: 594, hi: 630, cf: 'go',   cfs: 'go',      expl: 'go',   abso: 'skip' },
  { window: '10:30–11:29', lo: 630, hi: 690, cf: 'go',   cfs: 'go',      expl: 'go',   abso: 'go'   },
  { window: '11:30–12:59', lo: 690, hi: 780, cf: 'go',   cfs: 'go',      expl: 'go',   abso: 'go'   },
  { window: '13:00–14:29', lo: 780, hi: 870, cf: 'skip', cfs: 'skip',    expl: 'skip', abso: 'skip' },
  { window: '14:30–15:59', lo: 870, hi: 960, cf: 'skip', cfs: 'no-data', expl: 'go',   abso: 'go'   },
];

function getEtMin() {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  return parseInt(p.find(x => x.type === 'hour')?.value ?? '0', 10) * 60
       + parseInt(p.find(x => x.type === 'minute')?.value ?? '0', 10);
}

function TradeCell({ val }: { val: Cell }) {
  if (val === 'go')   return <span style={{ color: '#2bb673', fontWeight: 800, fontSize: 14 }}>✓</span>;
  if (val === 'skip') return <span style={{ color: '#e05252', fontWeight: 800, fontSize: 14 }}>✗</span>;
  return <span style={{ color: '#444' }}>—</span>;
}

export function TradeNoTradePopover({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const now = getEtMin();
  const activeIdx = ROWS.findIndex(r => now >= r.lo && now < r.hi);
  const activeRow = activeIdx >= 0 ? ROWS[activeIdx] : null;

  const cells = activeRow ? [activeRow.cf, activeRow.cfs, activeRow.expl, activeRow.abso] : [];
  const allSkip = cells.length > 0 && cells.every(c => c !== 'go');
  const anySkip = cells.some(c => c === 'skip');
  const btnColor = allSkip ? '#e05252' : anySkip ? '#f59e0b' : '#2bb673';

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={onToggle}
        style={{
          padding: '3px 10px',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.5,
          cursor: 'pointer',
          border: `1px solid ${btnColor}55`,
          borderRadius: 3,
          background: open ? `${btnColor}1a` : 'rgba(10,10,12,0.85)',
          color: btnColor,
          fontFamily: 'IBM Plex Mono, monospace',
          transition: 'background 0.15s, color 0.15s',
          whiteSpace: 'nowrap',
        }}
      >
        TRADE/NO TRADE
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 3px)',
          left: 0,
          zIndex: 100,
          background: 'rgba(10,10,12,0.95)',
          border: '1px dotted #444',
          borderRadius: 4,
          fontFamily: 'IBM Plex Mono, monospace',
          fontSize: 11,
          fontWeight: 700,
          color: '#d0d0d8',
          overflow: 'hidden',
          minWidth: 340,
        }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '96px repeat(4, 1fr)',
            padding: '5px 10px', borderBottom: '1px dotted #444',
            color: '#888', fontSize: 10, fontWeight: 700, letterSpacing: 0.6,
          }}>
            <span>WINDOW</span>
            <span style={{ textAlign: 'center' }}>CF↑</span>
            <span style={{ textAlign: 'center' }}>CF↓</span>
            <span style={{ textAlign: 'center' }}>EXPL↑</span>
            <span style={{ textAlign: 'center' }}>ABSO↑</span>
          </div>

          {ROWS.map((row, i) => {
            const isActive = i === activeIdx;
            return (
              <div key={row.window} style={{
                display: 'grid', gridTemplateColumns: '96px repeat(4, 1fr)',
                padding: '4px 10px',
                borderBottom: '1px dotted #333',
                background: isActive ? 'rgba(90,155,255,0.13)' : 'transparent',
                borderLeft: isActive ? '3px solid #5a9bff' : '3px solid transparent',
                alignItems: 'center',
              }}>
                <span style={{ color: isActive ? '#7ab8ff' : '#999', fontWeight: isActive ? 800 : 700 }}>
                  {row.window}
                </span>
                {(['cf', 'cfs', 'expl', 'abso'] as const).map(k => (
                  <span key={k} style={{ textAlign: 'center' }}>
                    <TradeCell val={row[k]} />
                  </span>
                ))}
              </div>
            );
          })}

          <div style={{
            padding: '4px 10px 5px', borderTop: '1px dotted #444',
            color: '#777', fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
          }}>
            SL: CF↑ 55 · CF↓ 105 · EXPL 70 · ABSO 140  |  TP: 80 pts
          </div>
        </div>
      )}
    </div>
  );
}
