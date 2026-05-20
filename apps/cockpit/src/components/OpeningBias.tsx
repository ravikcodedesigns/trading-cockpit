import { useEffect, useState } from 'react';

interface BarWithCvd {
  ts: number;
  open: number; high: number; low: number; close: number;
  buyVolume: number; sellVolume: number;
}

interface Props {
  symbol: string;
  barHistoryRef: { current: Record<string, Map<number, { open: number; high: number; low: number; close: number }>> };
  barsVersion: number;
}

interface BiasResult {
  gapPts: number | null;
  bar1Pos: number | null;
  cvd3: number | null;
  bias: 'LONG' | 'SHORT' | 'NEUTRAL' | null;
}

function getRthOpenTimes(): { rthOpenSec: number; rthOpenMs: number } {
  const now = Date.now();
  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
  const [mm, dd, yyyy] = datePart.split('/');
  const probeHour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', hour12: false,
    }).format(new Date(now)),
    10
  );
  const utcHour = new Date(now).getUTCHours();
  const offsetH = ((utcHour - probeHour) + 24) % 24;
  const offset = offsetH === 4 ? '-04:00' : '-05:00';
  const rthOpenMs = Date.parse(`${yyyy}-${mm}-${dd}T09:30:00${offset}`);
  return { rthOpenSec: rthOpenMs / 1000, rthOpenMs };
}

function getCurrentETMinutes(): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => p.find(x => x.type === t)?.value ?? '0';
  return parseInt(g('hour'), 10) * 60 + parseInt(g('minute'), 10);
}

function computeBias(
  bars: BarWithCvd[],
  history: Map<number, { open: number; high: number; low: number; close: number }>,
  rthOpenSec: number,
  rthOpenMs: number,
): BiasResult {
  // Today's first 3 opening bars (9:30, 9:31, 9:32 ET)
  const todayBars = bars
    .filter(b => b.ts >= rthOpenMs && b.ts < rthOpenMs + 3 * 60_000)
    .sort((a, b) => a.ts - b.ts);

  // Prior close: most recent bar whose UTC hour is in 19–21 UTC (= 3–5 PM EDT),
  // from any day before today's RTH open. This reliably finds the previous
  // trading day's RTH close (~4:14 PM ET) even across weekends (Mon → Fri).
  // We avoid a fixed-hour lookback because Monday needs 65h back while
  // Tuesday–Friday only needs 17h; the UTC-hour filter handles both.
  let priorCloseTs = -1;
  let priorClose: number | null = null;
  for (const [ts, bar] of history) {
    if (ts >= rthOpenSec) continue;
    const utcHour = Math.floor(ts % 86400 / 3600);
    if (utcHour >= 19 && utcHour <= 21 && ts > priorCloseTs) {
      priorCloseTs = ts;
      priorClose = bar.close;
    }
  }

  const bar1 = todayBars[0] ?? null;
  const bar2 = todayBars[1] ?? null;
  const bar3 = todayBars[2] ?? null;

  const gapPts = priorClose !== null && bar1 !== null ? bar1.open - priorClose : null;

  const bar1Pos = bar1 !== null
    ? (bar1.high !== bar1.low ? (bar1.close - bar1.low) / (bar1.high - bar1.low) : 0.5)
    : null;

  const cvd3 = bar1 && bar2 && bar3
    ? [bar1, bar2, bar3].reduce((s, b) => s + (b.buyVolume - b.sellVolume), 0)
    : null;

  const gapSign  = gapPts  === null ? 0 : gapPts  >  10 ? 1 : gapPts  < -10 ? -1 : 0;
  const bar1Sign = bar1Pos === null ? 0 : bar1Pos >= 0.65 ? 1 : bar1Pos <= 0.35 ? -1 : 0;
  const cvd3Sign = cvd3    === null ? 0 : cvd3    > 800   ? 1 : cvd3    < -800   ? -1 : 0;

  const score = gapSign + bar1Sign + cvd3Sign;
  const bias: BiasResult['bias'] = cvd3 === null ? null
    : score >= 2 ? 'LONG' : score <= -2 ? 'SHORT' : 'NEUTRAL';

  return { gapPts, bar1Pos, cvd3, bias };
}

