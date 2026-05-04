"""
Cockpit Bookmap Addon - v1.6

Targets bookmap library 0.1.2.

What changed in v1.6:
    - Added delta divergence detection.
    - Tracks cumulative delta (running buyer-aggression minus seller-aggression).
    - Detects swing peaks and troughs in price using a 2-tick swing definition.
    - At each new peak/trough, compares cumulative delta vs the prior peak/trough.
    - Emits 'delta_divergence' events when:
        * New higher high in price BUT lower delta than prior peak (bearish), OR
        * New lower low in price BUT higher delta than prior trough (bullish).
    - Cool-down: once a divergence fires, the detector waits 60s before
      emitting another for the same direction on the same symbol.
    - Rolling window: 45 minutes. Peaks/troughs older than that are dropped.

Existing functionality preserved from v1.5:
    - 1-minute bars with partial-update emission every second.
    - Sweep detection with same-side burst tracking.
    - Heartbeats every 5 seconds.
    - WebSocket auto-reconnect.
"""

import bookmap as bm
import websocket
import threading
import queue
import json
import time
import re
import traceback
import collections
from typing import Any, Dict, Optional


# =========================================================================
# CONFIG
# =========================================================================

AGGREGATOR_URL = "ws://127.0.0.1:8787/ws/sources?source=bookmap"
TICK_STORE_URL = "ws://127.0.0.1:8788/ws/ticks"
BAR_INTERVAL_SEC = 60
PARTIAL_EMIT_INTERVAL_SEC = 1
HEARTBEAT_INTERVAL_SEC = 5
RECONNECT_INITIAL_BACKOFF_SEC = 1
RECONNECT_MAX_BACKOFF_SEC = 30
QUEUE_MAX_SIZE = 5000

# Tick stream batching constants. Tick volume can be 100k+ per day,
# so we use a separate queue with larger capacity. Batches flush every
# 100ms or 200 events, whichever comes first.
TICK_BATCH_MAX_EVENTS = 200
TICK_BATCH_FLUSH_MS = 100
TICK_QUEUE_MAX_SIZE = 50000

# Sweep detection thresholds
SWEEP_MAX_GAP_MS = 500
SWEEP_MIN_LEVELS = 3
SWEEP_MIN_VOLUME = 50

# Delta divergence detection
DELTA_WINDOW_SEC = 45 * 60                # rolling window for peak/trough memory
DELTA_PEAK_SWING_TICKS = 2.0              # min swing to confirm a peak/trough (NQ ticks; 1 tick = 0.25)
DELTA_DIVERGENCE_MIN_DIFF = 100           # min cumulative-delta difference to call divergence
DELTA_COOLDOWN_MS = 60 * 1000             # min ms between same-direction divergences per symbol


_SYMBOL_PATTERNS = [
    (re.compile(r"\bMNQ", re.IGNORECASE), "NQ"),
    (re.compile(r"\bMES", re.IGNORECASE), "ES"),
    (re.compile(r"\bNQ", re.IGNORECASE),  "NQ"),
    (re.compile(r"\bES", re.IGNORECASE),  "ES"),
]


def alias_to_symbol(alias):
    if not alias:
        return None
    instrument = alias.split("@", 1)[0]
    for pattern, symbol in _SYMBOL_PATTERNS:
        if pattern.search(instrument):
            return symbol
    return None


# =========================================================================
# WebSocket sender
# =========================================================================

class WSSender(threading.Thread):
    def __init__(self, q, url=AGGREGATOR_URL, name="cockpit-ws-sender"):
        super().__init__(daemon=True, name=name)
        self.q = q
        self.url = url
        self.ws = None
        self.stop_event = threading.Event()
        self.connected = False

    def stop(self):
        self.stop_event.set()
        self._close()

    def _close(self):
        try:
            if self.ws is not None:
                self.ws.close()
        except Exception:
            pass
        self.ws = None
        self.connected = False

    def _connect(self):
        try:
            self.ws = websocket.create_connection(self.url, timeout=5)
            self.connected = True
            print("[cockpit] connected to " + self.url)
            return True
        except Exception as e:
            self.connected = False
            print("[cockpit] connect failed for " + self.url + ": " + str(e))
            return False

    def run(self):
        backoff = RECONNECT_INITIAL_BACKOFF_SEC
        while not self.stop_event.is_set():
            if not self.connected:
                if self._connect():
                    backoff = RECONNECT_INITIAL_BACKOFF_SEC
                else:
                    if self.stop_event.wait(backoff):
                        return
                    backoff = min(backoff * 2, RECONNECT_MAX_BACKOFF_SEC)
                    continue
            try:
                msg = self.q.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                self.ws.send(json.dumps(msg))
            except Exception as e:
                print("[cockpit] send failed: " + str(e) + "; will reconnect")
                self._close()
                try:
                    self.q.put_nowait(msg)
                except queue.Full:
                    pass


