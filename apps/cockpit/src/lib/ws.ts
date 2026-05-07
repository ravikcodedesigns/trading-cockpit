import { create } from 'zustand';
import type {
  AggregatorEvent,
  CockpitMessage,
  ConfluenceSignal,
  ConnectionStatus,
  DailyLevels,
  FlashAlphaSnapshot,
  SourceName,
  Symbol as Sym,
} from '@trading/contracts';

export interface PostEntryMarker {
  id: string;
  symbol: Sym;
  time: number;
  label: string;
  color: string;
  checkpoint: '90s' | '5m';
}

interface PendingCheck {
  signal: ConfluenceSignal;
  entryPrice: number;
  entryTs: number;
}

interface CockpitStore {
  wsStatus: 'connecting' | 'open' | 'closed';
  connections: Partial<Record<SourceName, ConnectionStatus>>;
  levelsByDay: Record<string, Partial<Record<Sym, DailyLevels>>>;
  flashAlpha: Partial<Record<Sym, FlashAlphaSnapshot>>;
  recentEvents: AggregatorEvent[];
  recentSignals: ConfluenceSignal[];
  postEntryMarkers: PostEntryMarker[];
  eventsLogged: number;
  uptimeSec: number;
  selectedSymbol: Sym;
  selectedTimeframe: 1 | 5 | 15;
  setSymbol: (s: Sym) => void;
  setTimeframe: (t: 1 | 5 | 15) => void;
  addPostEntryMarker: (m: PostEntryMarker) => void;
}

const MAX_EVENTS = 200;
const MAX_POST_ENTRY_MARKERS = 200;

export const useStore = create<CockpitStore>((set) => ({
  wsStatus: 'connecting',
  connections: {},
  levelsByDay: {},
  flashAlpha: {},
  recentEvents: [],
  recentSignals: [],
  postEntryMarkers: [],
  eventsLogged: 0,
  uptimeSec: 0,
  selectedSymbol: 'NQ',
  selectedTimeframe: 1,
  setSymbol: (s) => set({ selectedSymbol: s }),
  setTimeframe: (t) => set({ selectedTimeframe: t }),
  addPostEntryMarker: (m) =>
    set((s) => ({
      postEntryMarkers: [m, ...s.postEntryMarkers]
        .filter((x, i, arr) => arr.findIndex(y => y.id === x.id) === i)
        .slice(0, MAX_POST_ENTRY_MARKERS),
    })),
}));

const _pendingChecks = new Map<string, PendingCheck>();

function extractEntryPrice(rationale: string): number | null {
  const m = rationale?.match(/absorbed at ([0-9.]+)/);
  return m ? parseFloat(m[1]) : null;
}

