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
  // Whether we've received any event in the last 60 seconds. Used by the
  // status bar to surface "stream might be dead" without a hard disconnect.
  isStale: boolean;
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
  isStale: false,
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

// --- Liveness tracking ---
// We track the timestamp of the last useful inbound message. If nothing
// arrives for STALE_THRESHOLD_MS, we treat the stream as stale even if
// the WebSocket is technically still open. If nothing arrives for
// FORCE_RECONNECT_MS, we forcibly reconnect.
const STALE_THRESHOLD_MS = 60_000;        // surface warning to UI
const FORCE_RECONNECT_MS = 90_000;        // tear down + reconnect
const PING_INTERVAL_MS = 15_000;          // app-level ping cadence
let lastInboundAt = Date.now();

function noteInbound() {
  lastInboundAt = Date.now();
  // Clear stale flag immediately on any inbound message.
  if (useStore.getState().isStale) {
    useStore.setState({ isStale: false });
  }
}

function applyMessage(msg: CockpitMessage) {
  noteInbound();

  // Pong is liveness-only; no state mutation needed.
  // (Cast through unknown because pong isn't in the discriminated union;
  // we treat it as a control frame.)
  if ((msg as unknown as { type?: string }).type === 'pong') return;

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
  } else if (msg.type === 'signal') {
    useStore.setState((s) => ({
      recentSignals: [msg.signal, ...s.recentSignals].slice(0, 50),
    }));
  } else if (msg.type === 'connection') {
    useStore.setState((s) => ({
      connections: { ...s.connections, [msg.source]: msg.status },
    }));
  }
}

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let livenessTimer: number | null = null;
let pingTimer: number | null = null;
let backoffMs = 500;

function clearTimers() {
  if (reconnectTimer !== null) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (livenessTimer !== null) { window.clearInterval(livenessTimer); livenessTimer = null; }
  if (pingTimer !== null) { window.clearInterval(pingTimer); pingTimer = null; }
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    backoffMs = Math.min(backoffMs * 1.6, 8000);
    connect();
  }, backoffMs);
}

function startLivenessChecks() {
  // Periodically check inbound recency.
  livenessTimer = window.setInterval(() => {
    const idleMs = Date.now() - lastInboundAt;
    if (idleMs > STALE_THRESHOLD_MS && !useStore.getState().isStale) {
      useStore.setState({ isStale: true });
    }
    if (idleMs > FORCE_RECONNECT_MS && socket) {
      // Forcibly close to trigger reconnect path. Some browsers don't fire
      // `onclose` when the WS dies silently (e.g. throttled background tab,
      // Wi-Fi flicker); calling close() guarantees the cleanup runs.
      console.warn(`[ws] no inbound for ${idleMs}ms, forcing reconnect`);
      try { socket.close(); } catch { /* ignore */ }
    }
  }, 5_000);

  // App-level ping. Aggregator echoes pong, which counts as inbound.
  pingTimer = window.setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
    }
  }, PING_INTERVAL_MS);
}

export function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  useStore.setState({ wsStatus: 'connecting' });
  const url = `ws://${window.location.host}/ws/cockpit`;
  socket = new WebSocket(url);

  socket.onopen = () => {
    backoffMs = 500;
    lastInboundAt = Date.now();
    useStore.setState({ wsStatus: 'open', isStale: false });
    startLivenessChecks();
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
    clearTimers();
    useStore.setState({ wsStatus: 'closed', isStale: true });
    socket = null;
    scheduleReconnect();
  };

  socket.onerror = () => {
    socket?.close();
  };
}

// --- Page Visibility: reconnect when tab regains focus ---
// Browsers throttle background tabs aggressively. WebSockets in throttled
// tabs sometimes go silent without firing onclose. When the tab returns
// to foreground, force a fresh connection if anything looks off.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const idleMs = Date.now() - lastInboundAt;
      // If no inbound for 30s OR socket isn't open, reconnect.
      if (idleMs > 30_000 || !socket || socket.readyState !== WebSocket.OPEN) {
        console.info(`[ws] tab visible after ${idleMs}ms idle, reconnecting`);
        if (socket) { try { socket.close(); } catch { /* ignore */ } }
        socket = null;
        clearTimers();
        connect();
      }
    }
  });
}