# =========================================================================
# TickBuffer: collects raw trade and depth events, flushes batches to tick-store
# =========================================================================
#
# Design notes:
#   - Append is non-blocking. Called from on_trade and on_depth handlers.
#     Must NOT block them on network operations.
#   - A dedicated flusher thread drains the buffer into a queue that the
#     tick-store WSSender consumes.
#   - Drop policy under sustained backpressure: when the deque is full,
#     it auto-evicts the oldest events (FIFO eviction).
#
class TickBuffer:
    def __init__(self, send_queue,
                 max_events=TICK_BATCH_MAX_EVENTS,
                 flush_ms=TICK_BATCH_FLUSH_MS):
        self.send_queue = send_queue
        self.max_events = max_events
        self.flush_interval_sec = flush_ms / 1000.0
        self.buffer = collections.deque(maxlen=TICK_QUEUE_MAX_SIZE)
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self._flusher = threading.Thread(
            target=self._run, daemon=True, name="cockpit-tick-flusher",
        )

    def start(self):
        self._flusher.start()

    def stop(self):
        self.stop_event.set()

    def append_trade(self, ts_ms, symbol, price, size, is_bid_aggressor):
        ev = {
            "type": "trade",
            "ts": ts_ms,
            "symbol": symbol,
            "price": price,
            "size": size,
            "isBidAggressor": bool(is_bid_aggressor),
        }
        with self.lock:
            self.buffer.append(ev)
            should_flush = len(self.buffer) >= self.max_events
        if should_flush:
            self._flush()

    def append_depth(self, ts_ms, symbol, side, price, size, is_replace=True):
        ev = {
            "type": "depth",
            "ts": ts_ms,
            "symbol": symbol,
            "side": "bid" if side else "ask",
            "price": price,
            "size": size,
            "isReplace": bool(is_replace),
        }
        with self.lock:
            self.buffer.append(ev)
            should_flush = len(self.buffer) >= self.max_events
        if should_flush:
            self._flush()

    def _flush(self):
        with self.lock:
            if not self.buffer:
                return
            events = list(self.buffer)
            self.buffer.clear()
        msg = {
            "type": "batch",
            "ts": _now_ms(),
            "events": events,
        }
        try:
            self.send_queue.put_nowait(msg)
        except queue.Full:
            print("[cockpit] tick send queue full, dropped batch of "
                  + str(len(events)))

    def _run(self):
        while not self.stop_event.is_set():
            if self.stop_event.wait(self.flush_interval_sec):
                return
            self._flush()


# =========================================================================
# Per-symbol state
# =========================================================================

class SweepBurst:
    def __init__(self):
        self.is_aggressor_buy = None
        self.start_ms = 0
        self.last_trade_ms = 0
        self.distinct_prices = set()
        self.total_volume = 0
        self.first_price = None
        self.last_price = None

    def reset(self):
        self.is_aggressor_buy = None
        self.start_ms = 0
        self.last_trade_ms = 0
        self.distinct_prices = set()
        self.total_volume = 0
        self.first_price = None
        self.last_price = None

    def is_active(self):
        return self.is_aggressor_buy is not None


class SwingExtreme:
    """A confirmed swing peak (high) or trough (low) with the cumulative
    delta value at the time it was confirmed."""
    def __init__(self, kind, price, delta, ts_ms):
        self.kind = kind          # 'peak' or 'trough'
        self.price = price
        self.delta = delta
        self.ts_ms = ts_ms


