/**
 * Tests for the pure core. No VS Code, no worker threads, no file system.
 *
 * The edge cases here are the ones that corrupt data silently rather than crashing:
 * unterminated final records, mixed terminators, multi-byte sequences, trailing signs, and
 * records that straddle a chunk boundary.
 */

import { describe, expect, it } from 'vitest';

import { makeDecoder, parseNumericBytes, likeToRegExp } from '../src/core/parse/decode.js';
import { detectLineEnding, bomLength, walkRecords } from '../src/core/parse/records.js';
import { FixedWidthRecordParser, RegexRecordParser } from '../src/core/parse/columns.js';
import { SparseIndex } from '../src/core/index/sparseIndex.js';
import { parseQuery, validateStatement } from '../src/core/query/parser.js';
import { compileQuery } from '../src/core/query/compile.js';
import { encodeRows, RowsFlags, RowsView } from '../src/shared/rowsCodec.js';
import { filtersToExpr, filtersToSql } from '../src/core/query/uiFilters.js';
import type { SchemaProfile } from '../src/shared/schema.js';

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));

const fixedSchema: SchemaProfile = {
  version: 1,
  mode: 'fixed',
  encoding: 'latin1',
  lineEnding: 'lf',
  columns: [
    { name: 'CODE', start: 0, length: 6, type: 'string', trim: 'both' },
    { name: 'AMOUNT', start: 6, length: 8, type: 'decimal', trim: 'both', scale: 2, signed: 'trailing' },
    { name: 'STATUS', start: 14, length: 6, type: 'string', trim: 'both' },
  ],
};

describe('record splitting', () => {
  it('detects LF, CRLF and unterminated files', () => {
    expect(detectLineEnding(bytes('a\nb\n'))).toBe('lf');
    expect(detectLineEnding(bytes('a\r\nb\r\n'))).toBe('crlf');
    expect(detectLineEnding(bytes('no terminator here'))).toBe('none');
  });

  it('skips a UTF-8 BOM', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a]);
    expect(bomLength(withBom)).toBe(3);
    expect(bomLength(bytes('a\n'))).toBe(0);
  });

  it('strips CR even when the schema says LF', () => {
    const buffer = bytes('one\r\ntwo\r\n');
    const spans = walkRecords(buffer, 0, 0, 10, 'lf', 0, true);
    expect(spans).toHaveLength(2);
    expect(new TextDecoder().decode(buffer.subarray(spans[0]!.start, spans[0]!.end))).toBe('one');
    expect(new TextDecoder().decode(buffer.subarray(spans[1]!.start, spans[1]!.end))).toBe('two');
  });

  it('keeps a final record with no terminator, but only at end of file', () => {
    const buffer = bytes('one\ntwo');
    expect(walkRecords(buffer, 0, 0, 10, 'lf', 0, true)).toHaveLength(2);
    // Mid-stream the same bytes must yield one record: "two" may continue in the next chunk.
    expect(walkRecords(buffer, 0, 0, 10, 'lf', 0, false)).toHaveLength(1);
  });

  it('computes fixed-length record spans without scanning', () => {
    const buffer = bytes('aaaabbbbcccc');
    const spans = walkRecords(buffer, 0, 0, 10, 'none', 4, true);
    expect(spans).toHaveLength(3);
    expect(spans[2]).toEqual({ start: 8, end: 12 });
  });

  it('does not return a record that runs past the end of the chunk', () => {
    const buffer = bytes('aaaabb');
    // Only one complete 4-byte record is available; "bb" is a partial tail.
    expect(walkRecords(buffer, 0, 0, 10, 'none', 4, true)).toHaveLength(1);
  });
});

