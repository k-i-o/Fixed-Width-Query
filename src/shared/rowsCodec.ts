/**
 * Binary envelope for a block of rows.
 *
 * One allocation per response. The VS Code webview API takes no transfer list, so the host
 * copies this buffer once on the way out; what it does not do is turn it into JSON. The
 * alternative — an array of row objects through the serializer — costs roughly an order of
 * magnitude more and is the single most common reason grids like this one stutter.
 *
 * Layout (little-endian, the only byte order any VS Code host runs on):
 *
 *   offset 0            u32   magic 'FWQ1'
 *   offset 4            u32   rowCount
 *   offset 8            u32   columnCount
 *   offset 12           u32   flags
 *   offset 16           f64   sourceRowIndex[rowCount]      8-byte aligned by construction
 *   offset 16 + 8R      u32   cellEnd[rowCount * columnCount]   prefix-sum into textBlock
 *   offset ...          u8    textBlock (UTF-8, no separators)
 *
 * `cellEnd` stores end offsets only; a cell's start is the previous entry, or 0 for the
 * first cell. That saves 4 bytes per cell and removes the off-by-one that a start/end
 * pair invites.
 */

const MAGIC = 0x46575131; // 'FWQ1'
const HEADER_BYTES = 16;

export const enum RowsFlags {
  None = 0,
  /** Rows come from a query result, so sourceRowIndex is not contiguous. */
  ResultView = 1 << 0,
}

export interface EncodeRowsInput {
  readonly rowCount: number;
  readonly columnCount: number;
  /** Source row index per row, for the line-number gutter. */
  readonly sourceRowIndex: Float64Array;
  /** Flat, row-major, length rowCount * columnCount. */
  readonly cells: readonly string[];
  readonly flags: RowsFlags;
}

export function encodeRows(input: EncodeRowsInput): Uint8Array {
  const { rowCount, columnCount, sourceRowIndex, cells, flags } = input;
  const cellCount = rowCount * columnCount;

  // Encode once into UTF-8 to size the buffer, then copy in. Encoding twice would be
  // simpler to write and twice as expensive on the hot path.
  const encoder = new TextEncoder();
  const encoded: Uint8Array[] = new Array(cellCount);
  let textBytes = 0;
  for (let i = 0; i < cellCount; i++) {
    const bytes = encoder.encode(cells[i] ?? '');
    encoded[i] = bytes;
    textBytes += bytes.length;
  }

  const indexBytes = rowCount * 8;
  const offsetBytes = cellCount * 4;
  const total = HEADER_BYTES + indexBytes + offsetBytes + textBytes;

  const buffer = new ArrayBuffer(total);
  const header = new DataView(buffer);
  header.setUint32(0, MAGIC, true);
  header.setUint32(4, rowCount, true);
  header.setUint32(8, columnCount, true);
  header.setUint32(12, flags, true);

  new Float64Array(buffer, HEADER_BYTES, rowCount).set(sourceRowIndex.subarray(0, rowCount));

  const cellEnd = new Uint32Array(buffer, HEADER_BYTES + indexBytes, cellCount);
  const text = new Uint8Array(buffer, HEADER_BYTES + indexBytes + offsetBytes, textBytes);

  let cursor = 0;
  for (let i = 0; i < cellCount; i++) {
    const bytes = encoded[i] as Uint8Array;
    text.set(bytes, cursor);
    cursor += bytes.length;
    cellEnd[i] = cursor;
  }

  return new Uint8Array(buffer);
}

/**
 * Read-only view over an encoded block. Cells are decoded on demand, so a 200-column
 * record costs nothing for the 190 columns currently scrolled out of view.
 */
export class RowsView {
  readonly rowCount: number;
  readonly columnCount: number;
  readonly flags: number;

  private readonly sourceRowIndex: Float64Array;
  private readonly cellEnd: Uint32Array;
  private readonly text: Uint8Array;
  private readonly decoder = new TextDecoder('utf-8');

  constructor(payload: Uint8Array) {
    // A transferred Uint8Array can land at an arbitrary byteOffset, and Float64Array
    // refuses anything not 8-byte aligned. Copy only in that rare case.
    const aligned = payload.byteOffset % 8 === 0 ? payload : new Uint8Array(payload);
    const { buffer, byteOffset } = aligned;

    const header = new DataView(buffer, byteOffset, HEADER_BYTES);
    if (header.getUint32(0, true) !== MAGIC) {
      throw new Error('Malformed rows payload: bad magic.');
    }
    this.rowCount = header.getUint32(4, true);
    this.columnCount = header.getUint32(8, true);
    this.flags = header.getUint32(12, true);

    const cellCount = this.rowCount * this.columnCount;
    const indexBytes = this.rowCount * 8;
    const offsetBytes = cellCount * 4;

    this.sourceRowIndex = new Float64Array(buffer, byteOffset + HEADER_BYTES, this.rowCount);
    this.cellEnd = new Uint32Array(buffer, byteOffset + HEADER_BYTES + indexBytes, cellCount);
    this.text = new Uint8Array(
      buffer,
      byteOffset + HEADER_BYTES + indexBytes + offsetBytes,
      aligned.byteLength - HEADER_BYTES - indexBytes - offsetBytes,
    );
  }

  rowIndexAt(row: number): number {
    return this.sourceRowIndex[row] ?? 0;
  }

  cell(row: number, column: number): string {
    const i = row * this.columnCount + column;
    if (i < 0 || i >= this.cellEnd.length) {
      return '';
    }
    const end = this.cellEnd[i] ?? 0;
    const start = i === 0 ? 0 : (this.cellEnd[i - 1] ?? 0);
    if (end <= start) {
      return '';
    }
    return this.decoder.decode(this.text.subarray(start, end));
  }
}
