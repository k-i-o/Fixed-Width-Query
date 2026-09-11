/**
 * Record boundary detection over raw bytes.
 *
 * Everything here works on a chunk plus the absolute offset that chunk came from, so the
 * same code serves the indexer (sequential scan) and the row fetcher (random access).
 */

export type ResolvedLineEnding = 'lf' | 'crlf' | 'none';

const LF = 0x0a;
const CR = 0x0d;

/** Sniff the terminator from the head of the file. Never guess silently later on. */
export function detectLineEnding(sample: Uint8Array): ResolvedLineEnding {
  const limit = Math.min(sample.length, 64 * 1024);
  for (let i = 0; i < limit; i++) {
    if (sample[i] === LF) {
      return i > 0 && sample[i - 1] === CR ? 'crlf' : 'lf';
    }
  }
  // No terminator in the first 64 KB: either a single enormous line, or fixed-length
  // records with no terminator at all. The caller decides, using recordLength.
  return 'none';
}

/** UTF-8 BOM, which would otherwise become a stray character in the first cell. */
export function bomLength(sample: Uint8Array): number {
  return sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf ? 3 : 0;
}

export interface RecordSpan {
  /** Absolute byte offset of the first byte of the record. */
  readonly start: number;
  /** Absolute byte offset one past the last content byte, terminator excluded. */
  readonly end: number;
}

/**
 * Walk records forward from `fromAbsolute`, stopping at `limit` records or at the end of
 * the available bytes.
 *
 * `chunk` holds the file bytes starting at `chunkStart`. A record that runs past the end
 * of the chunk is not returned: the caller reads more and asks again. Returning a
 * truncated record would silently corrupt the last row of every block.
 */
export function walkRecords(
  chunk: Uint8Array,
  chunkStart: number,
  fromAbsolute: number,
  limit: number,
  lineEnding: ResolvedLineEnding,
  recordLength: number,
  isFinalChunk: boolean,
): RecordSpan[] {
  const spans: RecordSpan[] = [];

  if (lineEnding === 'none') {
    // Fixed-length records: pure arithmetic, no scanning at all.
    let position = fromAbsolute;
    while (spans.length < limit) {
      const relative = position - chunkStart;
      if (relative + recordLength > chunk.length) {
        break;
      }
      spans.push({ start: position, end: position + recordLength });
      position += recordLength;
    }
    return spans;
  }

  let cursor = fromAbsolute - chunkStart;
  while (spans.length < limit && cursor < chunk.length) {
    const lineFeed = chunk.indexOf(LF, cursor);
    if (lineFeed === -1) {
      // Trailing record with no terminator is real data, but only once we know there are
      // no more bytes coming.
      if (isFinalChunk && cursor < chunk.length) {
        spans.push({ start: chunkStart + cursor, end: chunkStart + chunk.length });
      }
      break;
    }
    // Tolerate mixed terminators: strip CR wherever it appears, whatever the schema says.
    const end = lineFeed > cursor && chunk[lineFeed - 1] === CR ? lineFeed - 1 : lineFeed;
    spans.push({ start: chunkStart + cursor, end: chunkStart + end });
    cursor = lineFeed + 1;
  }

  return spans;
}
