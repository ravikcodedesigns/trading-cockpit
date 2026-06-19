// Live tailer for the Bookmap MBO capture .log (JSON-lines).
//
// Follows a single .log file forward from a start offset (default = current EOF,
// i.e. live tail). Reads new bytes on a short poll, splits on newlines, buffers a
// trailing partial line across polls, and dispatches each parsed event. This is
// the SAME source the parquet converter tails at a 1s poll — but read directly so
// live triggers see events sub-second, not after the 20–60s parquet flush window.

import fs from 'node:fs';

export interface LogEvent {
  kind: string;
  data: Record<string, any>;
  ts_ms: number;
  alias: string;
}

export interface TailHandle {
  stop: () => void;
}

/**
 * Tail `path`, invoking `onEvent` for each JSON line.
 * @param opts.fromStart  start at byte 0 instead of EOF (replay the whole file)
 * @param opts.pollMs     poll interval (default 200ms)
 */
export function tailLog(
  path: string,
  onEvent: (e: LogEvent) => void,
  opts: { fromStart?: boolean; pollMs?: number } = {},
): TailHandle {
  const pollMs = opts.pollMs ?? 200;
  let pos = opts.fromStart ? 0 : safeSize(path);
  let buf = '';
  let busy = false;

  const tick = (): void => {
    if (busy) return;
    let size: number;
    try { size = fs.statSync(path).size; } catch { return; } // file gone/rotating
    if (size < pos) { pos = 0; buf = ''; } // truncated/rotated → restart
    if (size <= pos) return;
    busy = true;
    const start = pos;
    const end = size - 1;
    const stream = fs.createReadStream(path, { start, end, encoding: 'utf8' });
    let chunkBuf = '';
    stream.on('data', (c) => { chunkBuf += c; });
    stream.on('error', () => { busy = false; });
    stream.on('end', () => {
      pos = size;
      buf += chunkBuf;
      const lines = buf.split('\n');
      buf = lines.pop() ?? ''; // keep trailing partial line for next poll
      for (const line of lines) {
        if (!line) continue;
        let e: LogEvent;
        try { e = JSON.parse(line); } catch { continue; } // skip torn/garbage line
        onEvent(e);
      }
      busy = false;
    });
  };

  const id = setInterval(tick, pollMs);
  return { stop: () => clearInterval(id) };
}

function safeSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}
