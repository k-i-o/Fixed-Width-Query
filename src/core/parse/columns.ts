/**
 * Turning a record into columns.
 *
 * A single `RecordParser` interface backs both modes, so the row fetcher, the query
 * executor and the export writer all have exactly one code path. The interface is
 * deliberately imperative — `parse()` then read — because allocating a result object per
 * record would dominate a billion-row scan.
 */

import type { ColumnDef, SchemaProfile } from '../../shared/schema.js';
import { isBlankRange, makeDecoder, parseNumericBytes, trimRange, type Decoder } from './decode.js';

export interface RecordParser {
  readonly columnCount: number;
  readonly columnNames: readonly string[];

  /** Point the parser at one record. Cheap: no decoding happens until a cell is read. */
  parse(buffer: Uint8Array, start: number, end: number): void;

  /**
   * Raw bytes of a column, or null when the mode cannot offer them (regex splitting
   * produces strings, not byte ranges). Predicates use this for the allocation-free path
   * and fall back to `text()` when it returns null.
   */
  bytes(column: number): Uint8Array | null;

  text(column: number): string;
  number(column: number): number;
  isEmpty(column: number): boolean;

  /** The whole record as text, for the ruler sample and for regex matching. */
  raw(): string;
}

/**
 * Fixed-width parsing.
 *
 * Column offsets are BYTE offsets, not character offsets. For the latin1/ascii encodings
 * this format actually occurs in, the two are identical. Under utf8 they diverge, and
 * byte offsets are the honest interpretation: the record layout was defined in bytes by
 * whatever wrote the file.
 */
export class FixedWidthRecordParser implements RecordParser {
  readonly columnCount: number;
  readonly columnNames: readonly string[];

  private readonly columns: readonly ColumnDef[];
  private readonly decoder: Decoder;

  private buffer: Uint8Array = new Uint8Array(0);
  private recordStart = 0;
  private recordEnd = 0;

  // Memoized decoded cells. Instead of clearing the whole array per record — which costs
  // columnCount writes on every one of a billion records — we clear only what was read.
  private readonly textMemo: (string | undefined)[];
  private readonly touched: number[] = [];

  constructor(schema: SchemaProfile) {
    this.columns = schema.columns;
    this.columnCount = schema.columns.length;
    this.columnNames = schema.columns.map((c) => c.name);
    this.decoder = makeDecoder(schema.encoding);
    this.textMemo = new Array<string | undefined>(this.columnCount).fill(undefined);
  }

  parse(buffer: Uint8Array, start: number, end: number): void {
    this.buffer = buffer;
    this.recordStart = start;
    this.recordEnd = end;
    while (this.touched.length > 0) {
      this.textMemo[this.touched.pop() as number] = undefined;
    }
  }

  /** Field ranges are clamped: a short record simply yields short or empty cells. */
  private range(column: number): { start: number; end: number } | null {
    const def = this.columns[column];
    if (!def) {
      return null;
    }
    const start = Math.min(this.recordStart + def.start, this.recordEnd);
    const end = Math.min(start + def.length, this.recordEnd);
    return end > start ? { start, end } : { start, end: start };
  }

  bytes(column: number): Uint8Array | null {
    const range = this.range(column);
    if (!range) {
      return null;
    }
    const def = this.columns[column];
    const trimmed = def ? trimRange(this.buffer, range.start, range.end, def.trim) : range;
    return this.buffer.subarray(trimmed.start, trimmed.end);
  }

  text(column: number): string {
    const cached = this.textMemo[column];
    if (cached !== undefined) {
      return cached;
    }
    const range = this.range(column);
    const def = this.columns[column];
    let value = '';
    if (range && def) {
      const trimmed = trimRange(this.buffer, range.start, range.end, def.trim);
      value = this.decoder(this.buffer, trimmed.start, trimmed.end);
    }
    this.textMemo[column] = value;
    this.touched.push(column);
    return value;
  }

  number(column: number): number {
    const range = this.range(column);
    const def = this.columns[column];
    if (!range || !def) {
      return Number.NaN;
    }
    return parseNumericBytes(this.buffer, range.start, range.end, {
      scale: def.scale,
      signed: def.signed,
    });
  }

