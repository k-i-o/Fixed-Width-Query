/**
 * Schema profile: the user-authored description of how bytes become columns.
 * Serialized verbatim as `<file>.fwq.json` next to the data file.
 */

export type Encoding = 'utf8' | 'latin1' | 'ascii';

/**
 * `none` means records have no terminator and are exactly `recordLength` bytes long.
 * That is the high-value case: row N starts at N * recordLength, so the file needs no
 * index at all and opens in O(1) regardless of size.
 */
export type LineEnding = 'auto' | 'lf' | 'crlf' | 'none';

export type ColumnType = 'string' | 'number' | 'decimal';

export type TrimMode = 'none' | 'left' | 'right' | 'both';

export interface ColumnDef {
  readonly name: string;
  /** Byte offset of the field inside the record. Ignored in regex mode. */
  readonly start: number;
  /** Field length in bytes. Ignored in regex mode. */
  readonly length: number;
  readonly type: ColumnType;
  readonly trim: TrimMode;
  /** Decimal places implied by a field that stores no decimal point (COBOL style). */
  readonly scale?: number;
  /** `trailing` handles the mainframe convention of writing the sign after the digits. */
  readonly signed?: 'none' | 'leading' | 'trailing';
}

/**
 * `split` treats the pattern as a separator (`\s{2,}`, `\t`, `\|`).
 * `match` treats it as a whole-record pattern whose capture groups are the columns.
 */
export type RegexMode = 'split' | 'match';

export interface SchemaProfile {
  readonly version: 1;
  readonly mode: 'fixed' | 'regex';
  readonly encoding: Encoding;
  readonly lineEnding: LineEnding;
  /** Required when lineEnding is 'none'. */
  readonly recordLength?: number;
  readonly columns: readonly ColumnDef[];
  /** Required when mode is 'regex'. */
  readonly pattern?: string;
  readonly regexMode?: RegexMode;
  readonly regexFlags?: string;
  /** Skip this many leading records (report headers, banner lines). */
  readonly skipRecords?: number;
}

export const DEFAULT_SCHEMA: SchemaProfile = {
  version: 1,
  mode: 'regex',
  encoding: 'latin1',
  lineEnding: 'auto',
  columns: [],
  pattern: '\\s{2,}',
  regexMode: 'split',
  regexFlags: '',
  skipRecords: 0,
};

/** Column widths (a ruler result) become fixed-width column definitions. */
export function columnsFromWidths(widths: readonly number[], names?: readonly string[]): ColumnDef[] {
  const columns: ColumnDef[] = [];
  let start = 0;
  for (let i = 0; i < widths.length; i++) {
    const length = widths[i] ?? 0;
    if (length <= 0) {
      continue;
    }
    columns.push({
      name: names?.[i] ?? `col${i + 1}`,
      start,
      length,
      type: 'string',
      trim: 'both',
    });
    start += length;
  }
  return columns;
}

/** Ruler cut positions are absolute; adjacent cuts define the widths. */
export function widthsFromCuts(cuts: readonly number[], recordWidth: number): number[] {
  const sorted = [...new Set(cuts)].filter((c) => c > 0 && c < recordWidth).sort((a, b) => a - b);
  const widths: number[] = [];
  let previous = 0;
  for (const cut of sorted) {
    widths.push(cut - previous);
    previous = cut;
  }
  widths.push(recordWidth - previous);
  return widths;
}

export interface SchemaValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export function validateSchema(schema: SchemaProfile): SchemaValidation {
  const errors: string[] = [];

  if (schema.lineEnding === 'none') {
    if (!schema.recordLength || schema.recordLength <= 0) {
      errors.push('recordLength is required and must be positive when lineEnding is "none".');
    }
  }

  if (schema.mode === 'fixed') {
    if (schema.columns.length === 0) {
      errors.push('Fixed-width mode requires at least one column.');
    }
    for (const column of schema.columns) {
      if (column.length <= 0) {
        errors.push(`Column "${column.name}" has a non-positive length.`);
      }
      if (column.start < 0) {
        errors.push(`Column "${column.name}" has a negative start offset.`);
      }
    }
  } else {
    if (!schema.pattern) {
      errors.push('Regex mode requires a pattern.');
    } else {
      try {
        // Validate here, in the host, so an invalid pattern never reaches a worker.
        new RegExp(schema.pattern, schema.regexFlags ?? '');
      } catch (error) {
        errors.push(`Invalid regular expression: ${(error as Error).message}`);
      }
    }
  }

  const names = new Set<string>();
  for (const column of schema.columns) {
    const key = column.name.toLowerCase();
    if (names.has(key)) {
      errors.push(`Duplicate column name "${column.name}".`);
    }
    names.add(key);
  }

  return { ok: errors.length === 0, errors };
}

/** Record length implied by a fixed-width schema, used to size the ruler. */
export function impliedRecordWidth(schema: SchemaProfile): number {
  if (schema.recordLength) {
    return schema.recordLength;
  }
  let width = 0;
  for (const column of schema.columns) {
    width = Math.max(width, column.start + column.length);
  }
  return width;
}