async function getCurrentPrice(symbol: Sym): Promise<number | null> {
  try {
    const res = await fetch('http://127.0.0.1:8787/snapshot');
    const data = await res.json();
    const events: AggregatorEvent[] = data?.state?.recentEvents ?? [];
    const bars = events.filter((e: any) => e.symbol === symbol && e.type === 'bar');
    if (bars.length > 0) {
      const last = bars[bars.length - 1] as any;
      return last.close ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

function classifyAt90s(mv90: number, adv90: number): { label: string; color: string } {
  if (mv90 > 10 && adv90 < 5)  return { label: 'MID',   color: '#3b82f6' };
  if (mv90 > 10 && adv90 >= 5) return { label: 'FAST?', color: '#f59e0b' };
  if (adv90 > mv90 && adv90 > 5) return { label: 'HOLD', color: '#a855f7' };
  return { label: 'SLOW?', color: '#6366f1' };
}

function classifyAt5m(
  mv5: number, adv5: number,
  mv90: number, preVel: number
): { label: string; color: string } {
  if (mv5 >= 20) {
    if (mv90 > 10) return { label: 'FAST', color: '#10b981' };
    return { label: 'MID', color: '#3b82f6' };
  }
  if (adv5 > 15) return { label: 'FAIL', color: '#ef4444' };
  if (adv5 <= 15 && preVel < -5) return { label: 'SLOW', color: '#f59e0b' };
  return { label: 'WAIT', color: '#6b7280' };
}

function schedulePostEntryChecks(signal: ConfluenceSignal, entryPrice: number) {
  const key = `${signal.ts}`;
  if (_pendingChecks.has(key)) return;
  _pendingChecks.set(key, { signal, entryPrice, entryTs: signal.ts });

  let mv90 = 0;
  let adv90 = 0;

  setTimeout(async () => {
    const price = await getCurrentPrice(signal.symbol);
    if (price === null) return;
    mv90  = Math.max(0, entryPrice - price);
    adv90 = Math.max(0, price - entryPrice);
    const { label, color } = classifyAt90s(mv90, adv90);
    useStore.getState().addPostEntryMarker({
      id: `${key}-90s`,
      symbol: signal.symbol,
      time: Math.floor((signal.ts + 30_000) / 60_000) * 60,
      label, color, checkpoint: '90s',
    });
  }, 30_000);

  setTimeout(async () => {
    const price = await getCurrentPrice(signal.symbol);
    if (price === null) return;
    const mv5  = Math.max(0, entryPrice - price);
    const adv5 = Math.max(0, price - entryPrice);
    const preVel = (signal as any).preVelocity ?? -5;
    const { label, color } = classifyAt5m(mv5, adv5, mv90, preVel);
    useStore.getState().addPostEntryMarker({
      id: `${key}-5m`,
      symbol: signal.symbol,
      time: Math.floor((signal.ts + 120_000) / 60_000) * 60,
      label, color, checkpoint: '5m',
    });
    _pendingChecks.delete(key);
  }, 120_000);
}

function isMonitoredSignal(sig: ConfluenceSignal): boolean {
  const ext = sig as any;
  return (
    sig.ruleId === 'absorption' &&
    sig.direction === 'short' &&
    ext.conviction === '++' &&
    sig.score >= 65
  );
}

async function fetchHistoricalPostEntryMarkers(symbol: Sym) {
  try {
    const res = await fetch(
      `http://127.0.0.1:8787/history/post-entry-markers?symbol=${symbol}`
    );
    const data = await res.json();
    const markers: PostEntryMarker[] = (data.markers ?? []).map((m: any) => ({
      id: m.id,
      symbol: m.symbol as Sym,
      time: m.time,
      label: m.label,
      color: m.color,
      checkpoint: m.checkpoint,
    }));
    useStore.setState((s) => ({
      postEntryMarkers: [...markers, ...s.postEntryMarkers]
        .filter((m, i, arr) => arr.findIndex(x => x.id === m.id) === i)
        .slice(0, MAX_POST_ENTRY_MARKERS),
    }));
  } catch {
    // silently fail
  }
}

function applyMessage(msg: CockpitMessage) {
  if (msg.type === 'snapshot') {
    useStore.setState({
      connections: msg.state.connections,
      levelsByDay: msg.state.levelsByDay,
      flashAlpha: msg.state.flashAlpha,
      recentEvents: msg.state.recentEvents,
      recentSignals: msg.state.recentSignals,
      eventsLogged: msg.state.eventsLogged,
      uptimeSec: msg.state.uptimeSec,
    });
  } else if (msg.type === 'event') {
    useStore.setState((s) => {
      const events = [...s.recentEvents, msg.event].slice(-MAX_EVENTS);
      const updates: Partial<CockpitStore> = {
        recentEvents: events,
        eventsLogged: s.eventsLogged + 1,
      };
      if (msg.event.source === 'levels' && msg.event.type === 'daily') {
        const dayMap = s.levelsByDay[msg.event.tradingDay] ?? {};
        const updatedDay = { ...dayMap, [msg.event.symbol]: msg.event };
        updates.levelsByDay = { ...s.levelsByDay, [msg.event.tradingDay]: updatedDay };
      } else if (msg.event.source === 'flashalpha' && msg.event.type === 'snapshot') {
        updates.flashAlpha = { ...s.flashAlpha, [msg.event.symbol]: msg.event };
      } else if (msg.event.source === 'rules' && msg.event.type === 'confluence') {
        updates.recentSignals = [msg.event, ...s.recentSignals].slice(0, 50);
      }
      return updates;
    });
  } else if (msg.type === 'signal') {
    const sig = msg.signal;
    useStore.setState((s) => ({
      recentSignals: [sig, ...s.recentSignals].slice(0, 50),
    }));
    if (isMonitoredSignal(sig)) {
      const entryPrice = extractEntryPrice((sig as any).rationale ?? '');
      if (entryPrice) schedulePostEntryChecks(sig, entryPrice);
    }
  } else if (msg.type === 'connection') {
    useStore.setState((s) => ({
      connections: { ...s.connections, [msg.source]: msg.status },
    }));
  }
}

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let backoffMs = 500;

export function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  useStore.setState({ wsStatus: 'connecting' });
  const url = `ws://${window.location.host}/ws/cockpit`;
  socket = new WebSocket(url);

  socket.onopen = () => {
    backoffMs = 500;
    useStore.setState({ wsStatus: 'open' });
    fetchHistoricalPostEntryMarkers('NQ');
    fetchHistoricalPostEntryMarkers('ES');
  };

  socket.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as CockpitMessage;
      applyMessage(msg);
    } catch {
      // ignore malformed
    }
  };

  socket.onclose = () => {
    useStore.setState({ wsStatus: 'closed' });
    socket = null;
    if (reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      backoffMs = Math.min(backoffMs * 1.6, 8000);
      connect();
    }, backoffMs);
  };

  socket.onerror = () => {
    socket?.close();
  };
}