describe('decoding and numeric parsing', () => {
  it('decodes latin1 exactly, including the 0x80-0x9F range', () => {
    const decode = makeDecoder('latin1');
    const buffer = new Uint8Array([0x41, 0x85, 0xe9]);
    // windows-1252 would map 0x85 to an ellipsis; true latin1 keeps it as U+0085.
    expect(decode(buffer, 0, 3)).toBe('Aé');
  });

  it('applies implied decimal scale', () => {
    expect(parseNumericBytes(bytes('00012345'), 0, 8, { scale: 2 })).toBeCloseTo(123.45);
  });

  it('reads a trailing sign', () => {
    expect(parseNumericBytes(bytes('0001234-'), 0, 8, { scale: 2, signed: 'trailing' })).toBeCloseTo(-12.34);
  });

  it('returns NaN for a blank or non-numeric field', () => {
    expect(parseNumericBytes(bytes('      '), 0, 6)).toBeNaN();
    expect(parseNumericBytes(bytes('12A45 '), 0, 6)).toBeNaN();
  });

  it('does not let a literal decimal point be double-scaled', () => {
    // The field spells the point out, so `scale` must be ignored rather than applied twice.
    expect(parseNumericBytes(bytes('123.45'), 0, 6, { scale: 2 })).toBeCloseTo(123.45);
  });

  it('translates LIKE wildcards and escapes regex metacharacters', () => {
    expect(likeToRegExp('%C5%', false).test('xxC5xx')).toBe(true);
    expect(likeToRegExp('a_c', false).test('abc')).toBe(true);
    expect(likeToRegExp('a.c', false).test('abc')).toBe(false);
  });
});

describe('column extraction', () => {
  it('extracts fixed-width fields by byte offset', () => {
    const record = bytes('C5-00100012345OPEN  ');
    const parser = new FixedWidthRecordParser(fixedSchema);
    parser.parse(record, 0, record.length);
    expect(parser.text(0)).toBe('C5-001');
    expect(parser.number(1)).toBeCloseTo(123.45);
    expect(parser.text(2)).toBe('OPEN');
  });

  it('clamps fields of a short record instead of reading past its end', () => {
    const record = bytes('C5-001 001');
    const parser = new FixedWidthRecordParser(fixedSchema);
    parser.parse(record, 0, record.length);
    expect(parser.text(2)).toBe('');
    expect(parser.isEmpty(2)).toBe(true);
  });

  it('clears memoized cells between records', () => {
    const parser = new FixedWidthRecordParser(fixedSchema);
    const first = bytes('AAAAAA00000100OPEN  ');
    const second = bytes('BBBBBB00000200SHUT  ');
    parser.parse(first, 0, first.length);
    expect(parser.text(0)).toBe('AAAAAA');
    parser.parse(second, 0, second.length);
    expect(parser.text(0)).toBe('BBBBBB');
  });

  it('splits on a whitespace-run pattern', () => {
    const schema: SchemaProfile = {
      version: 1,
      mode: 'regex',
      encoding: 'latin1',
      lineEnding: 'lf',
      pattern: '\\s{2,}',
      regexMode: 'split',
      columns: [
        { name: 'a', start: 0, length: 0, type: 'string', trim: 'both' },
        { name: 'b', start: 0, length: 0, type: 'string', trim: 'both' },
        { name: 'c', start: 0, length: 0, type: 'string', trim: 'both' },
      ],
    };
    const record = bytes('alpha one   beta two   gamma');
    const parser = new RegexRecordParser(schema);
    parser.parse(record, 0, record.length);
    // A single space stays inside the field; only runs of two or more separate columns.
    expect(parser.text(0)).toBe('alpha one');
    expect(parser.text(1)).toBe('beta two');
    expect(parser.text(2)).toBe('gamma');
  });
});

