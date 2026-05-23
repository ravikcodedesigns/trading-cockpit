import { useState } from 'react';

export type FactorDir = 'bull' | 'bear' | null;

export type RegimeLabel =
  | 'BULL STRONG'
  | 'BULL WEAK'
  | 'NEUTRAL'
  | 'BEAR WEAK'
  | 'BEAR STRONG';

export type CheckpointData = {
  time: string;
  etMin: number;
  label: RegimeLabel | null;
  factors: { name: string; dir: FactorDir }[];
};

function labelColor(label: RegimeLabel | null): string {
  if (!label) return '#555';
  if (label === 'BULL STRONG') return '#2bb673';
  if (label === 'BULL WEAK')   return '#7ece8c';
  if (label === 'NEUTRAL')     return '#a8a8b0';
  if (label === 'BEAR WEAK')   return '#e88080';
  return '#d64545';
}

function factorChar(dir: FactorDir): string {
  if (dir === 'bull') return '▲';
  if (dir === 'bear') return '▼';
  return '·';
}

function factorColor(dir: FactorDir): string {
  if (dir === 'bull') return '#2bb673';
  if (dir === 'bear') return '#d64545';
  return '#3a3a45';
}

function FactorArrow({ name, dir }: { name: string; dir: FactorDir }) {
  const [hovered, setHovered] = useState(false);
  return (
    <span
      style={{ position: 'relative', cursor: 'default' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {hovered && (
        <span style={{
          position: 'absolute',
          bottom: 'calc(100% + 4px)',
          left: '50%',
          transform: 'translateX(-50%)',
          background: '#1e1e28',
          border: '1px solid #444',
          borderRadius: 3,
          padding: '2px 6px',
          fontSize: 10,
          fontWeight: 600,
          color: '#d0d0d8',
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          zIndex: 200,
        }}>
          {name}
        </span>
      )}
      <span style={{ color: factorColor(dir), fontSize: 13 }}>
        {factorChar(dir)}
      </span>
    </span>
  );
}

export function RegimePanel({ checkpoints }: { checkpoints: CheckpointData[] }) {
  if (checkpoints.length === 0) return null;

  return (
    <div style={{
      background: 'rgba(10,10,12,0.95)',
      border: '1px dotted #444',
      borderRadius: 4,
      fontFamily: 'IBM Plex Mono, monospace',
      fontSize: 11,
      fontWeight: 700,
      color: '#d0d0d8',
      overflow: 'visible',
      minWidth: 230,
    }}>
      {/* header */}
      <div style={{
        display: 'grid', gridTemplateColumns: '40px 100px 1fr',
        padding: '5px 10px', borderBottom: '1px dotted #444',
        color: '#888', fontSize: 10, fontWeight: 700, letterSpacing: 0.6,
      }}>
        <span>TIME</span>
        <span>REGIME</span>
        <span>FACTORS</span>
      </div>

      {checkpoints.map(cp => (
        <div key={cp.time} style={{
          display: 'grid', gridTemplateColumns: '40px 100px 1fr',
          padding: '4px 10px',
          borderBottom: '1px dotted #333',
          opacity: cp.label !== null ? 1 : 0.35,
          alignItems: 'center',
          overflow: 'visible',
        }}>
          <span style={{ color: '#4a5568' }}>{cp.time}</span>
          <span style={{ color: labelColor(cp.label), fontWeight: 700 }}>
            {cp.label ?? '—'}
          </span>
          <span style={{ display: 'flex', gap: 8, overflow: 'visible' }}>
            {cp.factors.map(f => (
              <FactorArrow key={f.name} name={f.name} dir={f.dir} />
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
