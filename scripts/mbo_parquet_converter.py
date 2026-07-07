#!/usr/bin/env python3
"""
mbo_parquet_converter.py — Convert Bookmap JSON-lines capture into Parquet.

Why this exists:
  The SQLite mbo.db ingest does not keep up at runtime — single-writer WAL
  contention serialises depth/trade/mbo writes for both NQ and ES. Parquet
  gives us a columnar, compressed, partition-prunable store that DuckDB can
  query in-place. The .log files stay intact as the safety net.

Output layout (under --out, default data/mbo-parquet/):
  {trades|depth|mbo}/symbol={NQ|ES|CL|GC|MNQ|MES|MCL|MGC}/date=YYYY-MM-DD/<file>.parquet
  .checkpoints/<logfile-basename>.ckpt   (JSON: {"offset": <bytes>})

Two modes:
  --backfill <file ...>    process whole .log files end-to-end (one shot)
  --tail                   follow ~/cockpit-mbo-capture/*.log forever

Schemas (3 tables):
  trades: ts_ms, price_int, price, size, is_bid_aggressor,
          aggressor_order_id, passive_order_id,
          is_execution_start, is_execution_end, is_otc
  depth:  ts_ms, price_int, price, size, is_bid
  mbo:    ts_ms, action ('send'|'cancel'|'replace'),
          order_id, price_int, price, size, is_bid
"""

import argparse
import json
import os
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import pyarrow as pa
import pyarrow.parquet as pq
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
DEFAULT_LOG_DIR = Path.home() / "cockpit-mbo-capture"
DEFAULT_OUT_DIR = Path.home() / "trading-cockpit" / "data" / "mbo-parquet"

# Flush thresholds — chosen so a flush emits a "nice" row-group / file
# without ballooning RSS. ~1M rows × ~6 cols × ~12B ≈ 70MB before compression.
BACKFILL_ROWGROUP_ROWS = 1_000_000
TAIL_FLUSH_ROWS = 250_000
TAIL_FLUSH_SECONDS = 60
TAIL_POLL_SECONDS = 1.0

# Compression: zstd L3 is the sweet spot per pyarrow guidance — ~2x smaller
# than snappy with ~equal decode speed at this level.
COMPRESSION = "zstd"
COMPRESSION_LEVEL = 3

# ────────────────────────────────────────────────────────────────────────────
# Schemas
# ────────────────────────────────────────────────────────────────────────────

# ts_ms = EXCHANGE time (addon v1.2+; was capture-arrival time in v1.1 — see backlog #13).
# ts_recv = capture-arrival time, present only from v1.2 logs (null for older .log lines);
#   feed lag = ts_recv - ts_ms. Partitioning + all timing use ts_ms.
# seq (2026-07-06, Cracker data-integrity fix) = BYTE OFFSET of the source line in
#   its .log file. Capture order is MEANING for book replay (depth updates carry
#   absolute sizes), and the nightly DISTINCT compaction was shuffling row order —
#   destroying it. seq makes capture order an explicit, rewrite-proof column:
#   replays ORDER BY (ts_ms, seq); dedup re-writes ORDER BY (ts_ms, seq). Byte
#   offset is deterministic across re-reads (same line ⇒ same seq), so the
#   at-least-once tail's duplicate rows still collapse under full-row DISTINCT.
TRADES_SCHEMA = pa.schema([
    ("ts_ms", pa.int64()),
    ("ts_recv", pa.int64()),
    ("seq", pa.int64()),
    ("contract", pa.string()),       # MNQM6 / MNQU6 / MESM6 / MESU6 / MNQM26 (CQG-style) ...
    ("price_int", pa.int32()),
    ("price", pa.float64()),
    ("size", pa.int32()),
    ("is_bid_aggressor", pa.bool_()),
    ("aggressor_order_id", pa.string()),
    ("passive_order_id", pa.string()),
    ("is_execution_start", pa.bool_()),
    ("is_execution_end", pa.bool_()),
    ("is_otc", pa.bool_()),
])

DEPTH_SCHEMA = pa.schema([
    ("ts_ms", pa.int64()),
    ("ts_recv", pa.int64()),
    ("seq", pa.int64()),
    ("contract", pa.string()),
    ("price_int", pa.int32()),
    ("price", pa.float64()),
    ("size", pa.int32()),
    ("is_bid", pa.bool_()),
])