  isEmpty(column: number): boolean {
    const range = this.range(column);
    return !range || isBlankRange(this.buffer, range.start, range.end);
  }

  raw(): string {
    return this.decoder(this.buffer, this.recordStart, this.recordEnd);
  }
}

/**
 * Regex parsing, in two flavours:
 *  - `split`: the pattern is a separator (\s{2,}, \t, \|)
 *  - `match`: the pattern spans the record and its capture groups are the columns
 *
 * Both require decoding the whole record, which is why fixed-width mode is meaningfully
 * faster and should be preferred whenever the file actually is fixed-width.
 */
export class RegexRecordParser implements RecordParser {
  readonly columnCount: number;
  readonly columnNames: readonly string[];

  private readonly pattern: RegExp;
  private readonly mode: 'split' | 'match';
  private readonly decoder: Decoder;
  private readonly columns: readonly ColumnDef[];

  private fields: string[] = [];
  private rawText = '';

  constructor(schema: SchemaProfile) {
    this.decoder = makeDecoder(schema.encoding);
    this.mode = schema.regexMode ?? 'split';
    this.columns = schema.columns;
    this.columnCount = schema.columns.length;
    this.columnNames = schema.columns.map((c) => c.name);

    // The pattern is validated in the host before it ever reaches here, and this parser
    // only ever runs inside a worker, so a catastrophic pattern costs a worker, not the window.
    const flags = (schema.regexFlags ?? '').replace(/[gy]/g, '');
    this.pattern = new RegExp(schema.pattern ?? '\\s{2,}', flags);
  }

  parse(buffer: Uint8Array, start: number, end: number): void {
    this.rawText = this.decoder(buffer, start, end);
    if (this.mode === 'split') {
      this.fields = this.rawText.split(this.pattern);
    } else {
      const match = this.pattern.exec(this.rawText);
      // A non-matching record yields empty cells rather than being dropped: hiding rows
      // that failed to parse is how people lose data without noticing.
      this.fields = match ? match.slice(1).map((value) => value ?? '') : [];
    }
  }

  bytes(): Uint8Array | null {
    return null; // Split results are strings; no byte range corresponds to them.
  }

  text(column: number): string {
    const value = this.fields[column] ?? '';
    const trim = this.columns[column]?.trim ?? 'both';
    if (trim === 'both') {
      return value.trim();
    }
    if (trim === 'left') {
      return value.replace(/^\s+/, '');
    }
    if (trim === 'right') {
      return value.replace(/\s+$/, '');
    }
    return value;
  }

  number(column: number): number {
    const value = this.text(column);
    if (value === '') {
      return Number.NaN;
    }
    const parsed = Number(value.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }

  isEmpty(column: number): boolean {
    return this.text(column).trim() === '';
  }

  raw(): string {
    return this.rawText;
  }
}

export function createRecordParser(schema: SchemaProfile): RecordParser {
  return schema.mode === 'fixed' ? new FixedWidthRecordParser(schema) : new RegexRecordParser(schema);
}

/**
 * Infer columns for a regex schema by sampling records, since a split pattern does not
 * declare how many fields it will produce. Called whenever the user changes the pattern.
 */
export function inferRegexColumns(schema: SchemaProfile, sampleRecords: readonly string[]): ColumnDef[] {
  const mode = schema.regexMode ?? 'split';
  const flags = (schema.regexFlags ?? '').replace(/[gy]/g, '');
  let pattern: RegExp;
  try {
    pattern = new RegExp(schema.pattern ?? '\\s{2,}', flags);
  } catch {
    return [];
  }

  let count = 0;
  for (const record of sampleRecords) {
    const fields = mode === 'split' ? record.split(pattern) : (pattern.exec(record)?.length ?? 1) - 1;
    count = Math.max(count, typeof fields === 'number' ? fields : fields.length);
  }

  const columns: ColumnDef[] = [];
  for (let i = 0; i < count; i++) {
    columns.push({ name: `col${i + 1}`, start: 0, length: 0, type: 'string', trim: 'both' });
  }
  return columns;
}
