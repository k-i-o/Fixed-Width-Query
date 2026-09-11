/**
 * Sparse row index.
 *
 * One checkpoint every `stride` rows. Resolving row N reads the nearest checkpoint and
 * scans forward at most `stride` records — a single page read in practice.
 *
 * The arithmetic that matters: one billion rows at a 4096 stride is 244,140 checkpoints,
 * which is 1.9 MB. A dense index of the same file would be 8 GB. This factor is the
 * reason the extension holds flat memory on files it cannot fit in RAM.
 */

export type IndexMode = 'fixed-length' | 'delimited';

export interface IndexSnapshot {
  readonly mode: IndexMode;
  readonly stride: number;
  /** Only meaningful in fixed-length mode. */
  readonly recordLength: number;
  /** Absolute byte offset of row `i * stride`. Empty in fixed-length mode. */
  readonly checkpoints: Float64Array;
  readonly rowCount: number;
  readonly complete: boolean;
  /** First byte of actual data, past any BOM. */
  readonly dataStart: number;
}

export class SparseIndex {
  readonly mode: IndexMode;
  readonly stride: number;
  readonly recordLength: number;
  readonly dataStart: number;

  private checkpoints: Float64Array;
  private checkpointCount = 0;
  private rows = 0;
  private done = false;

  private constructor(mode: IndexMode, stride: number, recordLength: number, dataStart: number) {
    this.mode = mode;
    this.stride = stride;
    this.recordLength = recordLength;
    this.dataStart = dataStart;
    this.checkpoints = new Float64Array(mode === 'delimited' ? 1024 : 0);
  }

  /**
   * Records with no terminator and a known length need no index whatsoever: the offset of
   * row N is N * recordLength. Recognise this before scanning a single byte.
   */
  static forFixedLength(fileSize: number, recordLength: number, dataStart = 0): SparseIndex {
    const index = new SparseIndex('fixed-length', 1, recordLength, dataStart);
    index.rows = recordLength > 0 ? Math.floor((fileSize - dataStart) / recordLength) : 0;
    index.done = true;
    return index;
  }

  static forDelimited(stride: number, dataStart = 0): SparseIndex {
    const index = new SparseIndex('delimited', Math.max(1, stride), 0, dataStart);
    // Row 0 always starts at the first data byte.
    index.pushCheckpoint(dataStart);
    return index;
  }

  static fromSnapshot(snapshot: IndexSnapshot): SparseIndex {
    const index = new SparseIndex(snapshot.mode, snapshot.stride, snapshot.recordLength, snapshot.dataStart);
    index.checkpoints = snapshot.checkpoints.slice();
    index.checkpointCount = snapshot.checkpoints.length;
    index.rows = snapshot.rowCount;
    index.done = snapshot.complete;
    return index;
  }

  get rowCount(): number {
    return this.rows;
  }

  get complete(): boolean {
    return this.done;
  }

  get memoryBytes(): number {
    return this.checkpoints.byteLength;
  }

  private pushCheckpoint(offset: number): void {
    if (this.checkpointCount === this.checkpoints.length) {
      const grown = new Float64Array(Math.max(1024, this.checkpoints.length * 2));
      grown.set(this.checkpoints);
      this.checkpoints = grown;
    }
    this.checkpoints[this.checkpointCount++] = offset;
  }

  /**
   * Report that a record starts at `offset`. The indexer calls this for every record; only
   * one in `stride` is actually retained.
   */
  noteRecordStart(offset: number): void {
    this.rows++;
    if (this.rows % this.stride === 0) {
      this.pushCheckpoint(offset);
    }
  }

  /**
   * Append a batch of checkpoints produced by the indexer worker.
   *
   * The worker flushes every ~150 ms rather than once at the end, so the grid can navigate
   * the indexed prefix while the tail is still being scanned. `rowsSoFar` is authoritative:
   * it counts every record, including the ones between checkpoints.
   */
  appendCheckpoints(offsets: Float64Array, rowsSoFar: number): void {
    for (let i = 0; i < offsets.length; i++) {
      this.pushCheckpoint(offsets[i] as number);
    }
    this.rows = rowsSoFar;
  }

  /** Called when the scan reaches EOF, fixing the final row count. */
  finish(totalRows?: number): void {
    if (totalRows !== undefined) {
      this.rows = totalRows;
    }
    this.done = true;
  }

  /**
   * Nearest known starting point for a row: the row index we have an exact offset for,
   * and that offset. The caller walks forward `row - anchorRow` records from there.
   */
  locate(row: number): { anchorRow: number; byteOffset: number } {
    if (this.mode === 'fixed-length') {
      return { anchorRow: row, byteOffset: this.dataStart + row * this.recordLength };
    }
    const checkpoint = Math.min(Math.floor(row / this.stride), Math.max(0, this.checkpointCount - 1));
    return {
      anchorRow: checkpoint * this.stride,
      byteOffset: this.checkpoints[checkpoint] ?? this.dataStart,
    };
  }

  /**
   * Average bytes per record, measured from checkpoint spacing.
   *
   * The row reader needs this to size its reads. Guessing a constant is expensive in both
   * directions: guess high and every 256-row fetch drags megabytes through the page cache
   * for kilobytes of data; guess low and the read comes up short and has to be repeated.
   * Consecutive checkpoints are exactly `stride` rows apart, so the file answers this
   * question about itself.
   *
   * Returns 0 when nothing is known yet, which the caller reads as "use a default".
   */
  get averageRecordBytes(): number {
    if (this.mode === 'fixed-length') {
      return this.recordLength;
    }
    if (this.checkpointCount < 2) {
      return 0;
    }
    const first = this.checkpoints[0] ?? 0;
    const last = this.checkpoints[this.checkpointCount - 1] ?? 0;
    const rows = (this.checkpointCount - 1) * this.stride;
    return rows > 0 ? (last - first) / rows : 0;
  }

  /** Highest row whose offset is currently resolvable — indexing runs behind the UI. */
  get resolvableRows(): number {
    if (this.mode === 'fixed-length' || this.done) {
      return this.rows;
    }
    return Math.max(0, (this.checkpointCount - 1) * this.stride);
  }

  snapshot(): IndexSnapshot {
    return {
      mode: this.mode,
      stride: this.stride,
      recordLength: this.recordLength,
      checkpoints: this.checkpoints.slice(0, this.checkpointCount),
      rowCount: this.rows,
      complete: this.done,
      dataStart: this.dataStart,
    };
  }

  /** Merge a snapshot produced by the indexer worker into the host-side index. */
  applySnapshot(snapshot: IndexSnapshot): void {
    this.checkpoints = snapshot.checkpoints.slice();
    this.checkpointCount = snapshot.checkpoints.length;
    this.rows = snapshot.rowCount;
    this.done = snapshot.complete;
  }
}