MBO_SCHEMA = pa.schema([
    ("ts_ms", pa.int64()),
    ("ts_recv", pa.int64()),
    ("seq", pa.int64()),
    ("contract", pa.string()),
    ("action", pa.string()),  # send / cancel / replace
    ("order_id", pa.string()),
    ("price_int", pa.int32()),
    ("price", pa.float64()),
    ("size", pa.int32()),
    ("is_bid", pa.bool_()),
])

SCHEMAS = {"trades": TRADES_SCHEMA, "depth": DEPTH_SCHEMA, "mbo": MBO_SCHEMA}

# ────────────────────────────────────────────────────────────────────────────
# Parsing
# ────────────────────────────────────────────────────────────────────────────

def symbol_from_alias(alias: str) -> Optional[str]:
    """Map an alias to its instrument partition. Micros and full-size are kept
    SEPARATE (different instruments — micro has the retail order-flow firehose,
    full-size has the deep institutional book):
        MNQM6.CME@BMD / F_US_MNQM26@CQG → 'MNQ'   (micro NQ)
        MESU6.CME@BMD                   → 'MES'   (micro ES)
        MCLQ6.NYMEX@BMD                 → 'MCL'   (micro crude)
        MGCQ6.COMEX@BMD                 → 'MGC'   (micro gold)
        NQU6.CME@BMD  / F.US.ENQU6      → 'NQ'    (full-size NQ)
        ESU6.CME@BMD                    → 'ES'    (full-size ES)
        CLQ6.NYMEX@BMD                  → 'CL'    (full-size crude)
        GCQ6.COMEX@BMD                  → 'GC'    (full-size gold)
    Order matters: 'MNQ' contains 'NQ' / 'MCL' contains 'CL' / 'MGC' contains 'GC',
    so micros MUST be tested first."""
    if not isinstance(alias, str) or not alias:
        return None
    a = alias.upper()
    if "MNQ" in a:
        return "MNQ"
    if "MES" in a:
        return "MES"
    if "MCL" in a:
        return "MCL"
    if "MGC" in a:
        return "MGC"
    if "NQ" in a:
        return "NQ"
    if "ES" in a:
        return "ES"
    if "CL" in a:
        return "CL"
    if "GC" in a:
        return "GC"
    return None


def contract_from_alias(alias: str) -> Optional[str]:
    """
    Extract the contract code from the alias. Examples:
        'MNQM6.CME@BMD'      → 'MNQM6'      (BMD)
        'MESU6.CME@BMD'      → 'MESU6'      (BMD, new Sep contract)
        'F.US.MESM26@CQG'    → 'MESM26'     (CQG, dot-separated)
        'F_US_MNQM26@CQG'    → 'MNQM26'     (CQG, underscore-separated)
    Both 'MNQM6' (BMD) and 'MNQM26' (CQG) refer to the same June-2026
    contract — preserve each vendor's native form so downstream queries
    can either canonicalise (strip prefix / pad year) or filter on raw codes.

    Strategy: drop the '@vendor' suffix, then split on '.' and '_' and
    return the first token containing the underlying symbol prefix
    (MNQ / MES / NQ / ES / CL / GC). This is robust to vendor-specific prefix
    conventions (F.US.X / F_US_X / X.CME / X.NYMEX / X.COMEX) without enumerating
    them all, and keeps full-size codes (NQU6 / CLQ6) distinct from micros (MCL…).
    """
    if not alias:
        return None
    before_at = alias.split("@", 1)[0]
    for sep in (".", "_"):
        for tok in before_at.split(sep):
            # MCL/MGC contain CL/GC, MNQ/MES contain NQ/ES — substring test covers micros too
            if any(s in tok for s in ("NQ", "ES", "CL", "GC")):
                return tok
    return before_at or None


# Sane ts_ms window: reject corrupt timestamps that would crash strftime
# ("year out of range") or land in junk partitions (1970, 2534, ...).
_TS_MIN_MS = 1_700_000_000_000  # ~2023-11-14


