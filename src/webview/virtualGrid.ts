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
 * Browsers cap element height near 33.5M pixels in Chromium; past that, scrolling silently
 * loses precision and the scrollbar starts jumping. At 22px per row that ceiling arrives
 * around 1.5M rows — well inside our target. So the sizer is capped and scroll position is
 * mapped onto the row range instead of corresponding to it one-to-one.
 */
const MAX_SIZER_PX = 10_000_000;

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
  private columnOffsets: number[] = [0];

  private firstRow = 0;
  private poolSize = 0;
  private readonly rowNodes: HTMLDivElement[] = [];
  private readonly cellNodes: HTMLDivElement[][] = [];

  private viewportHeight = 0;
  private viewportWidth = 0;
  private scrollLeft = 0;
  private suppressScrollEvent = false;
  private frameRequested = false;

  private firstColumn = 0;
  private lastColumn = 0;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly sizer: HTMLElement,
    private readonly rowsContainer: HTMLElement,
    private readonly header: HTMLElement,
    private readonly filters: HTMLElement,
    private readonly provider: GridProvider,
    private readonly onRangeChanged: (firstRow: number, count: number) => void,
    private readonly onScrollRow: (firstRow: number) => void,
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

  setColumns(names: readonly string[], widths?: readonly number[]): void {
    this.columns = [...names];
    this.columnWidths = this.columns.map((name, index) => {
      const declared = widths?.[index];
      // Width tracks the declared field length where there is one, so a fixed-width file
      // lines up on screen the way it does in the file.
      const estimated = declared && declared > 0 ? declared * 8 + 16 : Math.max(90, name.length * 9 + 24);
      return Math.min(600, Math.max(60, estimated));
    });

    this.columnOffsets = [0];
    for (const width of this.columnWidths) {
      this.columnOffsets.push((this.columnOffsets[this.columnOffsets.length - 1] as number) + width);
    }

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

  get totalWidth(): number {
    return this.columnOffsets[this.columnOffsets.length - 1] ?? 0;
  }

  get currentFirstRow(): number {
    return this.firstRow;
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

  private renderHeader(): void {
    this.header.textContent = '';
    this.filters.textContent = '';

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
      cell.style.left = `${this.columnOffsets[column] ?? 0}px`;
      cell.style.width = `${this.columnWidths[column] ?? 100}px`;
      // textContent, never innerHTML: column names can come from a file we did not write.
      cell.textContent = this.columns[column] ?? '';
      cell.title = this.columns[column] ?? '';
      this.header.appendChild(cell);

      const filterCell = document.createElement('div');
      filterCell.className = 'grid-cell filter-cell';
      filterCell.style.left = `${this.columnOffsets[column] ?? 0}px`;
      filterCell.style.width = `${this.columnWidths[column] ?? 100}px`;
      filterCell.dataset['column'] = String(column);
      this.filters.appendChild(filterCell);
    }

    const width = `${this.totalWidth}px`;
    this.header.style.width = width;
    this.filters.style.width = width;
    this.sizer.style.width = width;
  }

  /** Called by main.ts after the header is built, to drop filter inputs into their cells. */
  filterCellFor(column: number): HTMLElement | null {
    return this.filters.querySelector(`.filter-cell[data-column="${column}"]`);
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
    this.rowsContainer.style.width = `${this.totalWidth}px`;

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
        } else {
          cell.classList.remove('pending');
          cell.textContent = value;
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