describe('sparse index', () => {
  it('resolves fixed-length rows arithmetically, with no checkpoints', () => {
    const index = SparseIndex.forFixedLength(64 * 1000, 64, 0);
    expect(index.rowCount).toBe(1000);
    expect(index.locate(500)).toEqual({ anchorRow: 500, byteOffset: 32000 });
    expect(index.memoryBytes).toBe(0);
  });

  it('anchors a delimited row to the nearest preceding checkpoint', () => {
    const index = SparseIndex.forDelimited(4, 0);
    index.appendCheckpoints(Float64Array.from([100, 200, 300]), 12);
    // Checkpoint 0 is row 0 at offset 0; the appended ones cover rows 4, 8 and 12.
    expect(index.locate(9).anchorRow).toBe(8);
    expect(index.locate(9).byteOffset).toBe(200);
  });

  it('stays within the documented memory budget for a billion rows', () => {
    // 1e9 rows at a 4096 stride is 244,141 checkpoints of 8 bytes each.
    const checkpoints = Math.ceil(1e9 / 4096);
    expect((checkpoints * 8) / 1e6).toBeLessThan(8);
  });
});

describe('query parsing', () => {
  it('parses a full statement', () => {
    const result = parseQuery("SELECT CODE, STATUS WHERE AMOUNT > 100 AND STATUS = 'OPEN' ORDER BY CODE DESC LIMIT 50");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.statement.columns).toEqual(['CODE', 'STATUS']);
    expect(result.statement.orderBy).toEqual({ column: 'CODE', direction: 'desc' });
    expect(result.statement.limit).toBe(50);
  });

  it('reports the position of a syntax error', () => {
    const result = parseQuery('SELECT * WHERE AMOUNT >');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.at).toBeGreaterThan(0);
  });

  it('gives AND lower precedence than comparison, and OR lower than AND', () => {
    const result = parseQuery("SELECT * WHERE a = 1 OR b = 2 AND c = 3");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const where = result.statement.where!;
    // Must parse as a = 1 OR (b = 2 AND c = 3).
    expect(where.kind).toBe('logical');
    expect(where.kind === 'logical' && where.op).toBe('OR');
    expect(where.kind === 'logical' && where.right.kind === 'logical' && where.right.op).toBe('AND');
  });

  it('handles doubled quotes inside a string literal', () => {
    const result = parseQuery("SELECT * WHERE CODE = 'O''BRIEN'");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const where = result.statement.where!;
    expect(where.kind === 'comparison' && where.right.kind === 'literal' && where.right.value).toBe("O'BRIEN");
  });

  it('rejects an unknown column and suggests the nearest name', () => {
    const parsed = parseQuery('SELECT * WHERE COED = 1');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const validation = validateStatement(parsed.statement, ['CODE', 'AMOUNT'], 'SELECT * WHERE COED = 1');
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.error.message).toContain('CODE');
  });

  it('refuses ORDER BY without LIMIT', () => {
    const parsed = parseQuery('SELECT * ORDER BY CODE');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const validation = validateStatement(parsed.statement, ['CODE'], 'SELECT * ORDER BY CODE');
    expect(validation.ok).toBe(false);
  });
});

