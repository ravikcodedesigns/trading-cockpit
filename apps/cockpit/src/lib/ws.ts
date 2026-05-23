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

interface CockpitStore {
  wsStatus: 'connecting' | 'open' | 'closed';
  connections: Partial<Record<SourceName, ConnectionStatus>>;
  levelsByDay: Record<string, Partial<Record<Sym, DailyLevels>>>;
  flashAlpha: Partial<Record<Sym, FlashAlphaSnapshot>>;
  recentEvents: AggregatorEvent[];
  recentSignals: ConfluenceSignal[];
  eventsLogged: number;
  uptimeSec: number;
  selectedSymbol: Sym;
  selectedTimeframe: 1 | 5 | 15;
  soundOn: boolean;
  setSymbol: (s: Sym) => void;
  setTimeframe: (t: 1 | 5 | 15) => void;
  setSoundOn: (v: boolean) => void;
}

const MAX_EVENTS = 200;

export const useStore = create<CockpitStore>((set) => ({
  wsStatus: 'connecting',
  connections: {},
  levelsByDay: {},
  flashAlpha: {},
  recentEvents: [],
  recentSignals: [],
  eventsLogged: 0,
  uptimeSec: 0,
  selectedSymbol: 'NQ',
  selectedTimeframe: 1,
  soundOn: true,
  setSymbol: (s) => set({ selectedSymbol: s }),
  setTimeframe: (t) => set({ selectedTimeframe: t }),
  setSoundOn: (v) => set({ soundOn: v }),
}));


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
        updates.recentSignals = [msg.event, ...s.recentSignals].slice(0, 500);
      }
      return updates;
    });
  } else if (msg.type === 'signal') {
    const sig = msg.signal;
    useStore.setState((s) => ({
      recentSignals: [sig, ...s.recentSignals].slice(0, 500),
    }));
  } else if (msg.type === 'connection') {
    useStore.setState((s) => ({
      connections: { ...s.connections, [msg.source]: msg.status },
    }));
  }
}

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let backoffMs = 500;

// Heartbeat — detects silent dead connections that Vite's WS proxy doesn't
// close properly after a kill-9 restart of the aggregator.
const PING_INTERVAL_MS = 5_000;
const PONG_TIMEOUT_MS  = 8_000;
let pingTimer:  number | null = null;
let pongTimer:  number | null = null;

function startHeartbeat() {
  stopHeartbeat();
  pingTimer = window.setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'ping' }));
    pongTimer = window.setTimeout(() => {
      // No pong — connection silently dead; close so onclose fires and reconnect kicks in
      socket?.close();
    }, PONG_TIMEOUT_MS);
  }, PING_INTERVAL_MS);
}

function stopHeartbeat() {
  if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; }
  if (pongTimer !== null) { clearTimeout(pongTimer);  pongTimer = null; }
}

// When a backgrounded tab becomes visible again, Chrome may have throttled
// the heartbeat timers entirely — the socket can be silently dead with no
// reconnect ever triggered. Force a liveness check on tab focus.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        connect();
      } else if (socket.readyState === WebSocket.OPEN) {
        // Socket looks alive — send a ping to confirm; pong timeout will
        // close and reconnect if the server is actually gone.
        socket.send(JSON.stringify({ type: 'ping' }));
        if (pongTimer !== null) clearTimeout(pongTimer);
        pongTimer = window.setTimeout(() => { socket?.close(); }, PONG_TIMEOUT_MS);
      }
    }
  });
}

export function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  useStore.setState({ wsStatus: 'connecting' });
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${window.location.host}/ws/cockpit`;
  socket = new WebSocket(url);

  socket.onopen = () => {
    backoffMs = 500;
    useStore.setState({ wsStatus: 'open' });
    startHeartbeat();
  };

  socket.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as CockpitMessage;
      if ((msg as any).type === 'pong') {
        // Pong received — connection alive, cancel the timeout
        if (pongTimer !== null) { clearTimeout(pongTimer); pongTimer = null; }
        return;
      }
      applyMessage(msg);
    } catch {
      // ignore malformed
    }
  };

  socket.onclose = () => {
    stopHeartbeat();
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
