/**
 * Index worker: streams the file once, recording one offset every `stride` rows.
 *
 * Runs off the extension host thread because this is the one operation whose duration is
 * proportional to file size. On the host it would freeze the entire VS Code window for as
 * long as the scan takes — minutes, on the files this extension exists for.
 *
 * Checkpoints are flushed incrementally rather than at the end, so the grid can navigate
 * the already-indexed prefix while the tail is still being scanned.
 */

import { createReadStream } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import type { IndexMessage, IndexRequest } from '../shared/workerProtocol.js';

const port = parentPort;
if (!port) {
  throw new Error('indexer.worker must run as a worker thread.');
}

const request = workerData as IndexRequest;
const LF = 0x0a;
const FLUSH_INTERVAL_MS = 150;

// A TypedArray's .buffer is typed ArrayBufferLike because it could in principle be a
// SharedArrayBuffer. Ours never is — every one is allocated here — so the cast is narrowing
// a possibility that does not exist rather than hiding one that does.
function post(message: IndexMessage, transfer: ArrayBufferLike[] = []): void {
  port!.postMessage(message, transfer as ArrayBuffer[]);
}

async function run(): Promise<void> {
  const stream = createReadStream(request.path, {
    start: request.dataStart,
    // A 64 KB default would multiply syscalls by 16 for no benefit; the scan is
    // throughput-bound, not latency-bound.
    highWaterMark: request.chunkBytes,
  });

  let pendingCheckpoints: number[] = [];
  let rows = 0;
  let bytesConsumed = request.dataStart;
  /** Absolute offset just past the last terminator seen, to detect an unterminated tail. */
  let lastTerminatorEnd = request.dataStart;
  let lastFlush = Date.now();

  const flush = (force: boolean): void => {
    const now = Date.now();
    if (!force && now - lastFlush < FLUSH_INTERVAL_MS) {
      return;
    }
    lastFlush = now;
    if (pendingCheckpoints.length === 0) {
      post({ type: 'checkpoints', offsets: new Float64Array(0), rows, bytes: bytesConsumed });
      return;
    }
    const offsets = Float64Array.from(pendingCheckpoints);
    pendingCheckpoints = [];
    post({ type: 'checkpoints', offsets, rows, bytes: bytesConsumed }, [offsets.buffer]);
  };

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let cursor = 0;
      for (;;) {
        const lineFeed = bytes.indexOf(LF, cursor);
        if (lineFeed === -1) {
          break;
        }
        rows++;
        // The row that starts after this terminator is the one a checkpoint points at.
        if (rows % request.stride === 0) {
          pendingCheckpoints.push(bytesConsumed + lineFeed + 1);
        }
        cursor = lineFeed + 1;
      }
      bytesConsumed += bytes.length;
      lastTerminatorEnd = cursor > 0 ? bytesConsumed - (bytes.length - cursor) : lastTerminatorEnd;
      flush(false);
    }

    // A final line with no terminator is still a record. Dropping it silently loses the
    // last row of every file that was written without a trailing newline.
    if (bytesConsumed > lastTerminatorEnd) {
      rows++;
      if (rows % request.stride === 0) {
        pendingCheckpoints.push(lastTerminatorEnd);
      }
    }

    flush(true);
    post({ type: 'done', rows, bytes: bytesConsumed });
  } catch (error) {
    post({ type: 'failed', message: (error as Error).message });
  } finally {
    stream.destroy();
  }
}

void run();
