"""
capture_mbo.py — TEMPORARY data-source inspector.

Subscribes to whatever Bookmap's `bm` package exposes (trades, depth, mbo,
order events) and logs every raw event to /tmp/mbo_capture.log.

Does NOT write to ticks.db or tick-store. Pure read-only capture so we can
see the payload structure of the new BookmapData MBO feed before designing
the schema.

Auto-exits after 90 seconds. Run AFTER stopping the regular bookmap-addon
and AFTER switching Bookmap's data source to BookmapData.

Usage:
    pm2 stop bookmap-addon
    python3 addons/bookmap/capture_mbo.py
    # ...wait 90 sec, watch /tmp/mbo_capture.log...
    tail -f /tmp/mbo_capture.log
"""
import bookmap as bm
import time
import json
import sys
import traceback


CAPTURE_LOG = "/tmp/mbo_capture.log"
RUN_FOR_SEC = 90

# Counters so we can quickly see what's flowing
_counts = {
    "trade": 0,
    "depth": 0,
    "mbo_add": 0,
    "mbo_modify": 0,
    "mbo_cancel": 0,
    "mbo_execute": 0,
    "mbo_other": 0,
    "instrument_subscribe": 0,
}


def _log(kind, payload):
    """Write a single event to the capture log as one JSON line."""
    _counts[kind] = _counts.get(kind, 0) + 1
    rec = {
        "kind": kind,
        "ts_ms": int(time.time() * 1000),
        "data": payload,
    }
    with open(CAPTURE_LOG, "a") as f:
        f.write(json.dumps(rec, default=str) + "\n")


# =========================================================================
# Existing handlers (depth + trades) — for reference; same as cockpit_addon
# =========================================================================

def on_trade(addon, alias, price, size, is_otc, is_bid_aggressor,
             is_execution_start, is_execution_end, trade_id):
    try:
        _log("trade", {
            "alias": alias, "price": price, "size": size,
            "is_otc": is_otc, "is_bid_aggressor": is_bid_aggressor,
            "is_execution_start": is_execution_start,
            "is_execution_end": is_execution_end,
            "trade_id": trade_id,
        })
    except Exception:
        with open(CAPTURE_LOG, "a") as f:
            f.write(f"on_trade crashed: {traceback.format_exc()}\n")


def on_depth(addon, alias, is_bid, price_level, size_level):
    try:
        _log("depth", {
            "alias": alias, "is_bid": is_bid,
            "price": price_level, "size": size_level,
        })
    except Exception:
        with open(CAPTURE_LOG, "a") as f:
            f.write(f"on_depth crashed: {traceback.format_exc()}\n")


# =========================================================================
# MBO / order-level handlers — try common names that bookmap-python uses
# =========================================================================

# MBO handler callbacks — signatures match the Java MarketByOrderDepthDataListener
# interface: send / replace / cancel. The Python SDK might also pass `alias` first.
# We use **kwargs to be permissive in case signature varies.

def on_mbo_send(*args, **kwargs):
    """Order ADDED. Java signature: send(orderId, isBid, price, size)
    Python likely: (addon, alias, orderId, isBid, price, size) — but we accept any."""
    try:
        _log("mbo_add", {"args": [str(a) for a in args], "kwargs": kwargs})
    except Exception:
        with open(CAPTURE_LOG, "a") as f:
            f.write(f"on_mbo_send crashed: {traceback.format_exc()}\n")


def on_mbo_replace(*args, **kwargs):
    """Order MODIFIED. Java signature: replace(orderId, price, size)"""
    try:
        _log("mbo_modify", {"args": [str(a) for a in args], "kwargs": kwargs})
    except Exception:
        with open(CAPTURE_LOG, "a") as f:
            f.write(f"on_mbo_replace crashed: {traceback.format_exc()}\n")


def on_mbo_cancel(*args, **kwargs):
    """Order CANCELLED. Java signature: cancel(orderId)"""
    try:
        _log("mbo_cancel", {"args": [str(a) for a in args], "kwargs": kwargs})
    except Exception:
        with open(CAPTURE_LOG, "a") as f:
            f.write(f"on_mbo_cancel crashed: {traceback.format_exc()}\n")


# =========================================================================
# Instrument subscription
# =========================================================================

