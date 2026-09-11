/**
 * Sparse row cache in front of the host.
 *
 * The grid asks for cells every frame; this decides what that costs. Three behaviours
 * matter: blocks rather than rows (one request per 256 rows, not per row), coalescing plus
 * a settle delay (a fast drag crosses thousands of rows and must not emit a request for
 * each), and a generation token (a response for a schema that has since changed is dropped
 * rather than rendered).
 */

import { RowsView } from '../shared/rowsCodec.js';
import { post } from './vscodeApi.js';
import type { GridProvider } from './virtualGrid.js';

const BLOCK_ROWS = 256;
/** ~8k rows of cache. Well above any viewport, far below anything that pressures memory. */
const MAX_BLOCKS = 32;
const SETTLE_MS = 60;

interface PendingRequest {
  readonly blockId: number;
  readonly generation: number;
}

export class RowStore implements GridProvider {
  /** Map iteration order is insertion order, which is exactly the LRU order we evict by. */
  private readonly blocks = new Map<number, RowsView>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly inFlight = new Set<number>();

  private requestGen = 1;
  private generation = 0;
  private wanted = new Set<number>();
  private settleTimer: number | null = null;
  private rowCount = 0;

  constructor(private readonly onBlockArrived: () => void) {}

  setRowCount(rowCount: number): void {
    this.rowCount = rowCount;
  }

  /** Called when the schema or the active result changes: every cached block is now wrong. */
  invalidate(): void {
    this.generation++;
    this.blocks.clear();
    this.inFlight.clear();
    this.pending.clear();
    this.wanted.clear();
  }

  cell(row: number, column: number): string | null {
    const blockId = Math.floor(row / BLOCK_ROWS);
    const view = this.blocks.get(blockId);
    if (!view) {
      return null;
    }
    const local = row - blockId * BLOCK_ROWS;
    return local < view.rowCount ? view.cell(local, column) : '';
  }

  rowLabel(row: number): number | null {
    const blockId = Math.floor(row / BLOCK_ROWS);
    const view = this.blocks.get(blockId);
    if (!view) {
      return null;
    }
    const local = row - blockId * BLOCK_ROWS;
    return local < view.rowCount ? view.rowIndexAt(local) : null;
  }

  /** The grid reports its visible range every frame; this is the only entry point. */
  ensureRange(firstRow: number, count: number): void {
    if (this.rowCount === 0) {
      return;
    }
    const firstBlock = Math.floor(firstRow / BLOCK_ROWS);
    const lastBlock = Math.floor(Math.min(firstRow + count, this.rowCount - 1) / BLOCK_ROWS);

    let added = false;
    for (let blockId = firstBlock; blockId <= lastBlock; blockId++) {
      if (this.blocks.has(blockId) || this.inFlight.has(blockId)) {
        continue;
      }
      this.wanted.add(blockId);
      added = true;
    }
    if (added) {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.settleTimer !== null) {
      return;
    }
    // Waiting out the drag is what stops a fast scroll from queueing hundreds of reads
    // for rows the user has already passed.
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.flush();
    }, SETTLE_MS) as unknown as number;
  }

  private flush(): void {
    for (const blockId of this.wanted) {
      if (this.blocks.has(blockId) || this.inFlight.has(blockId)) {
        continue;
      }
      const gen = this.requestGen++;
      this.pending.set(gen, { blockId, generation: this.generation });
      this.inFlight.add(blockId);
      post({ type: 'fetchRows', gen, range: { from: blockId * BLOCK_ROWS, count: BLOCK_ROWS } });
    }
    this.wanted.clear();
  }

  /** Jump-to-row must not wait out the settle delay. */
  flushNow(): void {
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.flush();
  }

  accept(gen: number, payload: Uint8Array): void {
    const request = this.pending.get(gen);
    this.pending.delete(gen);
    if (!request) {
      return;
    }
    this.inFlight.delete(request.blockId);

    // The schema or result changed while this block was in flight; its contents describe a
    // view of the file that is no longer on screen.
    if (request.generation !== this.generation) {
      return;
    }

    try {
      this.blocks.set(request.blockId, new RowsView(payload));
    } catch {
      return; // Malformed payload: leave the block missing so it renders as a placeholder.
    }

    while (this.blocks.size > MAX_BLOCKS) {
      const oldest = this.blocks.keys().next();
      if (oldest.done) {
        break;
      }
      this.blocks.delete(oldest.value);
    }

    this.onBlockArrived();
  }
}