def et_date_str(ts_ms: int) -> Optional[str]:
    """YYYY-MM-DD in America/New_York (handles DST), or None if ts_ms is
    implausible/corrupt (out of a sane window, or unconvertible)."""
    try:
        if ts_ms is None or ts_ms < _TS_MIN_MS or ts_ms > (time.time() + 2 * 86400) * 1000:
            return None
        return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).astimezone(ET).strftime("%Y-%m-%d")
    except (ValueError, OverflowError, OSError, TypeError):
        return None


def parse_event(line: str) -> Optional[Tuple[str, str, dict]]:
    """
    Returns (table, symbol, row_dict) or None for unrecognised / rotate / errors.
    """
    try:
        obj = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return None

    kind = obj.get("kind")
    if kind == "rotate" or kind is None:
        return None

    alias = obj.get("alias", "")
    sym = symbol_from_alias(alias)
    if sym is None:
        return None
    contract = contract_from_alias(alias)

    ts = obj.get("ts_ms")
    recv = obj.get("ts_recv")   # addon v1.2+; None for older logs (nullable column)
    d = obj.get("data") or {}
    if ts is None:
        return None

    if kind == "trade":
        row = {
            "ts_ms": ts,
            "ts_recv": recv,
            "contract": contract,
            "price_int": d.get("price_int"),
            "price": d.get("price"),
            "size": d.get("size"),
            "is_bid_aggressor": d.get("is_bid_aggressor"),
            "aggressor_order_id": str(d["aggressor_order_id"]) if d.get("aggressor_order_id") is not None else None,
            "passive_order_id": str(d["passive_order_id"]) if d.get("passive_order_id") is not None else None,
            "is_execution_start": d.get("is_execution_start"),
            "is_execution_end": d.get("is_execution_end"),
            "is_otc": d.get("is_otc"),
        }
        return ("trades", sym, row)

    if kind == "depth":
        row = {
            "ts_ms": ts,
            "ts_recv": recv,
            "contract": contract,
            "price_int": d.get("price_int"),
            "price": d.get("price"),
            "size": d.get("size"),
            "is_bid": d.get("is_bid"),
        }
        return ("depth", sym, row)

    if kind in ("mbo_send", "mbo_cancel", "mbo_replace"):
        action = kind.split("_", 1)[1]  # send / cancel / replace
        row = {
            "ts_ms": ts,
            "ts_recv": recv,
            "contract": contract,
            "action": action,
            "order_id": str(d["order_id"]) if d.get("order_id") is not None else None,
            "price_int": d.get("price_int"),
            "price": d.get("price"),
            "size": d.get("size"),
            "is_bid": d.get("is_bid"),
        }
        return ("mbo", sym, row)

    return None


# ────────────────────────────────────────────────────────────────────────────
# Backfill: streams a whole .log file with one open ParquetWriter per
# (table, symbol, date). Memory bounded by row-group size per open writer.
# ────────────────────────────────────────────────────────────────────────────

class BackfillSinks:
    """Per (table, symbol, date) ParquetWriter pool. Writes in row-groups."""

    def __init__(self, out_dir: Path, file_basename: str):
        self.out_dir = out_dir
        self.file_basename = file_basename
        # key=(table, symbol, date) -> {"writer": pq.ParquetWriter, "buf": dict[col,list], "path": Path, "rows": int}
        self.writers: Dict[Tuple[str, str, str], dict] = {}
        self.total_rows = {"trades": 0, "depth": 0, "mbo": 0}

    def _open_writer(self, key: Tuple[str, str, str]) -> dict:
        table, symbol, date = key
        part_dir = self.out_dir / table / f"symbol={symbol}" / f"date={date}"
        part_dir.mkdir(parents=True, exist_ok=True)
        # Write to .tmp then atomic rename on close — keeps in-flight files
        # invisible to DuckDB queries (it would error on missing magic bytes).
        final_path = part_dir / f"backfill-{self.file_basename}.parquet"
        tmp_path = part_dir / f".backfill-{self.file_basename}.parquet.tmp"
        writer = pq.ParquetWriter(
            str(tmp_path),
            SCHEMAS[table],
            compression=COMPRESSION,
            compression_level=COMPRESSION_LEVEL,
        )
        entry = {
            "writer": writer,
            "buf": {name: [] for name in SCHEMAS[table].names},
            "path": final_path,
            "tmp_path": tmp_path,
            "rows": 0,
        }
        self.writers[key] = entry
        return entry

    def append(self, table: str, symbol: str, date: str, row: dict) -> None:
        key = (table, symbol, date)
        entry = self.writers.get(key) or self._open_writer(key)
        buf = entry["buf"]
        for col in buf:
            buf[col].append(row.get(col))
        entry["rows"] += 1
        if entry["rows"] >= BACKFILL_ROWGROUP_ROWS:
            self._flush(key)

    def _flush(self, key: Tuple[str, str, str]) -> None:
        entry = self.writers[key]
        if entry["rows"] == 0:
            return
        table = key[0]
        batch = pa.table(entry["buf"], schema=SCHEMAS[table])
        entry["writer"].write_table(batch)
        self.total_rows[table] += entry["rows"]
        entry["buf"] = {name: [] for name in SCHEMAS[table].names}
        entry["rows"] = 0

    def close(self) -> None:
        for key in list(self.writers.keys()):
            self._flush(key)
            entry = self.writers[key]
            entry["writer"].close()
            # Atomic rename .tmp → final. Only happens after the parquet
            # footer (magic bytes) is fully written, so partial files never
            # appear under the final name.
            tmp = entry.get("tmp_path")
            if tmp is not None and tmp.exists():
                os.replace(tmp, entry["path"])


