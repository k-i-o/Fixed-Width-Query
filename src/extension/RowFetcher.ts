/**
 * Resolving display rows into bytes, and bytes into cells.
 *
 * Extracted from `Session` for one reason: `Session` imports `vscode`, so nothing outside a
 * running VS Code instance could exercise the row path — which is precisely the code the
 * P1/P2 budgets are about. This module imports no VS Code API, so the performance probe
 * measures the same code the extension runs rather than a copy of it.
 */

import { createRecordParser } from '../core/parse/columns.js';
import { makeDecoder } from '../core/parse/decode.js';
import { walkRecords, type ResolvedLineEnding } from '../core/parse/records.js';
import type { SparseIndex } from '../core/index/sparseIndex.js';
import { encodeRows, RowsFlags } from '../shared/rowsCodec.js';
import type { RowRange } from '../shared/protocol.js';
import type { SchemaProfile } from '../shared/schema.js';
import type { FileHandleService } from './FileHandleService.js';

/** A query result: parallel arrays of record byte offsets and their source row numbers. */
export interface ResultSet {
  readonly offsets: Float64Array;
  readonly rowIndices: Float64Array;
}

const SAMPLE_RECORD_LIMIT = 200;
/** Upper bound on one record when the schema does not declare a fixed length. */
const MAX_UNBOUNDED_RECORD = 64 * 1024;

export class RowFetcher {
  constructor(
    private readonly file: FileHandleService,
    private schema: SchemaProfile,
    private lineEnding: ResolvedLineEnding,
    private dataStart: number,
  ) {}

  update(schema: SchemaProfile, lineEnding: ResolvedLineEnding, dataStart: number): void {
    this.schema = schema;
    this.lineEnding = lineEnding;
    this.dataStart = dataStart;
  }

  private get recordLength(): number {
    return this.schema.recordLength ?? 0;
  }

  /**
   * Raw record text for the ruler and for schema inference.
   * Bounded by construction: this is a sample, never the file.
   */
  async sampleRecords(limit: number): Promise<string[]> {
    const count = Math.min(limit, SAMPLE_RECORD_LIMIT);
    const span = this.lineEnding === 'none' && this.recordLength > 0
      ? this.recordLength * count
      : Math.min(1024 * 1024, this.file.size);

    const bytes = await this.file.read(this.dataStart, span);
    const spans = walkRecords(bytes, this.dataStart, this.dataStart, count, this.lineEnding, this.recordLength, true);
    const decode = makeDecoder(this.schema.encoding);
    return spans.map((record) => decode(bytes, record.start - this.dataStart, record.end - this.dataStart));
  }

  /** Every cell of the record starting at `offset`, for the streaming export writer. */
  async readRecordCells(offset: number): Promise<string[] | null> {
    const parser = createRecordParser(this.schema);
    const bytes = await this.file.read(offset, this.recordLength > 0 ? this.recordLength : MAX_UNBOUNDED_RECORD);
    const span = walkRecords(bytes, offset, offset, 1, this.lineEnding, this.recordLength, true)[0];
    if (!span) {
      return null;
    }
    parser.parse(bytes, span.start - offset, span.end - offset);
    const cells: string[] = [];
    for (let column = 0; column < parser.columnCount; column++) {
      cells.push(parser.text(column));
    }
    return cells;
  }

  /**
   * Resolve a range of display rows into an encoded payload.
   *
   * With a result set, offsets come straight from the query worker and no index lookup
   * happens at all. Otherwise the sparse index gives the nearest checkpoint and we walk
   * forward from there — at most `stride` records, which is one page read in practice.
   */
  async fetchRows(index: SparseIndex, range: RowRange, result: ResultSet | null): Promise<Uint8Array> {
    const parser = createRecordParser(this.schema);
    const columnCount = Math.max(1, parser.columnCount);
    const rowIndices = new Float64Array(range.count);
    const cells: string[] = [];
    let produced = 0;

    if (result) {
      const available = Math.max(0, Math.min(range.count, result.offsets.length - range.from));
      for (let i = 0; i < available; i++) {
        const offset = result.offsets[range.from + i] ?? 0;
        const bytes = await this.file.read(offset, this.recordLength > 0 ? this.recordLength : MAX_UNBOUNDED_RECORD);
        const span = walkRecords(bytes, offset, offset, 1, this.lineEnding, this.recordLength, true)[0];
        if (!span) {
          continue;
        }
        parser.parse(bytes, span.start - offset, span.end - offset);
        rowIndices[produced] = result.rowIndices[range.from + i] ?? 0;
        for (let column = 0; column < columnCount; column++) {
          cells.push(parser.text(column));
        }
        produced++;
      }
    } else {
      const { anchorRow, byteOffset } = index.locate(range.from);
      const skipAhead = range.from - anchorRow;
      const wanted = skipAhead + range.count;

      // Size the read from what the file actually looks like. `averageRecordBytes` comes
      // from checkpoint spacing, so it is measured rather than assumed; the 1.5x headroom
      // plus a fixed slack covers local variation in record length. If it still comes up
      // short we read again below — a truncated block would render as blank rows the user
      // cannot tell apart from genuinely empty data.
      const measured = index.averageRecordBytes;
      const estimatedRecord = this.recordLength > 0 ? this.recordLength : measured > 0 ? measured * 1.5 : 512;
      const needed = Math.ceil((wanted + 2) * estimatedRecord) + 4096;

      let bytes = await this.file.read(byteOffset, Math.min(needed, 16 * 1024 * 1024));
      let atEof = byteOffset + bytes.length >= this.file.size;
      let spans = walkRecords(bytes, byteOffset, byteOffset, wanted, this.lineEnding, this.recordLength, atEof);

      if (spans.length < wanted && !atEof) {
        bytes = await this.file.read(byteOffset, Math.min(needed * 4, 64 * 1024 * 1024));
        atEof = byteOffset + bytes.length >= this.file.size;
        spans = walkRecords(bytes, byteOffset, byteOffset, wanted, this.lineEnding, this.recordLength, atEof);
      }

      for (let i = skipAhead; i < spans.length && produced < range.count; i++) {
        const span = spans[i];
        if (!span) {
          break;
        }
        parser.parse(bytes, span.start - byteOffset, span.end - byteOffset);
        rowIndices[produced] = anchorRow + i;
        for (let column = 0; column < columnCount; column++) {
          cells.push(parser.text(column));
        }
        produced++;
      }
    }

    return encodeRows({
      rowCount: produced,
      columnCount,
      sourceRowIndex: rowIndices,
      cells,
      flags: result ? RowsFlags.ResultView : RowsFlags.None,
    });
  }
}