class DeltaDivergenceState:
    """Tracks running cumulative delta and confirmed swing extremes for one
    symbol. Detects bearish/bullish divergence between consecutive peaks or
    troughs respectively."""
    def __init__(self, pips):
        self.pips = pips
        self.cum_delta = 0
        self.last_price = None
        self.last_ts_ms = 0

        # Provisional tracking - we hold a candidate extreme until price
        # swings far enough in the opposite direction to confirm it.
        self.candidate_high_price = None
        self.candidate_high_delta = 0
        self.candidate_high_ts = 0
        self.candidate_low_price = None
        self.candidate_low_delta = 0
        self.candidate_low_ts = 0

        # Swing memory (rolling DELTA_WINDOW_SEC). Newest at end of list.
        self.peaks = []     # list[SwingExtreme]
        self.troughs = []   # list[SwingExtreme]

        # Last divergence emit timestamps for cooldown
        self.last_bearish_emit_ms = 0
        self.last_bullish_emit_ms = 0


class SymbolState:
    def __init__(self, alias, symbol, pips, size_multiplier):
        self.alias = alias
        self.symbol = symbol
        self.pips = pips
        self.size_multiplier = size_multiplier

        # 1-minute bar in progress
        self.bar_start_ms = None
        self.bar_open = None
        self.bar_high = None
        self.bar_low = None
        self.bar_close = None
        self.bar_volume = 0
        self.bar_buy_volume = 0
        self.bar_sell_volume = 0
        self.last_partial_emit_ms = 0

        # Order book
        self.bids = {}
        self.asks = {}

        # Sweep burst tracker
        self.burst = SweepBurst()

        # Delta divergence tracker
        self.dd = DeltaDivergenceState(pips)


# =========================================================================
# Module state
# =========================================================================

_event_queue = queue.Queue(maxsize=QUEUE_MAX_SIZE)
_sender = WSSender(_event_queue)

# Tick stream: separate queue, sender, and buffer.
# Goes to tick-store on port 8788 in parallel with the bar/sweep/divergence
# stream that goes to aggregator on 8787. Failure isolation: if tick-store
# crashes, the WSSender reconnect loop kicks in and the bar pipeline is
# unaffected.
_tick_queue = queue.Queue(maxsize=QUEUE_MAX_SIZE)
_tick_sender = WSSender(_tick_queue, url=TICK_STORE_URL, name="cockpit-tick-sender")
_tick_buffer = TickBuffer(_tick_queue)

_symbols = {}
_lock = threading.Lock()
_last_heartbeat_ms = 0


def _now_ms():
    return int(time.time() * 1000)


def _enqueue(msg):
    try:
        _event_queue.put_nowait(msg)
    except queue.Full:
        try:
            _event_queue.get_nowait()
            _event_queue.put_nowait(msg)
        except Exception:
            pass


# =========================================================================
# Bar aggregation (unchanged from v1.5)
# =========================================================================

def _emit_bar(state, partial):
    if state.bar_start_ms is None or state.bar_volume == 0:
        return
    msg = {
        "ts": state.bar_start_ms,
        "type": "bar",
        "symbol": state.symbol,
        "interval": "1m",
        "partial": partial,
        "open": state.bar_open,
        "high": state.bar_high,
        "low": state.bar_low,
        "close": state.bar_close,
        "volume": state.bar_volume,
        "buyVolume": state.bar_buy_volume,
        "sellVolume": state.bar_sell_volume,
    }
    _enqueue(msg)


def _reset_bar(state):
    state.bar_start_ms = None
    state.bar_open = None
    state.bar_high = None
    state.bar_low = None
    state.bar_close = None
    state.bar_volume = 0
    state.bar_buy_volume = 0
    state.bar_sell_volume = 0
    state.last_partial_emit_ms = 0


