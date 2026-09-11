/**
 * One session per open document: owns the file handle, the index, the schema, and any
 * running worker. Everything it allocates is released in `dispose()`.
 *
 * The class is deliberately the only component that knows both about VS Code and about
 * file bytes; the layers on either side of it stay independently testable.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { createRecordParser, inferRegexColumns } from '../core/parse/columns.js';
import { makeDecoder } from '../core/parse/decode.js';
import { bomLength, detectLineEnding, walkRecords, type ResolvedLineEnding } from '../core/parse/records.js';
import { SparseIndex } from '../core/index/sparseIndex.js';
import { parseQuery, validateStatement } from '../core/query/parser.js';
import { filtersToExpr } from '../core/query/uiFilters.js';
import type { SelectStatement } from '../core/query/ast.js';
import { encodeRows, RowsFlags } from '../shared/rowsCodec.js';
import { DEFAULT_SCHEMA, columnsFromWidths, validateSchema, type SchemaProfile } from '../shared/schema.js';
import type { FileMeta, RowRange, ToWebview, UiFilter } from '../shared/protocol.js';
import type { IndexMessage, QueryMessage } from '../shared/workerProtocol.js';
import { FileHandleService } from './FileHandleService.js';
import { WorkerTask } from './workerHost.js';

export interface SessionSettings {
  readonly pageSizeBytes: number;
  readonly pageCacheBytes: number;
  readonly checkpointStride: number;
  readonly defaultEncoding: 'utf8' | 'latin1' | 'ascii';
  readonly maxQueryResults: number;
  readonly workerHeapMb: number;
}

const SAMPLE_RECORD_LIMIT = 200;
const INDEX_CHUNK_BYTES = 4 * 1024 * 1024;
const QUERY_CHUNK_BYTES = 4 * 1024 * 1024;

export class Session {
  private readonly file: FileHandleService;
  private index: SparseIndex;
  private schema: SchemaProfile;
  private lineEnding: ResolvedLineEnding = 'lf';
  private dataStart = 0;

  private indexTask: WorkerTask<IndexMessage> | null = null;
  private queryTask: WorkerTask<QueryMessage> | null = null;
  private queryGeneration = 0;

  /** Non-null while a query result is being displayed instead of the file itself. */
  private resultOffsets: Float64Array | null = null;
  private resultRows: Float64Array | null = null;

  private disposed = false;

  constructor(
    readonly uri: vscode.Uri,
    private readonly settings: SessionSettings,
    private readonly workerDir: string,
    private readonly post: (message: ToWebview) => void,
  ) {
    this.file = new FileHandleService(uri.fsPath, settings.pageSizeBytes, settings.pageCacheBytes);
    this.schema = { ...DEFAULT_SCHEMA, encoding: settings.defaultEncoding };
    this.index = SparseIndex.forDelimited(settings.checkpointStride, 0);
  }

  // ---------------------------------------------------------------- lifecycle

  async open(): Promise<void> {
    await this.file.open();

    // Sniff the head of the file. Everything downstream depends on these two facts, so
    // they are established once, explicitly, rather than re-guessed per operation.
    const head = await this.file.read(0, Math.min(64 * 1024, this.file.size));
    this.dataStart = bomLength(head);
    this.lineEnding = detectLineEnding(head.subarray(this.dataStart));

    await this.loadSchemaProfile();
    this.rebuildIndex();
  }

  /** A `<file>.fwq.json` next to the data file is loaded automatically. */
  private async loadSchemaProfile(): Promise<void> {
    const profilePath = `${this.uri.fsPath}.fwq.json`;
    try {
      const raw = await fs.readFile(profilePath, 'utf8');
      const parsed = JSON.parse(raw) as SchemaProfile;
      const validation = validateSchema(parsed);
      if (validation.ok) {
        this.schema = parsed;
        return;
      }
      this.post({
        type: 'error',
        code: 'SCHEMA_INVALID',
        message: `Schema profile ignored: ${validation.errors[0] ?? 'invalid'}`,
        detail: profilePath,
      });
    } catch {
      // No profile is the normal case, not an error.
    }

    if (this.schema.columns.length === 0) {
      await this.inferInitialSchema();
    }
  }

  /** Give a file with no profile a usable default, so it is never opened as one blank column. */
  private async inferInitialSchema(): Promise<void> {
    const lines = await this.sampleRecords(20);
    if (lines.length === 0) {
      return;
    }
    const columns = inferRegexColumns(this.schema, lines);
    this.schema = { ...this.schema, columns };
  }

  private rebuildIndex(): void {
    this.indexTask?.terminate();
    this.indexTask = null;

    // Fixed-length records need no index at all: row N lives at N * recordLength.
    if (this.schema.lineEnding === 'none' && this.schema.recordLength) {
      this.index = SparseIndex.forFixedLength(this.file.size, this.schema.recordLength, this.dataStart);
      this.lineEnding = 'none';
      this.postMeta();
      this.post({
        type: 'indexProgress',
        rows: this.index.rowCount,
        bytes: this.file.size,
        totalBytes: this.file.size,
        done: true,
      });
      return;
    }

    this.lineEnding = this.schema.lineEnding === 'auto'
      ? this.lineEnding
      : (this.schema.lineEnding as ResolvedLineEnding);

    this.index = SparseIndex.forDelimited(this.settings.checkpointStride, this.dataStart);
    this.postMeta();

    const task = new WorkerTask<IndexMessage>(
      {
        scriptPath: path.join(this.workerDir, 'indexer.worker.js'),
        workerData: {
          kind: 'index',
          path: this.uri.fsPath,
          stride: this.settings.checkpointStride,
          dataStart: this.dataStart,
          fileSize: this.file.size,
          chunkBytes: INDEX_CHUNK_BYTES,
        },
        heapMb: this.settings.workerHeapMb,
      },
      (message) => this.onIndexMessage(message),
      (error) => this.post({ type: 'error', code: 'INDEX_FAILED', message: error.message }),
    );
    this.indexTask = task;
    task.start();
  }

  private onIndexMessage(message: IndexMessage): void {
    if (this.disposed) {
      return;
    }
    switch (message.type) {
      case 'checkpoints': {
        this.index.appendCheckpoints(message.offsets, message.rows);
        this.post({
          type: 'indexProgress',
          rows: message.rows,
          bytes: message.bytes,
          totalBytes: this.file.size,
          done: false,
        });
        break;
      }
      case 'done': {
        this.index.finish(message.rows);
        this.postMeta();
        this.post({
          type: 'indexProgress',
          rows: message.rows,
          bytes: message.bytes,
          totalBytes: this.file.size,
          done: true,
        });
        break;
      }
      case 'failed': {
        this.post({ type: 'error', code: 'INDEX_FAILED', message: message.message });
        break;
      }
    }
  }

  // ---------------------------------------------------------------- metadata

  get meta(): FileMeta {
    return {
      fileName: path.basename(this.uri.fsPath),
      sizeBytes: this.file.size,
      rowCount: this.resultRows ? this.resultRows.length : this.index.rowCount,
      rowCountFinal: this.resultRows ? true : this.index.complete,
      detectedLineEnding: this.lineEnding,
    };
  }

  get currentSchema(): SchemaProfile {
    return this.schema;
  }

  get columnNames(): string[] {
    return this.schema.columns.map((column) => column.name);
  }

  private postMeta(): void {
    this.post({ type: 'meta', meta: this.meta });
  }

  sendInit(): void {
    this.post({ type: 'init', meta: this.meta, schema: this.schema, columns: this.columnNames });
  }

  // ---------------------------------------------------------------- schema

  async setSchema(next: SchemaProfile): Promise<void> {
    const validation = validateSchema(next);
    if (!validation.ok) {
      this.post({ type: 'error', code: 'SCHEMA_INVALID', message: validation.errors.join(' ') });
      return;
    }

    const structureChanged =
      next.lineEnding !== this.schema.lineEnding ||
      next.recordLength !== this.schema.recordLength ||
      next.encoding !== this.schema.encoding;

    let resolved = next;

    // A split pattern does not declare its column count; sample the file to find it.
    if (next.mode === 'regex' && next.columns.length === 0) {
      const sample = await this.sampleRecords(20);
      resolved = { ...next, columns: inferRegexColumns(next, sample) };
    }

    this.schema = resolved;
    this.clearResult();
    this.post({ type: 'schema', schema: this.schema, columns: this.columnNames });

    if (structureChanged) {
      this.rebuildIndex();
    }
  }

  /** Ruler output: absolute cut positions become fixed-width column definitions. */
  applyRulerCuts(cuts: readonly number[], recordWidth: number, names?: readonly string[]): SchemaProfile {
    const widths: number[] = [];
    let previous = 0;
    for (const cut of [...new Set(cuts)].filter((c) => c > 0 && c < recordWidth).sort((a, b) => a - b)) {
      widths.push(cut - previous);
      previous = cut;
    }
    widths.push(recordWidth - previous);
    return { ...this.schema, mode: 'fixed', columns: columnsFromWidths(widths, names) };
  }

  async saveSchemaProfile(): Promise<string> {
    const target = `${this.uri.fsPath}.fwq.json`;
    await fs.writeFile(target, `${JSON.stringify(this.schema, null, 2)}\n`, 'utf8');
    return target;
  }

  // ---------------------------------------------------------------- rows

  /**
   * Read raw record text for the ruler and for schema inference. Bounded by design: this
   * is a sample, never the file.
   */
  async sampleRecords(limit: number): Promise<string[]> {
    const count = Math.min(limit, SAMPLE_RECORD_LIMIT);
    const recordLength = this.schema.recordLength ?? 0;
    const span = this.lineEnding === 'none' && recordLength > 0
      ? recordLength * count
      : Math.min(1024 * 1024, this.file.size);

    const bytes = await this.file.read(this.dataStart, span);
    const spans = walkRecords(bytes, this.dataStart, this.dataStart, count, this.lineEnding, recordLength, true);
    const decode = makeDecoder(this.schema.encoding);
    return spans.map((record) => decode(bytes, record.start - this.dataStart, record.end - this.dataStart));
  }

  /**
   * Resolve a range of display rows into an encoded payload.
   *
   * In result mode the byte offsets come straight from the query worker, so no index
   * lookup happens at all. In file mode, the sparse index gives the nearest checkpoint and
   * we walk forward from there.
   */
  async fetchRows(range: RowRange): Promise<Uint8Array> {
    const parser = createRecordParser(this.schema);
    const columnCount = Math.max(1, parser.columnCount);
    const recordLength = this.schema.recordLength ?? 0;

    const rowIndices = new Float64Array(range.count);
    const cells: string[] = [];
    let produced = 0;

    if (this.resultOffsets && this.resultRows) {
      // Result mode: each row is an independent positional read.
      const available = Math.max(0, Math.min(range.count, this.resultOffsets.length - range.from));
      for (let i = 0; i < available; i++) {
        const offset = this.resultOffsets[range.from + i] ?? 0;
        const maxRecord = recordLength > 0 ? recordLength : 64 * 1024;
        const bytes = await this.file.read(offset, maxRecord);
        const spans = walkRecords(bytes, offset, offset, 1, this.lineEnding, recordLength, true);
        const span = spans[0];
        if (!span) {
          continue;
        }
        parser.parse(bytes, span.start - offset, span.end - offset);
        rowIndices[produced] = this.resultRows[range.from + i] ?? 0;
        for (let column = 0; column < columnCount; column++) {
          cells.push(parser.text(column));
        }
        produced++;
      }
    } else {
      const { anchorRow, byteOffset } = this.index.locate(range.from);
      const skipAhead = range.from - anchorRow;

      // Read enough to cover the skip plus the requested rows. An overly long record simply
      // triggers a second read rather than being truncated.
      const estimatedRecord = recordLength > 0 ? recordLength : 512;
      const needed = (skipAhead + range.count + 2) * estimatedRecord;
      let bytes = await this.file.read(byteOffset, Math.min(needed, 16 * 1024 * 1024));

      let spans = walkRecords(
        bytes,
        byteOffset,
        byteOffset,
        skipAhead + range.count,
        this.lineEnding,
        recordLength,
        byteOffset + bytes.length >= this.file.size,
      );

      if (spans.length < skipAhead + range.count && byteOffset + bytes.length < this.file.size) {
        bytes = await this.file.read(byteOffset, Math.min(needed * 4, 64 * 1024 * 1024));
        spans = walkRecords(
          bytes,
          byteOffset,
          byteOffset,
          skipAhead + range.count,
          this.lineEnding,
          recordLength,
          byteOffset + bytes.length >= this.file.size,
        );
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
      flags: this.resultOffsets ? RowsFlags.ResultView : RowsFlags.None,
    });
  }

  // ---------------------------------------------------------------- query

  runSql(gen: number, sql: string): void {
    const parsed = parseQuery(sql);
    if (!parsed.ok) {
      this.post({
        type: 'error',
        code: 'QUERY_SYNTAX',
        message: parsed.error.message,
        detail: `${parsed.error.at}:${parsed.error.length}`,
      });
      return;
    }

    const semantic = validateStatement(parsed.statement, this.columnNames, sql);
    if (!semantic.ok) {
      this.post({
        type: 'error',
        code: 'QUERY_SEMANTIC',
        message: semantic.error.message,
        detail: `${semantic.error.at}:${semantic.error.length}`,
      });
      return;
    }

    this.startQuery(gen, parsed.statement);
  }

  runFilters(gen: number, filters: readonly UiFilter[]): void {
    const where = filtersToExpr(filters);
    if (!where) {
      this.clearResult();
      this.post({ type: 'resultCleared' });
      this.postMeta();
      return;
    }
    this.startQuery(gen, { columns: null, where, orderBy: null, limit: null, offset: 0 });
  }

  private startQuery(gen: number, statement: SelectStatement): void {
    this.queryTask?.terminate();
    this.queryGeneration = gen;

    const pendingOffsets: number[] = [];
    const pendingRows: number[] = [];
    const started = Date.now();

    const task = new WorkerTask<QueryMessage>(
      {
        scriptPath: path.join(this.workerDir, 'query.worker.js'),
        workerData: {
          kind: 'query',
          path: this.uri.fsPath,
          schema: this.schema,
          statement,
          dataStart: this.dataStart,
          fileSize: this.file.size,
          recordLength: this.schema.recordLength ?? 0,
          lineEnding: this.lineEnding,
          chunkBytes: QUERY_CHUNK_BYTES,
          maxResults: this.settings.maxQueryResults,
        },
        heapMb: this.settings.workerHeapMb,
      },
      (message) => {
        // A late message from a superseded query must not touch the displayed result.
        if (this.disposed || gen !== this.queryGeneration) {
          return;
        }
        switch (message.type) {
          case 'batch': {
            for (const offset of message.offsets) {
              pendingOffsets.push(offset);
            }
            for (const row of message.rowIndices) {
              pendingRows.push(row);
            }
            this.resultOffsets = Float64Array.from(pendingOffsets);
            this.resultRows = Float64Array.from(pendingRows);
            this.post({
              type: 'queryProgress',
              gen,
              matched: message.matched,
              scannedBytes: message.scannedBytes,
              totalBytes: this.file.size,
              done: false,
              truncated: false,
              elapsedMs: Date.now() - started,
            });
            this.postMeta();
            break;
          }
          case 'progress': {
            this.post({
              type: 'queryProgress',
              gen,
              matched: message.matched,
              scannedBytes: message.scannedBytes,
              totalBytes: this.file.size,
              done: false,
              truncated: false,
              elapsedMs: Date.now() - started,
            });
            break;
          }
          case 'done': {
            this.resultOffsets = message.offsets;
            this.resultRows = message.rowIndices;
            this.post({
              type: 'queryProgress',
              gen,
              matched: message.matched,
              scannedBytes: message.scannedBytes,
              totalBytes: this.file.size,
              done: true,
              truncated: message.truncated,
              elapsedMs: message.elapsedMs,
            });
            this.postMeta();
            task.terminate();
            break;
          }
          case 'failed': {
            this.post({ type: 'error', code: 'QUERY_FAILED', message: message.message });
            task.terminate();
            break;
          }
        }
      },
      (error) => this.post({ type: 'error', code: 'QUERY_FAILED', message: error.message }),
    );

    this.queryTask = task;
    task.start();
  }

  cancelQuery(gen: number): void {
    if (gen === this.queryGeneration) {
      this.queryTask?.terminate();
      this.queryTask = null;
    }
  }

  clearResult(): void {
    this.queryTask?.terminate();
    this.queryTask = null;
    this.resultOffsets = null;
    this.resultRows = null;
  }

  get hasResult(): boolean {
    return this.resultOffsets !== null;
  }

  // ---------------------------------------------------------------- export

  /**
   * Stream the current result to disk. Row by row, so a ten-million-row export holds the
   * same memory as a one-row export.
   */
  async exportResult(target: vscode.Uri, format: 'csv' | 'jsonl', token: vscode.CancellationToken): Promise<number> {
    const offsets = this.resultOffsets;
    if (!offsets) {
      return 0;
    }
    const parser = createRecordParser(this.schema);
    const names = this.columnNames;
    const recordLength = this.schema.recordLength ?? 0;
    const handle = await fs.open(target.fsPath, 'w');

    try {
      let buffer = '';
      if (format === 'csv') {
        buffer += `${names.map(csvEscape).join(',')}\n`;
      }

      for (let i = 0; i < offsets.length; i++) {
        if (token.isCancellationRequested) {
          break;
        }
        const offset = offsets[i] ?? 0;
        const bytes = await this.file.read(offset, recordLength > 0 ? recordLength : 64 * 1024);
        const span = walkRecords(bytes, offset, offset, 1, this.lineEnding, recordLength, true)[0];
        if (!span) {
          continue;
        }
        parser.parse(bytes, span.start - offset, span.end - offset);

        if (format === 'csv') {
          const values: string[] = [];
          for (let column = 0; column < parser.columnCount; column++) {
            values.push(csvEscape(parser.text(column)));
          }
          buffer += `${values.join(',')}\n`;
        } else {
          const record: Record<string, string> = {};
          for (let column = 0; column < parser.columnCount; column++) {
            record[names[column] ?? `col${column + 1}`] = parser.text(column);
          }
          buffer += `${JSON.stringify(record)}\n`;
        }

        // Flush in fixed-size batches rather than accumulating the whole export.
        if (buffer.length >= 1024 * 1024) {
          await handle.write(buffer, null, 'utf8');
          buffer = '';
        }
      }

      if (buffer.length > 0) {
        await handle.write(buffer, null, 'utf8');
      }
      return offsets.length;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- teardown

  async checkForExternalChange(): Promise<boolean> {
    return this.file.hasChangedOnDisk();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.indexTask?.terminate();
    this.queryTask?.terminate();
    this.indexTask = null;
    this.queryTask = null;
    this.resultOffsets = null;
    this.resultRows = null;
    await this.file.dispose();
  }
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
