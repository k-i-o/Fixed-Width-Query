/**
 * Query worker: one sequential pass over the file, evaluating a compiled predicate.
 *
 * Only byte offsets and row indices come back — never row content. That is late
 * materialization, and it is what keeps a query matching ten million rows inside the
 * 32 MB result budget: the grid asks for the handful of rows it actually displays.
 *
 * The host cancels by terminating this worker. That is coarse on purpose: it cannot fail
 * to take effect, and there is no partial state worth preserving.
 */

import { createReadStream } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { createRecordParser } from '../core/parse/columns.js';
import { walkRecords } from '../core/parse/records.js';
import { compileQuery } from '../core/query/compile.js';
import type { QueryMessage, QueryRequest } from '../shared/workerProtocol.js';

const port = parentPort;
if (!port) {
  throw new Error('query.worker must run as a worker thread.');
}

const request = workerData as QueryRequest;
const FLUSH_INTERVAL_MS = 100;

// A TypedArray's .buffer is typed ArrayBufferLike because it could in principle be a
// SharedArrayBuffer. Ours never is — every one is allocated here — so the cast is narrowing
// a possibility that does not exist rather than hiding one that does.
function post(message: QueryMessage, transfer: ArrayBufferLike[] = []): void {
  port!.postMessage(message, transfer as ArrayBuffer[]);
}

/**
 * Bounded top-N, so ORDER BY with a LIMIT never holds more than N rows.
 *
 * Kept as a plain array with a linear insert rather than a binary heap: N is a user-facing
 * LIMIT, almost always under a few thousand, and at that size the simpler structure with
 * better cache behaviour wins outright.
 */
class TopN {
  private readonly entries: { key: number | string; offset: number; rowIndex: number }[] = [];

  constructor(
    private readonly limit: number,
    private readonly descending: boolean,
  ) {}

  private worseThanLast(key: number | string): boolean {
    const last = this.entries[this.entries.length - 1];
    if (!last) {
      return false;
    }
    return this.descending ? key <= last.key : key >= last.key;
  }

  offer(key: number | string, offset: number, rowIndex: number): void {
    if (this.entries.length >= this.limit && this.worseThanLast(key)) {
      return;
    }
    let position = this.entries.length;
    while (position > 0) {
      const previous = this.entries[position - 1] as { key: number | string };
      const better = this.descending ? key > previous.key : key < previous.key;
      if (!better) {
        break;
      }
      position--;
    }
    this.entries.splice(position, 0, { key, offset, rowIndex });
    if (this.entries.length > this.limit) {
      this.entries.length = this.limit;
    }
  }

  drain(offset: number): { offsets: Float64Array; rowIndices: Float64Array } {
    const kept = this.entries.slice(offset);
    const offsets = new Float64Array(kept.length);
    const rowIndices = new Float64Array(kept.length);
    for (let i = 0; i < kept.length; i++) {
      const entry = kept[i] as { offset: number; rowIndex: number };
      offsets[i] = entry.offset;
      rowIndices[i] = entry.rowIndex;
    }
    return { offsets, rowIndices };
  }
}

/**
 * Growable Float64 buffer, and the single place a result lives.
 *
 * An earlier version also pushed every match onto a parallel JS array so the final message
 * could be built from it. That doubled the memory of every query for no benefit: this
 * buffer already holds the complete result, and a progressive batch is just the window
 * added since the last flush.
 */
class OffsetBuffer {
  private data = new Float64Array(4096);
  private count = 0;

  push(value: number): void {
    if (this.count === this.data.length) {
      const grown = new Float64Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.count++] = value;
  }

  get length(): number {
    return this.count;
  }

  /** Copy of [from, to) — the copy is required, since it gets transferred away. */
  slice(from: number, to: number): Float64Array {
    return this.data.slice(Math.max(0, from), Math.min(this.count, to));
  }
}

function encodeLiteral(literal: string, encoding: string): Buffer {
  return Buffer.from(literal, encoding === 'utf8' ? 'utf8' : 'latin1');
}