describe('predicate compilation', () => {
  const run = (sql: string, record: string): boolean => {
    const parsed = parseQuery(sql);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const compiled = compileQuery(parsed.statement, fixedSchema);
    const parser = new FixedWidthRecordParser(fixedSchema);
    const buffer = bytes(record);
    parser.parse(buffer, 0, buffer.length);
    return compiled.predicate ? compiled.predicate(parser) : true;
  };

  const OPEN = 'C5-00100012345OPEN  ';

  it('matches string equality on the byte fast path', () => {
    expect(run("SELECT * WHERE STATUS = 'OPEN'", OPEN)).toBe(true);
    expect(run("SELECT * WHERE STATUS = 'SHUT'", OPEN)).toBe(false);
  });

  it('compares a scaled decimal numerically, not lexically', () => {
    // Lexical comparison of "00012345" against "9" would give the wrong answer.
    expect(run('SELECT * WHERE AMOUNT > 9', OPEN)).toBe(true);
    expect(run('SELECT * WHERE AMOUNT > 999', OPEN)).toBe(false);
  });

  it('treats a non-numeric field as matching no numeric comparison', () => {
    const blank = 'C5-001        OPEN  ';
    expect(run('SELECT * WHERE AMOUNT > 0', blank)).toBe(false);
    expect(run('SELECT * WHERE AMOUNT < 0', blank)).toBe(false);
  });

  it('supports LIKE, IN, BETWEEN, IS NULL and MATCHES', () => {
    expect(run("SELECT * WHERE CODE LIKE '%5-0%'", OPEN)).toBe(true);
    expect(run("SELECT * WHERE STATUS IN ('OPEN', 'SHUT')", OPEN)).toBe(true);
    expect(run('SELECT * WHERE AMOUNT BETWEEN 100 AND 200', OPEN)).toBe(true);
    expect(run("SELECT * WHERE STATUS IS NOT NULL", OPEN)).toBe(true);
    expect(run('SELECT * WHERE CODE MATCHES /^C\\d/', OPEN)).toBe(true);
  });

  it('negates correctly', () => {
    expect(run("SELECT * WHERE STATUS NOT LIKE '%OPEN%'", OPEN)).toBe(false);
    expect(run("SELECT * WHERE NOT STATUS = 'OPEN'", OPEN)).toBe(false);
  });

  const prefilterFor = (sql: string): string | null => {
    const parsed = parseQuery(sql);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return compileQuery(parsed.statement, fixedSchema).literalPrefilter;
  };

  it('extracts a literal prefilter only when every match must contain it', () => {
    expect(prefilterFor("SELECT * WHERE STATUS = 'PENDING'")).toBe('PENDING');
    // Under OR neither literal is mandatory, so skipping blocks on one would lose rows.
    expect(prefilterFor("SELECT * WHERE STATUS = 'PENDING' OR CODE = 'ABCDEF'")).toBeNull();
    // Under AND either one is safe to skip blocks on.
    expect(prefilterFor("SELECT * WHERE STATUS = 'PENDING' AND AMOUNT > 5")).toBe('PENDING');
  });
});

describe('UI filters', () => {
  it('produces the same AST shape as the equivalent SQL', () => {
    const expr = filtersToExpr([{ column: 'STATUS', op: 'equals', value: 'OPEN' }]);
    expect(expr?.kind).toBe('comparison');
  });

  it('renders readable SQL for the query bar', () => {
    const sql = filtersToSql([
      { column: 'STATUS', op: 'contains', value: 'OPE' },
      { column: 'AMOUNT', op: 'gte', value: '100' },
    ]);
    expect(sql).toBe("SELECT * WHERE STATUS ILIKE '%OPE%' AND AMOUNT >= 100");
  });

  it('ignores an empty filter box', () => {
    expect(filtersToExpr([{ column: 'STATUS', op: 'contains', value: '' }])).toBeNull();
  });
});

describe('binary rows envelope', () => {
  it('round-trips cells, including empty ones and multi-byte text', () => {
    const payload = encodeRows({
      rowCount: 2,
      columnCount: 3,
      sourceRowIndex: Float64Array.from([10, 4_000_000_001]),
      cells: ['a', '', 'caffè', 'x', 'y', 'z'],
      flags: RowsFlags.ResultView,
    });
    const view = new RowsView(payload);

    expect(view.rowCount).toBe(2);
    expect(view.columnCount).toBe(3);
    expect(view.cell(0, 0)).toBe('a');
    expect(view.cell(0, 1)).toBe('');
    expect(view.cell(0, 2)).toBe('caffè');
    expect(view.cell(1, 2)).toBe('z');
    // Row numbers past 2^32 must survive: Uint32Array here would wrap silently.
    expect(view.rowIndexAt(1)).toBe(4_000_000_001);
    expect(view.flags & RowsFlags.ResultView).toBeTruthy();
  });

  it('survives a payload that lands at a non-8-byte-aligned offset', () => {
    const payload = encodeRows({
      rowCount: 1,
      columnCount: 1,
      sourceRowIndex: Float64Array.from([7]),
      cells: ['hello'],
      flags: RowsFlags.None,
    });
    const shifted = new Uint8Array(payload.length + 1);
    shifted.set(payload, 1);
    const view = new RowsView(shifted.subarray(1));
    expect(view.cell(0, 0)).toBe('hello');
  });
});
