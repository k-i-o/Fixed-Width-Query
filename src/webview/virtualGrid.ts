/**
 * Virtualized grid.
 *
 * Two things here are not negotiable if the grid is to stay smooth at a million rows:
 *
 *  1. Node recycling. The DOM holds exactly `visibleRows + OVERSCAN` row elements for the
 *     life of the session. Scrolling rewrites their text and moves them; it never creates
 *     or destroys them.
 *  2. No layout reads during scroll. Geometry is measured on resize and cached. Touching
 *     offsetHeight inside the scroll handler forces a synchronous reflow and costs the
 *     entire frame budget on its own.
 *
 * Columns are virtualized on the horizontal axis for the same reason: a mainframe layout
 * with 200 fields would otherwise put 200 nodes in every visible row.
 */

export const ROW_HEIGHT = 22;
const OVERSCAN_ROWS = 6;
const OVERSCAN_COLUMNS = 2;

/**
 * Width of the row-number gutter.
 *
 * Column offsets start here, not at zero. They used to start at zero, which put every cell
 * of the first column directly on top of the gutter: cells have no background, so the row
 * numbers showed through wherever the cell text happened to be shorter than the number.
 * Must stay in sync with --fwq-gutter-width in style.css.
 */
const GUTTER_WIDTH = 76;

/** Floor for a width the user drags to. Deliberately low: narrowing is a choice. */
const MIN_COLUMN_WIDTH = 40;
const MAX_COLUMN_WIDTH = 1400;

/**
 * Floor for the *default* width of a column.
 *
 * Set by the filter row rather than by the data: the operator select and the value box
 * split the column between them, so the column has to fit both. At 190px each gets about
 * 90px, which is what "contains" needs to read as a word rather than as "cont". Content can
 * always be narrower than its own filter control, so the control sets the minimum.
 */
const DEFAULT_MIN_WIDTH = 190;
/** Grab area of the drag handle on a column's trailing edge. */
const RESIZE_HANDLE_WIDTH = 9;

/**
 * Browsers cap element height near 33.5M pixels in Chromium; past that, scrolling silently
 * loses precision and the scrollbar starts jumping. At 22px per row that ceiling arrives
 * around 1.5M rows — well inside our target. So the sizer is capped and scroll position is
 * mapped onto the row range instead of corresponding to it one-to-one.
 */
const MAX_SIZER_PX = 10_000_000;

/**
 * Absolute left offset of each column, plus a trailing entry holding the total width.
 *
 * Pure, exported and tested: the first entry being GUTTER_WIDTH rather than 0 is the whole
 * difference between a correct grid and one where the row numbers bleed through the first
 * column's cells, and that is not a thing to leave to a code review.
 */
export function computeColumnOffsets(
  widths: readonly number[],
  gutterWidth: number = GUTTER_WIDTH,
): number[] {
  const offsets = [gutterWidth];
  for (const width of widths) {
    offsets.push((offsets[offsets.length - 1] as number) + width);
  }
  return offsets;
}

export { GUTTER_WIDTH };

export interface GridProvider {
  /** Cell text, or null when the block is still in flight — the grid draws a skeleton. */
  cell(row: number, column: number): string | null;
  /** Source row number for the gutter, or null if unknown. */
  rowLabel(row: number): number | null;
}

export class VirtualGrid {
  private rowCount = 0;
  private columns: string[] = [];
  private columnWidths: number[] = [];
  private columnOffsets: number[] = [GUTTER_WIDTH];

  private firstRow = 0;
  private poolSize = 0;
  private readonly rowNodes: HTMLDivElement[] = [];
  private readonly cellNodes: HTMLDivElement[][] = [];

  private readonly headerCells: HTMLDivElement[] = [];
  private readonly filterCells: HTMLDivElement[] = [];

  private viewportHeight = 0;
  private viewportWidth = 0;
  private scrollLeft = 0;
  private suppressScrollEvent = false;
  private frameRequested = false;

  private firstColumn = 0;
  private lastColumn = 0;