export function OpeningBias({ symbol, barHistoryRef, barsVersion }: Props) {
  const [result, setResult] = useState<BiasResult>({
    gapPts: null, bar1Pos: null, cvd3: null, bias: null,
  });

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(
          `/history/bars?symbol=${symbol}&minutes=600&interval=1`
        );
        if (!res.ok || cancelled) return;
        const data = await res.json() as { bars: BarWithCvd[] };
        if (cancelled) return;

        const { rthOpenSec, rthOpenMs } = getRthOpenTimes();
        const history = barHistoryRef.current[symbol] ?? new Map();
        setResult(computeBias(data.bars, history, rthOpenSec, rthOpenMs));
      } catch { /* network error or abort — silent */ }
    };

    run();

    // Poll every 30s during the opening window (9:28–9:37 ET) to pick up
    // the bar1 close (available at 9:31) and CVD3 (available at 9:33)
    // as each minute closes. Stop once we're past 9:37.
    const etMin = getCurrentETMinutes();
    let intervalId: ReturnType<typeof setInterval> | undefined;
    if (etMin >= 568 && etMin <= 577) {
      intervalId = setInterval(run, 30_000);
    }

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [symbol, barsVersion]);

  const { gapPts, bar1Pos, cvd3, bias } = result;
  if (gapPts === null && bar1Pos === null) return null;

  const color = (v: number, hi: number, lo: number) =>
    v > hi ? '#2bb673' : v < lo ? '#d64545' : '#a8a8b0';
  const arrow = (v: number, hi: number, lo: number) =>
    v > hi ? '↑' : v < lo ? '↓' : '→';

  const gapC  = gapPts  !== null ? color(gapPts,  10,  -10)  : '#a8a8b0';
  const gapA  = gapPts  !== null ? arrow(gapPts,  10,  -10)  : '';
  const posC  = bar1Pos !== null ? color(bar1Pos, 0.65, 0.35) : '#a8a8b0';
  const posA  = bar1Pos !== null ? arrow(bar1Pos, 0.65, 0.35) : '';
  const cvdC  = cvd3    !== null ? color(cvd3,    800, -800)  : '#a8a8b0';
  const cvdA  = cvd3    !== null ? arrow(cvd3,    800, -800)  : '';
  const biasC = bias === 'LONG' ? '#2bb673' : bias === 'SHORT' ? '#d64545' : '#a8a8b0';
  const biasI = bias === 'LONG' ? '▲' : bias === 'SHORT' ? '▼' : '—';

  return (
    <div style={{
      position: 'absolute', top: 48, left: 8, zIndex: 10,
      background: 'rgba(10,10,11,0.85)',
      backdropFilter: 'blur(4px)',
      border: '1px solid #28282f',
      borderRadius: 4,
      padding: '5px 9px',
      fontFamily: 'IBM Plex Mono, monospace',
      fontSize: 10,
      color: '#a8a8b0',
      lineHeight: 1.75,
      pointerEvents: 'none',
      minWidth: 185,
    }}>
      {gapPts !== null && (
        <div>
          <span style={{ color: '#4a5568', marginRight: 6 }}>09:29</span>
          <span style={{ color: gapC }}>
            {gapA} Gap {gapPts >= 0 ? '+' : ''}{gapPts.toFixed(2)}pts
          </span>
        </div>
      )}
      {bar1Pos !== null && (
        <div>
          <span style={{ color: '#4a5568', marginRight: 6 }}>09:31</span>
          <span style={{ color: posC }}>
            {posA} Bar1 {(bar1Pos * 100).toFixed(0)}% in range
          </span>
        </div>
      )}
      {cvd3 !== null && (
        <div>
          <span style={{ color: '#4a5568', marginRight: 6 }}>09:33</span>
          <span style={{ color: cvdC }}>
            {cvdA} CVD3 {cvd3 >= 0 ? '+' : ''}{cvd3.toLocaleString()}ct
          </span>
        </div>
      )}
      {bias !== null && (
        <div style={{
          marginTop: 3, borderTop: '1px solid #28282f', paddingTop: 3,
          fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
        }}>
          <span style={{ color: biasC }}>{biasI} BIAS: {bias}</span>
        </div>
      )}
    </div>
  );
}
