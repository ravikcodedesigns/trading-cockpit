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
  levels: Partial<Record<Sym, DailyLevels>>;
  flashAlpha: Partial<Record<Sym, FlashAlphaSnapshot>>;
  recentEvents: AggregatorEvent[];
  recentSignals: ConfluenceSignal[];
  eventsLogged: number;
  uptimeSec: number;
  selectedSymbol: Sym;
  setSymbol: (s: Sym) => void;
}

const MAX_EVENTS = 200;

export const useStore = create<CockpitStore>((set) => ({
  wsStatus: 'connecting',
  connections: {},
  levels: {},
  flashAlpha: {},
  recentEvents: [],
  recentSignals: [],
  eventsLogged: 0,
  uptimeSec: 0,
  selectedSymbol: 'NQ',
  setSymbol: (s) => set({ selectedSymbol: s }),
}));

function applyMessage(msg: CockpitMessage) {
  if (msg.type === 'snapshot') {
    useStore.setState({
      connections: msg.state.connections,
      levels: msg.state.levels,
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
        updates.levels = { ...s.levels, [msg.event.symbol]: msg.event };
      } else if (msg.event.source === 'flashalpha' && msg.event.type === 'snapshot') {
        updates.flashAlpha = { ...s.flashAlpha, [msg.event.symbol]: msg.event };
      } else if (msg.event.source === 'rules' && msg.event.type === 'confluence') {
        updates.recentSignals = [msg.event, ...s.recentSignals].slice(0, 50);
      }
      return updates;
    });
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