  private resizing: { column: number; startX: number; startWidth: number } | null = null;
  /** Font of a data cell, cached for text measurement during auto-fit. */
  private cellFont = '';
  private measureContext: CanvasRenderingContext2D | null = null;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly sizer: HTMLElement,
    private readonly rowsContainer: HTMLElement,
    private readonly header: HTMLElement,
    private readonly filters: HTMLElement,
    private readonly provider: GridProvider,
    private readonly onRangeChanged: (firstRow: number, count: number) => void,
    private readonly onScrollRow: (firstRow: number) => void,
    private readonly onColumnWidths: (widths: readonly number[]) => void,
  ) {
    this.viewport.addEventListener('scroll', () => this.handleScroll(), { passive: true });

    // Wheel handling is taken over only past the sizer cap, where one wheel notch would
    // otherwise jump hundreds of rows because of the scroll-to-row compression.
    this.viewport.addEventListener('wheel', (event) => this.handleWheel(event), { passive: false });
    this.viewport.addEventListener('keydown', (event) => this.handleKey(event));

    const observer = new ResizeObserver(() => this.measure());
    observer.observe(this.viewport);
  }

  // ------------------------------------------------------------------ geometry

  private measure(): void {
    // The one place layout is read. Everything else uses these cached values.
    this.viewportHeight = this.viewport.clientHeight;
    this.viewportWidth = this.viewport.clientWidth;
    const needed = Math.ceil(this.viewportHeight / ROW_HEIGHT) + OVERSCAN_ROWS;
    if (needed !== this.poolSize) {
      this.resizePool(needed);
    }
    this.render();
  }

  private get visibleRows(): number {
    return Math.max(1, Math.floor(this.viewportHeight / ROW_HEIGHT));
  }

  private get maxFirstRow(): number {
    return Math.max(0, this.rowCount - this.visibleRows);
  }

  private get sizerHeight(): number {
    return Math.min(this.rowCount * ROW_HEIGHT, MAX_SIZER_PX);
  }

  private get maxScrollTop(): number {
    return Math.max(1, this.sizerHeight - this.viewportHeight);
  }

  /** True once the row count exceeds what the sizer can represent pixel-for-pixel. */
  private get isCompressed(): boolean {
    return this.rowCount * ROW_HEIGHT > MAX_SIZER_PX;
  }

  private recomputeOffsets(): void {
    this.columnOffsets = computeColumnOffsets(this.columnWidths);
  }

  get totalWidth(): number {
    return this.columnOffsets[this.columnOffsets.length - 1] ?? GUTTER_WIDTH;
  }

  // ------------------------------------------------------------------ pool

  private resizePool(size: number): void {
    while (this.rowNodes.length > size) {
      const node = this.rowNodes.pop();
      this.cellNodes.pop();
      node?.remove();
    }
    while (this.rowNodes.length < size) {
      const row = document.createElement('div');
      row.className = 'grid-row';
      const gutter = document.createElement('div');
      gutter.className = 'grid-gutter';
      row.appendChild(gutter);
      this.rowsContainer.appendChild(row);
      this.rowNodes.push(row);
      this.cellNodes.push([]);
    }
    this.poolSize = size;
    this.syncCellNodes();
  }

  /** Keep each pooled row holding exactly as many cell nodes as the visible column window. */
  private syncCellNodes(): void {
    const needed = Math.max(0, this.lastColumn - this.firstColumn + 1);
    for (let i = 0; i < this.rowNodes.length; i++) {
      const row = this.rowNodes[i] as HTMLDivElement;
      const cells = this.cellNodes[i] as HTMLDivElement[];
      while (cells.length > needed) {
        cells.pop()?.remove();
      }
      while (cells.length < needed) {
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        row.appendChild(cell);
        cells.push(cell);
      }
    }
  }

  // ------------------------------------------------------------------ data

  /**
   * @param declaredLengths field lengths from a fixed-width schema, used for the initial
   *   estimate so the grid opens looking like the file does.
   * @param savedWidths widths the user set previously, which always win over the estimate.
   */
  setColumns(
    names: readonly string[],
    declaredLengths?: readonly number[],
    savedWidths?: readonly number[],
  ): void {
    this.columns = [...names];
    this.columnWidths = this.columns.map((name, index) => {
      const saved = savedWidths?.[index];
      if (saved && saved >= MIN_COLUMN_WIDTH) {
        return Math.min(MAX_COLUMN_WIDTH, saved);
      }
      const declared = declaredLengths?.[index];
      // Fixed-width fields get a width proportional to their declared byte length, so the
      // grid opens looking like the file does; otherwise fall back to the header name.
      const estimated = declared && declared > 0 ? declared * 8 + 20 : name.length * 9 + 40;
      return Math.min(600, Math.max(DEFAULT_MIN_WIDTH, estimated));
    });

    this.recomputeOffsets();
    this.renderHeader();
    this.render();
  }

  setRowCount(rowCount: number): void {
    this.rowCount = Math.max(0, rowCount);
    this.sizer.style.height = `${this.sizerHeight}px`;
    if (this.firstRow > this.maxFirstRow) {
      this.firstRow = this.maxFirstRow;
    }
    this.render();
  }

  get currentFirstRow(): number {
    return this.firstRow;
  }

  get widths(): readonly number[] {
    return this.columnWidths;
  }

  scrollToRow(row: number): void {
    const target = Math.max(0, Math.min(row, this.maxFirstRow));
    this.firstRow = target;
    this.syncScrollTop();
    this.render();
  }

  private syncScrollTop(): void {
    const ratio = this.maxFirstRow === 0 ? 0 : this.firstRow / this.maxFirstRow;
    this.suppressScrollEvent = true;
    this.viewport.scrollTop = ratio * this.maxScrollTop;
    // Cleared on the next frame: the assignment above queues a scroll event.
    requestAnimationFrame(() => {
      this.suppressScrollEvent = false;
    });
  }

  // ------------------------------------------------------------------ input

  private handleScroll(): void {
    if (this.suppressScrollEvent) {
      return;
    }
    const ratio = this.viewport.scrollTop / this.maxScrollTop;
    this.firstRow = Math.round(ratio * this.maxFirstRow);
    this.scrollLeft = this.viewport.scrollLeft;
    this.scheduleRender();
  }

  private handleWheel(event: WheelEvent): void {
    if (!this.isCompressed || event.ctrlKey) {
      return; // Native scrolling is exact below the cap; leave it alone.
    }
    event.preventDefault();
    const rows = Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / ROW_HEIGHT) * 3);
    this.firstRow = Math.max(0, Math.min(this.firstRow + rows, this.maxFirstRow));
    this.syncScrollTop();
    this.scheduleRender();
  }

  private handleKey(event: KeyboardEvent): void {
    const page = this.visibleRows - 1;
    let target: number | null = null;
    switch (event.key) {
      case 'ArrowDown': target = this.firstRow + 1; break;
      case 'ArrowUp': target = this.firstRow - 1; break;
      case 'PageDown': target = this.firstRow + page; break;
      case 'PageUp': target = this.firstRow - page; break;
      case 'Home': target = 0; break;
      case 'End': target = this.maxFirstRow; break;
      default: return;
    }
    event.preventDefault();
    this.scrollToRow(target);
  }

  private scheduleRender(): void {
    if (this.frameRequested) {
      return;
    }
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.render();
    });
  }

  // ------------------------------------------------------------------ resizing

  /**
   * Drag the trailing edge of a header cell to resize; double-click it to fit the content.
   *
   * Resizing is live rather than an overlay-then-commit, because judging a column width
   * against the actual data is the whole point. It stays cheap because a resize only writes
   * `left`/`width` on the nodes already on screen — no node is created or destroyed, and the
   * work is coalesced into one animation frame like scrolling is.
   */
  private attachResizeHandle(headerCell: HTMLDivElement, column: number): void {
    const handle = document.createElement('div');
    handle.className = 'col-resize';
    handle.style.width = `${RESIZE_HANDLE_WIDTH}px`;
    handle.title = 'Drag to resize · double-click to fit contents';

    handle.addEventListener('pointerdown', (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      handle.setPointerCapture(event.pointerId);
      this.resizing = {
        column,
        startX: event.clientX,
        startWidth: this.columnWidths[column] ?? 100,
      };
      document.body.classList.add('resizing-column');
    });

    handle.addEventListener('pointermove', (event: PointerEvent) => {
      const state = this.resizing;
      if (!state) {
        return;
      }
      const width = state.startWidth + (event.clientX - state.startX);
      this.setColumnWidth(state.column, width);
    });

    const finish = (event: PointerEvent): void => {
      if (!this.resizing) {
        return;
      }
      this.resizing = null;
      document.body.classList.remove('resizing-column');
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      // Persist only on release: writing state on every frame of a drag is pointless churn.
      this.onColumnWidths(this.columnWidths);
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);

    handle.addEventListener('dblclick', (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      this.autoFitColumn(column);
      this.onColumnWidths(this.columnWidths);
    });

    headerCell.appendChild(handle);
  }

  private setColumnWidth(column: number, width: number): void {
    const clamped = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(width)));
    if (this.columnWidths[column] === clamped) {
      return;
    }
    this.columnWidths[column] = clamped;
    this.recomputeOffsets();
    this.applyColumnGeometry();
    this.scheduleRender();
  }

  /**
   * Size a column to its widest currently loaded value.
   *
   * Deliberately samples only the rows already in the DOM. Measuring the true widest value
   * would mean reading the whole file for a cosmetic decision; what the user can see is what
   * they are judging the width against anyway.
   */
  private autoFitColumn(column: number): void {
    const context = this.measurementContext();
    if (!context) {
      return;
    }
    const start = Math.max(0, this.firstRow - Math.floor(OVERSCAN_ROWS / 2));
    let widest = context.measureText(this.columns[column] ?? '').width + 24;

    for (let i = 0; i < this.rowNodes.length; i++) {
      const value = this.provider.cell(start + i, column);
      if (value) {
        widest = Math.max(widest, context.measureText(value).width);
      }
    }

    // 12px of padding either side, matching .grid-cell, plus a little breathing room.
    this.setColumnWidth(column, Math.ceil(widest) + 16);
  }

  /** Canvas text measurement: no layout, unlike reading offsetWidth off a probe element. */
  private measurementContext(): CanvasRenderingContext2D | null {
    if (!this.measureContext) {
      this.measureContext = document.createElement('canvas').getContext('2d');
    }
    if (this.measureContext && this.cellFont === '') {
      const sample = this.rowsContainer.querySelector('.grid-cell');
      if (sample) {
        const style = getComputedStyle(sample);
        this.cellFont = `${style.fontSize} ${style.fontFamily}`;
      }
    }
    if (this.measureContext) {
      this.measureContext.font = this.cellFont || '13px monospace';
    }
    return this.measureContext;
  }

  /** Fit every column at once, from the toolbar. */
  autoFitAll(): void {
    for (let column = 0; column < this.columns.length; column++) {
      this.autoFitColumn(column);
    }
    this.onColumnWidths(this.columnWidths);
  }

  resetWidths(): void {
    this.setColumns(this.columns);
    this.onColumnWidths(this.columnWidths);
  }

  // ------------------------------------------------------------------ render

  private computeColumnWindow(): boolean {
    let first = 0;
    while (first < this.columns.length && (this.columnOffsets[first + 1] ?? 0) < this.scrollLeft) {
      first++;
    }
    let last = first;
    const rightEdge = this.scrollLeft + this.viewportWidth;
    while (last < this.columns.length - 1 && (this.columnOffsets[last] ?? 0) < rightEdge) {
      last++;
    }
    first = Math.max(0, first - OVERSCAN_COLUMNS);
    last = Math.min(this.columns.length - 1, last + OVERSCAN_COLUMNS);

    if (first !== this.firstColumn || last !== this.lastColumn) {
      this.firstColumn = first;
      this.lastColumn = last;
      return true;
    }
    return false;
  }

  /** Build the header and filter rows. Only called when the column set itself changes. */
  private renderHeader(): void {
    this.header.textContent = '';
    this.filters.textContent = '';
    this.headerCells.length = 0;
    this.filterCells.length = 0;

    const gutter = document.createElement('div');
    gutter.className = 'grid-gutter header-gutter';
    gutter.textContent = '#';
    this.header.appendChild(gutter);

    const filterGutter = document.createElement('div');
    filterGutter.className = 'grid-gutter header-gutter';
    this.filters.appendChild(filterGutter);

    for (let column = 0; column < this.columns.length; column++) {
      const cell = document.createElement('div');
      cell.className = 'grid-cell header-cell';
      // textContent, never innerHTML: column names can come from a file we did not write.
      cell.textContent = this.columns[column] ?? '';
      cell.title = this.columns[column] ?? '';
      this.attachResizeHandle(cell, column);
      this.header.appendChild(cell);
      this.headerCells.push(cell);

      const filterCell = document.createElement('div');
      filterCell.className = 'grid-cell filter-cell';
      filterCell.dataset['column'] = String(column);
      this.filters.appendChild(filterCell);
      this.filterCells.push(filterCell);
    }

    this.applyColumnGeometry();
  }

  /**
   * Push current widths onto the header and filter nodes.
   *
   * Separate from renderHeader so a resize drag rewrites two style properties per visible
   * column instead of rebuilding several hundred DOM nodes per frame.
   */
  private applyColumnGeometry(): void {
    for (let column = 0; column < this.headerCells.length; column++) {
      const left = `${this.columnOffsets[column] ?? 0}px`;
      const width = `${this.columnWidths[column] ?? 100}px`;

      const headerCell = this.headerCells[column];
      if (headerCell) {
        headerCell.style.left = left;
        headerCell.style.width = width;
      }
      const filterCell = this.filterCells[column];
      if (filterCell) {
        filterCell.style.left = left;
        filterCell.style.width = width;
      }
    }

    const width = `${this.totalWidth}px`;
    this.header.style.width = width;
    this.filters.style.width = width;
    this.sizer.style.width = width;
    this.rowsContainer.style.width = width;
  }

  /** Used by main.ts to drop filter inputs into their cells after the header is built. */
  filterCellFor(column: number): HTMLElement | null {
    return this.filterCells[column] ?? null;
  }

  render(): void {
    if (this.columns.length === 0) {
      return;
    }
    if (this.computeColumnWindow()) {
      this.syncCellNodes();
    }

    const start = Math.max(0, this.firstRow - Math.floor(OVERSCAN_ROWS / 2));
    // translate3d keeps the block on the compositor; animating `top` would force layout.
    this.rowsContainer.style.transform = `translate3d(0, ${this.blockTop(start)}px, 0)`;

    for (let i = 0; i < this.rowNodes.length; i++) {
      const rowNode = this.rowNodes[i] as HTMLDivElement;
      const row = start + i;

      if (row >= this.rowCount) {
        rowNode.hidden = true;
        continue;
      }
      rowNode.hidden = false;
      rowNode.classList.toggle('odd', row % 2 === 1);

      const gutter = rowNode.firstElementChild as HTMLDivElement;
      const label = this.provider.rowLabel(row);
      gutter.textContent = label === null ? '' : String(label + 1);

      const cells = this.cellNodes[i] as HTMLDivElement[];
      for (let c = 0; c < cells.length; c++) {
        const column = this.firstColumn + c;
        const cell = cells[c] as HTMLDivElement;
        if (column > this.lastColumn || column >= this.columns.length) {
          cell.hidden = true;
          continue;
        }
        cell.hidden = false;
        cell.style.left = `${this.columnOffsets[column] ?? 0}px`;
        cell.style.width = `${this.columnWidths[column] ?? 100}px`;

        const value = this.provider.cell(row, column);
        if (value === null) {
          // Placeholder, same height: the grid never waits for data to draw a frame.
          cell.classList.add('pending');
          cell.textContent = '';
          cell.removeAttribute('title');
        } else {
          cell.classList.remove('pending');
          cell.textContent = value;
          // A narrowed column truncates; the full value stays reachable on hover.
          cell.title = value;
        }
      }
    }

    this.onRangeChanged(start, this.rowNodes.length);
    this.onScrollRow(this.firstRow);
  }

  /**
   * Where the recycled block of rows sits inside the scrolling content.
   *
   * Below the sizer cap, scroll position and row position are the same coordinate system,
   * so a row's pixel offset is simply row * ROW_HEIGHT and scrolling stays pixel-smooth.
   *
   * Above the cap those coordinates diverge: one scrolled pixel is worth many rows, so the
   * block is anchored to the current scroll position instead and the first visible row is
   * drawn flush with the top of the viewport. Scrolling then advances row by row rather
   * than pixel by pixel, which is the honest behaviour — there are not enough pixels left
   * to represent the rows individually.
   */
  private blockTop(start: number): number {
    if (!this.isCompressed) {
      return start * ROW_HEIGHT;
    }
    return this.viewport.scrollTop + (start - this.firstRow) * ROW_HEIGHT;
  }
}