def _ingest_trade_unlocked(state, ts_ms, price, size, is_aggressor_buy):
    bucket = (ts_ms // (BAR_INTERVAL_SEC * 1000)) * (BAR_INTERVAL_SEC * 1000)

    if state.bar_start_ms is not None and bucket != state.bar_start_ms:
        _emit_bar(state, False)
        _reset_bar(state)

    if state.bar_start_ms is None:
        state.bar_start_ms = bucket
        state.bar_open = price
        state.bar_high = price
        state.bar_low = price

    state.bar_high = max(state.bar_high, price)
    state.bar_low = min(state.bar_low, price)
    state.bar_close = price
    state.bar_volume += size
    if is_aggressor_buy:
        state.bar_buy_volume += size
    else:
        state.bar_sell_volume += size


# =========================================================================
# Sweep detection (unchanged from v1.5)
# =========================================================================

def _evaluate_burst_unlocked(state):
    burst = state.burst
    if not burst.is_active():
        return
    qualifies = (
        len(burst.distinct_prices) >= SWEEP_MIN_LEVELS
        and burst.total_volume >= SWEEP_MIN_VOLUME
    )
    if qualifies:
        msg = {
            "ts": burst.start_ms,
            "type": "sweep",
            "symbol": state.symbol,
            "direction": "long" if burst.is_aggressor_buy else "short",
            "levels": len(burst.distinct_prices),
            "volume": burst.total_volume,
            "durationMs": max(1, burst.last_trade_ms - burst.start_ms),
            "startPrice": burst.first_price,
            "endPrice": burst.last_price,
        }
        _enqueue(msg)


def _track_burst_unlocked(state, ts_ms, price, size, is_aggressor_buy):
    burst = state.burst
    burst_ended = False
    if burst.is_active():
        if burst.is_aggressor_buy != is_aggressor_buy:
            burst_ended = True
        elif ts_ms - burst.last_trade_ms > SWEEP_MAX_GAP_MS:
            burst_ended = True
    if burst_ended:
        _evaluate_burst_unlocked(state)
        burst.reset()
    if not burst.is_active():
        burst.is_aggressor_buy = is_aggressor_buy
        burst.start_ms = ts_ms
        burst.first_price = price
    burst.last_trade_ms = ts_ms
    burst.last_price = price
    burst.distinct_prices.add(price)
    burst.total_volume += size


def _check_burst_timeout_unlocked(state, now_ms):
    burst = state.burst
    if burst.is_active() and now_ms - burst.last_trade_ms > SWEEP_MAX_GAP_MS:
        _evaluate_burst_unlocked(state)
        burst.reset()


# =========================================================================
# Delta divergence detection
# =========================================================================

def _prune_swing_window_unlocked(dd, now_ms):
    """Drop peaks/troughs older than the rolling window."""
    cutoff = now_ms - DELTA_WINDOW_SEC * 1000
    dd.peaks = [p for p in dd.peaks if p.ts_ms >= cutoff]
    dd.troughs = [t for t in dd.troughs if t.ts_ms >= cutoff]


def _check_divergence_unlocked(state, kind):
    """Compare the most recent swing extreme to the prior one of same kind.
    If divergence threshold met and cooldown elapsed, emit an event.
    Caller holds _lock."""
    dd = state.dd
    now = _now_ms()
    series = dd.peaks if kind == 'peak' else dd.troughs
    if len(series) < 2:
        return
    current = series[-1]
    prior = series[-2]

    if kind == 'peak':
        # Bearish divergence: higher high in price + lower delta
        if current.price <= prior.price:
            return
        delta_diff = prior.delta - current.delta
        if delta_diff < DELTA_DIVERGENCE_MIN_DIFF:
            return
        if now - dd.last_bearish_emit_ms < DELTA_COOLDOWN_MS:
            return
        dd.last_bearish_emit_ms = now
        direction = 'bearish'
    else:
        # Bullish divergence: lower low in price + higher delta
        if current.price >= prior.price:
            return
        delta_diff = current.delta - prior.delta
        if delta_diff < DELTA_DIVERGENCE_MIN_DIFF:
            return
        if now - dd.last_bullish_emit_ms < DELTA_COOLDOWN_MS:
            return
        dd.last_bullish_emit_ms = now
        direction = 'bullish'

    # Magnitude: 0-100 scaled. 100 contracts diff = 50, 500 diff = 100.
    magnitude = min(100, int(50 + (delta_diff - DELTA_DIVERGENCE_MIN_DIFF) / 8))

    msg = {
        "ts": current.ts_ms,
        "type": "delta_divergence",
        "symbol": state.symbol,
        "direction": direction,
        "currentPrice": current.price,
        "currentDelta": current.delta,
        "priorPrice": prior.price,
        "priorDelta": prior.delta,
        "deltaDiff": delta_diff,
        "magnitude": magnitude,
        "windowSec": DELTA_WINDOW_SEC,
    }
    _enqueue(msg)


def _track_delta_unlocked(state, ts_ms, price, size, is_aggressor_buy):
    """Update cumulative delta and run swing peak/trough detection.
    Caller holds _lock."""
    dd = state.dd

    # Update cumulative delta
    if is_aggressor_buy:
        dd.cum_delta += size
    else:
        dd.cum_delta -= size

    swing_threshold = DELTA_PEAK_SWING_TICKS * dd.pips

    # Initialize on first trade
    if dd.last_price is None:
        dd.last_price = price
        dd.last_ts_ms = ts_ms
        dd.candidate_high_price = price
        dd.candidate_high_delta = dd.cum_delta
        dd.candidate_high_ts = ts_ms
        dd.candidate_low_price = price
        dd.candidate_low_delta = dd.cum_delta
        dd.candidate_low_ts = ts_ms
        return

    # Update candidate high if price went higher
    if price > dd.candidate_high_price:
        dd.candidate_high_price = price
        dd.candidate_high_delta = dd.cum_delta
        dd.candidate_high_ts = ts_ms
    # Confirm peak: current price has fallen >= swing_threshold below candidate high
    elif (dd.candidate_high_price - price) >= swing_threshold:
        if not dd.peaks or dd.peaks[-1].ts_ms != dd.candidate_high_ts:
            dd.peaks.append(SwingExtreme(
                'peak', dd.candidate_high_price,
                dd.candidate_high_delta, dd.candidate_high_ts
            ))
            _prune_swing_window_unlocked(dd, ts_ms)
            _check_divergence_unlocked(state, 'peak')
        # Reset candidate high to the current price (start tracking from here)
        dd.candidate_high_price = price
        dd.candidate_high_delta = dd.cum_delta
        dd.candidate_high_ts = ts_ms

    # Update candidate low if price went lower
    if price < dd.candidate_low_price:
        dd.candidate_low_price = price
        dd.candidate_low_delta = dd.cum_delta
        dd.candidate_low_ts = ts_ms
    # Confirm trough: current price has risen >= swing_threshold above candidate low
    elif (price - dd.candidate_low_price) >= swing_threshold:
        if not dd.troughs or dd.troughs[-1].ts_ms != dd.candidate_low_ts:
            dd.troughs.append(SwingExtreme(
                'trough', dd.candidate_low_price,
                dd.candidate_low_delta, dd.candidate_low_ts
            ))
            _prune_swing_window_unlocked(dd, ts_ms)
            _check_divergence_unlocked(state, 'trough')
        dd.candidate_low_price = price
        dd.candidate_low_delta = dd.cum_delta
        dd.candidate_low_ts = ts_ms

    dd.last_price = price
    dd.last_ts_ms = ts_ms


# =========================================================================
# Bookmap handlers
# =========================================================================

def handle_subscribe_instrument(addon, alias, full_name, is_crypto, pips,
                                 size_multiplier, instrument_multiplier,
                                 supported_features):
    try:
        symbol = alias_to_symbol(alias)
        if symbol is None:
            print("[cockpit] ignoring unsupported alias: " + str(alias))
            return

        with _lock:
            _symbols[alias] = SymbolState(alias, symbol, pips, size_multiplier)

        print("[cockpit] subscribed: alias=" + str(alias)
              + " symbol=" + str(symbol)
              + " pips=" + str(pips)
              + " size_multiplier=" + str(size_multiplier)
              + " fullname=" + str(full_name))

        bm.subscribe_to_depth(addon, alias, 0)
        bm.subscribe_to_trades(addon, alias, 1)

    except Exception:
        print("[cockpit] handle_subscribe_instrument crashed: " + traceback.format_exc())


def handle_detach_instrument(alias):
    try:
        with _lock:
            state = _symbols.pop(alias, None)
            if state is not None:
                _evaluate_burst_unlocked(state)
                _emit_bar(state, False)
        print("[cockpit] detached: alias=" + str(alias))
    except Exception:
        print("[cockpit] handle_detach_instrument crashed: " + traceback.format_exc())


def on_trade(addon, alias, price, size, is_otc, is_bid_aggressor,
             is_execution_start, is_execution_end,
             aggressor_order_id, passive_order_id):
    try:
        with _lock:
            state = _symbols.get(alias)
            if state is None:
                return

            if state.size_multiplier:
                real_size = int(size / state.size_multiplier)
            else:
                real_size = size
            if real_size <= 0:
                real_size = max(1, size)

            real_price = float(price) * state.pips
            is_aggressor_buy = not bool(is_bid_aggressor)
            now = _now_ms()
            symbol_name = state.symbol

            _ingest_trade_unlocked(state, now, real_price, real_size, is_aggressor_buy)
            _track_burst_unlocked(state, now, real_price, real_size, is_aggressor_buy)
            _track_delta_unlocked(state, now, real_price, real_size, is_aggressor_buy)

        # Append to tick buffer OUTSIDE the lock to avoid blocking handlers.
        # is_bid_aggressor as received from Bookmap: True means the seller
        # crossed the bid (sell aggression). We pass this through unchanged
        # to preserve ground-truth in the captured stream.
        _tick_buffer.append_trade(now, symbol_name, real_price, real_size,
                                  bool(is_bid_aggressor))

    except Exception:
        print("[cockpit] on_trade crashed: " + traceback.format_exc())


def on_depth(addon, alias, is_bid, price_level, size_level):
    try:
        with _lock:
            state = _symbols.get(alias)
            if state is None:
                return
            book = state.bids if is_bid else state.asks
            if size_level == 0:
                book.pop(price_level, None)
            else:
                book[price_level] = size_level
            real_price = float(price_level) * state.pips
            if state.size_multiplier:
                real_size = int(size_level / state.size_multiplier)
            else:
                real_size = size_level
            symbol_name = state.symbol
            now = _now_ms()

        # Append OUTSIDE the lock. CQG MBP feed uses replace-at-level
        # semantics: every event represents the new size at that price
        # level (or 0 for removal). Hence is_replace=True always.
        _tick_buffer.append_depth(now, symbol_name, bool(is_bid),
                                  real_price, real_size, is_replace=True)
    except Exception:
        print("[cockpit] on_depth crashed: " + traceback.format_exc())


def on_interval(addon, alias):
    global _last_heartbeat_ms
    try:
        now = _now_ms()
        bucket = (now // (BAR_INTERVAL_SEC * 1000)) * (BAR_INTERVAL_SEC * 1000)

        with _lock:
            state = _symbols.get(alias)
            if state is not None:
                if state.bar_start_ms is not None and bucket != state.bar_start_ms:
                    _emit_bar(state, False)
                    _reset_bar(state)
                if state.bar_start_ms is not None:
                    if now - state.last_partial_emit_ms >= PARTIAL_EMIT_INTERVAL_SEC * 1000:
                        state.last_partial_emit_ms = now
                        _emit_bar(state, True)
                _check_burst_timeout_unlocked(state, now)

        if now - _last_heartbeat_ms >= HEARTBEAT_INTERVAL_SEC * 1000:
            _last_heartbeat_ms = now
            _enqueue({"ts": now, "type": "heartbeat"})

    except Exception:
        print("[cockpit] on_interval crashed: " + traceback.format_exc())


# =========================================================================
# Addon lifecycle
# =========================================================================

def main():
    print("[cockpit] addon starting (v1.6 - sweeps + delta divergence)")

    addon = bm.create_addon()

    bm.add_depth_handler(addon, on_depth)
    bm.add_trades_handler(addon, on_trade)
    bm.add_on_interval_handler(addon, on_interval)

    _sender.start()
    print("[cockpit] sender thread started")

    _tick_sender.start()
    _tick_buffer.start()
    print("[cockpit] tick stream started, target: " + TICK_STORE_URL)

    bm.start_addon(addon, handle_subscribe_instrument, handle_detach_instrument)


if __name__ == "__main__":
    main()
