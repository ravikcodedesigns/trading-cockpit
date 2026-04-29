"""
Bookmap Python addon — Day 1 STUB.

This script connects to the aggregator's source WebSocket and sends a
heartbeat every 5 seconds. It does NOT yet read from Bookmap's API.

The purpose for Day 1 is to prove the pipe works end-to-end:
    aggregator running on :8787  →  this script connects  →
    cockpit shows "bookmap connected" + heartbeat events flow through.

For Day 2 we replace the body with the real Bookmap addon code that
subscribes to depth and trades and emits absorption events. That code
must run inside Bookmap (via the bm package), not standalone — but this
WebSocket scaffolding is the same bridge we'll use either way.

Run:
    pip install websockets
    python3 addons/bookmap/addon.py

Or via pm2:
    pm2 start ecosystem.config.cjs --only bookmap-addon
"""
import asyncio
import json
import time
import sys

try:
    import websockets
except ImportError:
    print("ERROR: 'websockets' not installed. Run: pip install websockets", file=sys.stderr)
    sys.exit(1)

AGGREGATOR_URL = "ws://127.0.0.1:8787/ws/sources?source=bookmap"
HEARTBEAT_SEC = 5
RECONNECT_BACKOFF_SEC = 3


async def run():
    backoff = 1
    while True:
        try:
            print(f"[bookmap] connecting to {AGGREGATOR_URL}")
            async with websockets.connect(AGGREGATOR_URL, ping_interval=20) as ws:
                print("[bookmap] connected")
                backoff = 1
                while True:
                    msg = {
                        "ts": int(time.time() * 1000),
                        "type": "heartbeat",
                    }
                    await ws.send(json.dumps(msg))
                    await asyncio.sleep(HEARTBEAT_SEC)
        except (websockets.ConnectionClosed, ConnectionRefusedError, OSError) as e:
            print(f"[bookmap] disconnected ({e}); retrying in {backoff}s")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)
        except Exception as e:
            print(f"[bookmap] unexpected error: {e!r}; retrying in {RECONNECT_BACKOFF_SEC}s")
            await asyncio.sleep(RECONNECT_BACKOFF_SEC)


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("[bookmap] stopped")