async function run(): Promise<void> {
  const started = Date.now();
  const compiled = compileQuery(request.statement, request.schema);
  const parser = createRecordParser(request.schema);
  const predicate = compiled.predicate;

  const lineEnding = request.lineEnding;
  const recordLength = request.recordLength;
  const skipRecords = request.schema.skipRecords ?? 0;

  const ordering = compiled.orderColumn !== null && compiled.limit !== null
    ? new TopN(compiled.limit + compiled.offset, compiled.orderDirection === 'desc')
    : null;
  const orderColumn = compiled.orderColumn;
  const orderIsNumeric = orderColumn !== null &&
    (request.schema.columns[orderColumn]?.type === 'number' || request.schema.columns[orderColumn]?.type === 'decimal');

  const literal = compiled.literalPrefilter ? encodeLiteral(compiled.literalPrefilter, request.schema.encoding) : null;

  const matchOffsets = new OffsetBuffer();
  const matchRows = new OffsetBuffer();
  /** How much of the result has already been sent as a progressive batch. */
  let flushedCount = 0;

  let rowIndex = 0;
  let matched = 0;
  let truncated = false;
  let lastFlush = Date.now();

  const stream = createReadStream(request.path, {
    start: request.dataStart,
    highWaterMark: request.chunkBytes,
  });

  let carry = new Uint8Array(0);
  let carryStart = request.dataStart;

  const flush = (force: boolean): void => {
    const now = Date.now();
    if (!force && now - lastFlush < FLUSH_INTERVAL_MS) {
      return;
    }
    lastFlush = now;

    // Partial batches are suppressed for sorted queries: showing rows that the final sort
    // will reorder is worse than showing a progress count.
    if (ordering || matchOffsets.length === flushedCount) {
      post({ type: 'progress', scannedBytes: carryStart - request.dataStart, matched });
      return;
    }
    const offsets = matchOffsets.slice(flushedCount, matchOffsets.length);
    const rowIndices = matchRows.slice(flushedCount, matchRows.length);
    flushedCount = matchOffsets.length;
    post(
      { type: 'batch', offsets, rowIndices, scannedBytes: carryStart - request.dataStart, matched },
      [offsets.buffer, rowIndices.buffer],
    );
  };

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const incoming = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);

      // Join the tail of the previous chunk: a record split across a block boundary is the
      // single most common source of silent corruption in scanners like this one.
      let buffer: Uint8Array;
      if (carry.length === 0) {
        buffer = incoming;
      } else {
        buffer = new Uint8Array(carry.length + incoming.length);
        buffer.set(carry, 0);
        buffer.set(incoming, carry.length);
      }
      const bufferStart = carryStart;

      // Block-level prefilter: if a mandatory literal is absent from the whole block, no
      // record inside it can match, so only the row count needs maintaining.
      const blockCanMatch =
        !literal || Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).includes(literal);

      let consumed = 0;
      for (;;) {
        const spans = walkRecords(
          buffer,
          bufferStart,
          bufferStart + consumed,
          4096,
          lineEnding,
          recordLength,
          false,
        );
        if (spans.length === 0) {
          break;
        }

        for (const span of spans) {
          const currentRow = rowIndex++;
          if (currentRow < skipRecords) {
            continue;
          }
          if (!blockCanMatch) {
            continue;
          }

          parser.parse(buffer, span.start - bufferStart, span.end - bufferStart);
          if (predicate && !predicate(parser)) {
            continue;
          }

          matched++;
          if (ordering && orderColumn !== null) {
            const key = orderIsNumeric ? parser.number(orderColumn) : parser.text(orderColumn);
            ordering.offer(Number.isNaN(key as number) ? Number.POSITIVE_INFINITY : key, span.start, currentRow);
          } else {
            matchOffsets.push(span.start);
            matchRows.push(currentRow);
            if (matched >= request.maxResults) {
              truncated = true;
              break;
            }
          }
        }

        const last = spans[spans.length - 1];
        if (!last) {
          break;
        }
        // Advance past the terminator of the final complete record in this pass.
        consumed = last.end - bufferStart + (lineEnding === 'crlf' ? 2 : lineEnding === 'lf' ? 1 : 0);
        if (truncated) {
          break;
        }
      }

      if (truncated) {
        break;
      }

      carry = buffer.slice(consumed);
      carryStart = bufferStart + consumed;
      flush(false);
    }

    // Whatever is left in the carry after EOF is the final, unterminated record.
    if (!truncated && carry.length > 0) {
      const spans = walkRecords(carry, carryStart, carryStart, 4096, lineEnding, recordLength, true);
      for (const span of spans) {
        const currentRow = rowIndex++;
        if (currentRow < skipRecords) {
          continue;
        }
        parser.parse(carry, span.start - carryStart, span.end - carryStart);
        if (predicate && !predicate(parser)) {
          continue;
        }
        matched++;
        if (ordering && orderColumn !== null) {
          const key = orderIsNumeric ? parser.number(orderColumn) : parser.text(orderColumn);
          ordering.offer(Number.isNaN(key as number) ? Number.POSITIVE_INFINITY : key, span.start, currentRow);
        } else {
          matchOffsets.push(span.start);
          matchRows.push(currentRow);
        }
      }
      carryStart += carry.length;
    }

    const elapsedMs = Date.now() - started;

    if (ordering) {
      const { offsets, rowIndices } = ordering.drain(compiled.offset);
      post(
        {
          type: 'done',
          offsets,
          rowIndices,
          matched,
          scannedBytes: carryStart - request.dataStart,
          truncated,
          elapsedMs,
          replacesPartials: true,
        },
        [offsets.buffer, rowIndices.buffer],
      );
      return;
    }

    // Unsorted: LIMIT/OFFSET slice the match list in scan order.
    const start = compiled.offset;
    const end = compiled.limit === null ? matchOffsets.length : Math.min(matchOffsets.length, start + compiled.limit);
    const finalOffsets = matchOffsets.slice(start, end);
    const finalRows = matchRows.slice(start, end);

    post(
      {
        type: 'done',
        offsets: finalOffsets,
        rowIndices: finalRows,
        matched,
        scannedBytes: carryStart - request.dataStart,
        truncated,
        elapsedMs,
        replacesPartials: true,
      },
      [finalOffsets.buffer, finalRows.buffer],
    );
  } catch (error) {
    post({ type: 'failed', message: (error as Error).message });
  } finally {
    stream.destroy();
  }
}

void run();