def handle_subscribe(addon, alias, full_name, is_crypto, pips,
                     size_multiplier, instrument_multiplier):
    try:
        _log("instrument_subscribe", {
            "alias": alias, "full_name": full_name,
            "is_crypto": is_crypto, "pips": pips,
            "size_multiplier": size_multiplier,
            "instrument_multiplier": instrument_multiplier,
        })
    except Exception:
        pass

    # Subscribe to all data streams Bookmap exposes
    try:
        bm.subscribe_to_depth(addon, alias, 0)
        with open(CAPTURE_LOG, "a") as f:
            f.write(f"[{alias}] subscribed to depth (L2)\n")
    except Exception as e:
        with open(CAPTURE_LOG, "a") as f:
            f.write(f"[{alias}] depth subscribe failed: {e}\n")

    try:
        bm.subscribe_to_trades(addon, alias, 1)
        with open(CAPTURE_LOG, "a") as f:
            f.write(f"[{alias}] subscribed to trades\n")
    except Exception as e:
        with open(CAPTURE_LOG, "a") as f:
            f.write(f"[{alias}] trades subscribe failed: {e}\n")

    # Try MBO subscription. Java SDK uses subscribeMbo / requestMbo; Python
    # naming varies. We try every plausible form.
    mbo_funcs = [
        "subscribe_to_mbo",
        "subscribe_to_market_by_order",
        "subscribe_to_market_by_order_depth",
        "subscribe_to_orders",
        "request_mbo",
        "request_mbo_data",
        "request_market_by_order",
    ]
    for fn_name in mbo_funcs:
        fn = getattr(bm, fn_name, None)
        if fn is None:
            continue
        try:
            fn(addon, alias)
            with open(CAPTURE_LOG, "a") as f:
                f.write(f"[{alias}] subscribed via bm.{fn_name}\n")
        except Exception as e:
            with open(CAPTURE_LOG, "a") as f:
                f.write(f"[{alias}] bm.{fn_name}({alias}) failed: {e}\n")


def handle_detach(alias):
    pass


# =========================================================================
# Main + watchdog
# =========================================================================

def main():
    # Reset capture file
    with open(CAPTURE_LOG, "w") as f:
        f.write(f"=== MBO capture started at {time.time()} (Unix sec) ===\n")
        f.write("=== Switch Bookmap to BookmapData feed BEFORE this script connects ===\n\n")

    print(f"[capture] Logging to {CAPTURE_LOG}")
    print(f"[capture] Auto-exit after {RUN_FOR_SEC} seconds")
    print(f"[capture] Available bm.subscribe_* functions:")
    for name in dir(bm):
        if "subscribe" in name.lower() or "mbo" in name.lower() or "order" in name.lower():
            print(f"           bm.{name}")

    # Register all available handlers — try-with-fallback for MBO ones
    addon = bm.create_addon()
    bm.add_depth_handler(addon, on_depth)
    bm.add_trades_handler(addon, on_trade)

    # MBO handler registration. The Java listener interface is
    # MarketByOrderDepthDataListener with methods send / replace / cancel.
    # The Python SDK might expose this in one of several naming forms:
    handler_pairs = [
        # Most likely (direct Java translation):
        ("add_market_by_order_depth_data_listener", on_mbo_send),
        ("add_market_by_order_depth_listener", on_mbo_send),
        ("add_market_by_order_listener", on_mbo_send),
        # Per-event registration (if SDK separates them):
        ("add_mbo_send_handler", on_mbo_send),
        ("add_mbo_replace_handler", on_mbo_replace),
        ("add_mbo_cancel_handler", on_mbo_cancel),
        ("add_order_send_handler", on_mbo_send),
        ("add_order_replace_handler", on_mbo_replace),
        ("add_order_cancel_handler", on_mbo_cancel),
        # Catch-all naming the wrapper might use:
        ("add_mbo_handler", on_mbo_send),
    ]
    for fn_name, callback in handler_pairs:
        register_fn = getattr(bm, fn_name, None)
        if register_fn is None:
            continue
        try:
            register_fn(addon, callback)
            print(f"[capture] Registered handler via bm.{fn_name}")
        except Exception as e:
            print(f"[capture] bm.{fn_name} failed: {e}")

    # Print available bm.add_* functions for diagnosis
    print("[capture] All available bm.add_*_handler functions:")
    for name in dir(bm):
        if name.startswith("add_") and "handler" in name:
            print(f"           bm.{name}")

    # Periodic status printer
    def status_loop():
        start = time.time()
        while time.time() - start < RUN_FOR_SEC:
            time.sleep(5)
            print(f"[capture] t+{int(time.time()-start)}s  counts={dict(_counts)}")
        print("[capture] Time's up. Stopping.")
        with open(CAPTURE_LOG, "a") as f:
            f.write(f"\n=== Final counts: {json.dumps(_counts)} ===\n")
        # Force exit since bm.start_addon may block forever
        import os
        os._exit(0)

    import threading
    threading.Thread(target=status_loop, daemon=True).start()

    bm.start_addon(addon, handle_subscribe, handle_detach)


if __name__ == "__main__":
    main()