def run_backfill(log_files: List[Path], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    ckpt_dir = out_dir / ".checkpoints"
    ckpt_dir.mkdir(exist_ok=True)

    for path in log_files:
        if not path.exists():
            print(f"[skip] {path} does not exist", file=sys.stderr)
            continue
        size = path.stat().st_size
        print(f"[backfill] {path.name}  ({size/1e9:.2f} GB)", flush=True)

        sinks = BackfillSinks(out_dir, file_basename=path.stem)
        t0 = time.time()
        n_total = n_parsed = n_unknown = 0
        last_report = t0

        try:
            with path.open("rb") as f:
                line_off = 0                    # byte offset of the current line start → seq
                for raw in f:
                    this_off = line_off
                    line_off += len(raw)
                    n_total += 1
                    try:
                        line = raw.decode("utf-8")
                    except UnicodeDecodeError:
                        n_unknown += 1
                        continue
                    parsed = parse_event(line)
                    if parsed is None:
                        n_unknown += 1
                        continue
                    table, sym, row = parsed
                    date = et_date_str(row["ts_ms"])
                    if date is None:        # corrupt/out-of-range ts_ms -> skip
                        n_unknown += 1
                        continue
                    row["seq"] = this_off       # capture-order key (see schema note)
                    sinks.append(table, sym, date, row)
                    n_parsed += 1

                    now = time.time()
                    if now - last_report > 30:
                        rate = n_total / (now - t0) if now > t0 else 0
                        print(
                            f"  ... {n_total:,} lines  parsed={n_parsed:,}  "
                            f"rate={rate/1000:.0f}k/s  elapsed={int(now-t0)}s",
                            flush=True,
                        )
                        last_report = now
        finally:
            sinks.close()

        # Mark this file as fully processed (checkpoint = full size)
        ckpt = ckpt_dir / f"{path.name}.ckpt"
        ckpt.write_text(json.dumps({"offset": size, "completed": True, "ts": time.time()}))

        dt = time.time() - t0
        print(
            f"[done]   {path.name}  parsed={n_parsed:,} unknown={n_unknown:,} "
            f"trades={sinks.total_rows['trades']:,} depth={sinks.total_rows['depth']:,} "
            f"mbo={sinks.total_rows['mbo']:,}  in {dt:.1f}s",
            flush=True,
        )


# ────────────────────────────────────────────────────────────────────────────
# Tail: follows files in DEFAULT_LOG_DIR, flushes small per-batch Parquet
# files (compactable later). Each flush emits a new unique file so the layout
# is append-only and crash-safe.
# ────────────────────────────────────────────────────────────────────────────

class TailBuffers:
    """Per (table, symbol, date) in-memory buffer; flush() writes a Parquet file."""

    def __init__(self, out_dir: Path):
        self.out_dir = out_dir
        # key -> {"buf": dict[col,list], "rows": int, "first_ts": int, "last_ts": int}
        self.bufs: Dict[Tuple[str, str, str], dict] = {}
        self.last_flush_ts = time.time()

    def append(self, table: str, symbol: str, date: str, row: dict) -> None:
        key = (table, symbol, date)
        entry = self.bufs.get(key)
        if entry is None:
            entry = {
                "buf": {name: [] for name in SCHEMAS[table].names},
                "rows": 0,
                "first_ts": row["ts_ms"],
                "last_ts": row["ts_ms"],
            }
            self.bufs[key] = entry
        for col in entry["buf"]:
            entry["buf"][col].append(row.get(col))
        entry["rows"] += 1
        entry["last_ts"] = row["ts_ms"]

    def total_rows(self) -> int:
        return sum(e["rows"] for e in self.bufs.values())

    def flush(self) -> int:
        n = 0
        for key, entry in list(self.bufs.items()):
            if entry["rows"] == 0:
                continue
            table, symbol, date = key
            part_dir = self.out_dir / table / f"symbol={symbol}" / f"date={date}"
            part_dir.mkdir(parents=True, exist_ok=True)
            fname = f"tail-{entry['first_ts']}-{entry['last_ts']}-{os.getpid()}.parquet"
            tmp_path = part_dir / f".{fname}.tmp"
            final_path = part_dir / fname
            batch = pa.table(entry["buf"], schema=SCHEMAS[table])
            pq.write_table(
                batch, str(tmp_path),
                compression=COMPRESSION, compression_level=COMPRESSION_LEVEL,
            )
            os.replace(tmp_path, final_path)
            n += entry["rows"]
            del self.bufs[key]
        self.last_flush_ts = time.time()
        return n


def _load_ckpt(ckpt_path: Path) -> int:
    if not ckpt_path.exists():
        return 0
    try:
        return int(json.loads(ckpt_path.read_text()).get("offset", 0))
    except Exception:
        return 0


def _save_ckpt(ckpt_path: Path, offset: int) -> None:
    tmp = ckpt_path.with_suffix(ckpt_path.suffix + ".tmp")
    tmp.write_text(json.dumps({"offset": offset, "ts": time.time()}))
    os.replace(tmp, ckpt_path)


def run_tail(log_dir: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    ckpt_dir = out_dir / ".checkpoints"
    ckpt_dir.mkdir(exist_ok=True)

    buffers = TailBuffers(out_dir)
    bad_lines = [0]  # corrupt lines skipped (boxed so the inner loop can mutate it)

    # file read positions (in-memory) and the checkpoint path for each log file.
    offsets: Dict[Path, int] = {}
    ckpts: Dict[Path, Path] = {}
    leftover: Dict[Path, bytes] = {}

    def _persist_checkpoints() -> None:
        # Only call AFTER a successful flush: at that point every row read up to
        # offsets[path] is durably in parquet, so it's safe to advance the
        # on-disk checkpoint past it.
        for p, o in offsets.items():
            ck = ckpts.get(p)
            if ck is not None:
                _save_ckpt(ck, o)

    stop = {"flag": False}
    def _sig(_s, _f):
        stop["flag"] = True
    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)

    print(f"[tail] watching {log_dir}  →  {out_dir}", flush=True)

    while not stop["flag"]:
        # Refresh file list each tick — new .log files appear at calendar-day rollover.
        files = sorted(log_dir.glob("*.log"))
        for path in files:
            ck = ckpt_dir / f"{path.name}.ckpt"
            ckpts[path] = ck
            if path not in offsets:
                offsets[path] = _load_ckpt(ck)
                leftover[path] = b""

            try:
                size = path.stat().st_size
            except FileNotFoundError:
                continue

            off = offsets[path]
            if off > size:
                # Capture files are per-calendar-day (never rotated under one name),
                # so a "shrink" is almost always a read-during-write race: stat()
                # caught the live file a few bytes short mid-append. The old code
                # re-read the WHOLE multi-GB file from 0 on ANY shrink (even 2 bytes),
                # re-emitting ~23M rows every tick and pinning a CPU core in a loop.
                # Only a large drop is a real truncation worth re-reading; a small one
                # we wait out — the live file grows back past our offset and we resume
                # cleanly (no re-read, no dups).
                if off - size > 10 * 1024 * 1024:   # >10 MB = genuine truncation/reset
                    print(f"[warn] {path.name} truncated ({off} -> {size}); re-reading "
                          f"from 0 (dup rows expected, compaction will dedup)", flush=True)
                    off = 0
                    leftover[path] = b""
                else:
                    continue  # transient write-race shrink — skip, resume when it regrows
            if size <= off:
                continue

            with path.open("rb") as f:
                f.seek(off)
                chunk = f.read(size - off)

            data = leftover[path] + chunk
            lines = data.split(b"\n")
            # Last fragment may be a partial line — stash it.
            leftover[path] = lines[-1]
            consumed_bytes = len(data) - len(lines[-1])

            # byte offset (in the FILE) of the first byte of `data` → per-line seq
            base_off = off - len(data) + len(chunk)
            pos = 0
            for raw in lines[:-1]:
                this_off = base_off + pos
                pos += len(raw) + 1             # +1 for the split '\n'
                if not raw:
                    continue
                try:
                    parsed = parse_event(raw.decode("utf-8"))
                except Exception:
                    # A single corrupt line (bad utf-8, non-string alias, malformed
                    # field) must NEVER crash the tail — that re-reads from the last
                    # checkpoint and re-hits the same line forever (286 such crashes
                    # on 2026-06-25 before this guard). Skip it, count it, move on.
                    bad_lines[0] += 1
                    continue
                if parsed is None:
                    continue
                table, sym, row = parsed
                date = et_date_str(row["ts_ms"])
                if date is None:            # corrupt/out-of-range ts_ms -> skip
                    continue
                row["seq"] = this_off           # capture-order key (see schema note)
                buffers.append(table, sym, date, row)

            # Advance the in-memory read position only. The on-disk checkpoint
            # is persisted AFTER the next successful flush (see below) so a hard
            # crash between read and flush re-reads rather than loses rows.
            offsets[path] = off + consumed_bytes

        # Flush triggers. Order is flush -> persist-checkpoints (at-least-once):
        # never advance a checkpoint past data that isn't yet in parquet.
        now = time.time()
        if (
            buffers.total_rows() >= TAIL_FLUSH_ROWS
            or (buffers.total_rows() > 0 and (now - buffers.last_flush_ts) >= TAIL_FLUSH_SECONDS)
        ):
            n = buffers.flush()
            if n:
                _persist_checkpoints()
                bad = f"  (skipped {bad_lines[0]:,} corrupt lines)" if bad_lines[0] else ""
                print(f"[flush] {n:,} rows{bad}", flush=True)

        time.sleep(TAIL_POLL_SECONDS)

    # Drain on shutdown: flush, then persist checkpoints past the flushed rows.
    n = buffers.flush()
    if n:
        _persist_checkpoints()
    print(f"[shutdown] final flush {n:,} rows", flush=True)


# ────────────────────────────────────────────────────────────────────────────
# Entrypoint
# ────────────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR, help="Output parquet root")
    sub = ap.add_subparsers(dest="mode", required=True)

    bf = sub.add_parser("backfill", help="Process whole .log files end-to-end")
    bf.add_argument("files", nargs="*", help="Specific .log files; default = all in capture dir not yet completed")
    bf.add_argument("--log-dir", type=Path, default=DEFAULT_LOG_DIR)
    bf.add_argument("--force", action="store_true", help="Reprocess files even if .ckpt says completed")

    tl = sub.add_parser("tail", help="Follow .log files continuously")
    tl.add_argument("--log-dir", type=Path, default=DEFAULT_LOG_DIR)

    args = ap.parse_args()
    out_dir = args.out.resolve()

    if args.mode == "backfill":
        if args.files:
            files = [Path(p).resolve() for p in args.files]
        else:
            files = sorted(args.log_dir.glob("*.log"))
        if not args.force:
            ckpt_dir = out_dir / ".checkpoints"
            files = [p for p in files if not (ckpt_dir / f"{p.name}.ckpt").exists()
                     or not json.loads((ckpt_dir / f"{p.name}.ckpt").read_text()).get("completed")]
        if not files:
            print("nothing to backfill (all .log files already completed; use --force to redo)")
            return 0
        print(f"[plan] {len(files)} file(s) to backfill into {out_dir}")
        run_backfill(files, out_dir)
        return 0

    if args.mode == "tail":
        run_tail(args.log_dir, out_dir)
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
