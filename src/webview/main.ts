/**
 * Webview entry point: wiring only.
 *
 * No parsing, no filtering, no knowledge of what a record is — the page renders what the
 * host sends and forwards what the user does. Keeping the boundary this strict is what
 * lets the same query semantics serve both the filter row and the SQL bar.
 */

import { filtersToSql } from '../core/query/uiFilters.js';
import type { SchemaProfile } from '../shared/schema.js';
import type { ToWebview, UiFilter, UiFilterOp } from '../shared/protocol.js';
import { RowStore } from './rowStore.js';
import { Ruler } from './ruler.js';
import { VirtualGrid } from './virtualGrid.js';
import { getState, post, setState } from './vscodeApi.js';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`Missing element #${id}`);
  }
  return found as T;
}

const dom = {
  fileName: element('file-name'),
  fileStats: element('file-stats'),
  gotoRow: element<HTMLInputElement>('goto-row'),
  btnSchema: element<HTMLButtonElement>('btn-schema'),
  btnRuler: element<HTMLButtonElement>('btn-ruler'),
  btnSaveSchema: element<HTMLButtonElement>('btn-save-schema'),
  queryInput: element<HTMLInputElement>('query-input'),
  btnRun: element<HTMLButtonElement>('btn-run'),
  btnCancel: element<HTMLButtonElement>('btn-cancel'),
  btnClear: element<HTMLButtonElement>('btn-clear'),
  btnExport: element<HTMLButtonElement>('btn-export'),
  queryStatus: element('query-status'),
  indexStatus: element('index-status'),
  schemaPanel: element('schema-panel'),
  schemaMode: element<HTMLSelectElement>('schema-mode'),
  schemaEncoding: element<HTMLSelectElement>('schema-encoding'),
  schemaLineEnding: element<HTMLSelectElement>('schema-line-ending'),
  recordLengthField: element('record-length-field'),
  schemaRecordLength: element<HTMLInputElement>('schema-record-length'),
  schemaSkip: element<HTMLInputElement>('schema-skip'),
  regexRow: element('regex-row'),
  schemaPattern: element<HTMLInputElement>('schema-pattern'),
  schemaRegexMode: element<HTMLSelectElement>('schema-regex-mode'),
  widthsRow: element('widths-row'),
  schemaWidths: element<HTMLInputElement>('schema-widths'),
  schemaNames: element<HTMLInputElement>('schema-names'),
  btnApplySchema: element<HTMLButtonElement>('btn-apply-schema'),
  rulerPanel: element('ruler-panel'),
  rulerTrack: element('ruler-track'),
  rulerSample: element('ruler-sample'),
  rulerSummary: element('ruler-summary'),
  btnRulerClear: element<HTMLButtonElement>('btn-ruler-clear'),
  btnRulerApply: element<HTMLButtonElement>('btn-ruler-apply'),
  gridHeader: element('grid-header'),
  gridFilters: element('grid-filters'),
  gridViewport: element('grid-viewport'),
  gridSizer: element('grid-sizer'),
  gridRows: element('grid-rows'),
  errorBanner: element('error-banner'),
  errorText: element('error-text'),
  errorDismiss: element<HTMLButtonElement>('error-dismiss'),
};

const FILTER_OPS: { value: UiFilterOp; label: string }[] = [
  { value: 'contains', label: 'contains' },
  { value: 'equals', label: '=' },
  { value: 'notEquals', label: '≠' },
  { value: 'startsWith', label: 'starts' },
  { value: 'endsWith', label: 'ends' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'regex', label: 'regex' },
  { value: 'empty', label: 'is empty' },
  { value: 'notEmpty', label: 'not empty' },
];

let schema: SchemaProfile | null = null;
let columns: string[] = [];
let queryGeneration = 1;
let queryRunning = false;
let hasResult = false;

const store = new RowStore(() => grid.render());

const grid = new VirtualGrid(
  dom.gridViewport,
  dom.gridSizer,
  dom.gridRows,
  dom.gridHeader,
  dom.gridFilters,
  store,
  (firstRow, count) => store.ensureRange(firstRow, count),
  (firstRow) => {
    // Header and filter row scroll horizontally with the grid but never vertically.
    dom.gridHeader.style.transform = `translate3d(${-dom.gridViewport.scrollLeft}px, 0, 0)`;
    dom.gridFilters.style.transform = `translate3d(${-dom.gridViewport.scrollLeft}px, 0, 0)`;
    persist({ firstRow });
  },
);

const ruler = new Ruler(dom.rulerTrack, dom.rulerSample, dom.rulerSummary, () => undefined);

// ---------------------------------------------------------------- state

function persist(patch: { firstRow?: number; query?: string }): void {
  const current = getState();
  setState({ ...current, ...patch });
}

// ---------------------------------------------------------------- filters

const filterState = new Map<number, { op: UiFilterOp; value: string }>();
let filterTimer: number | null = null;

function buildFilterRow(): void {
  filterState.clear();
  for (let column = 0; column < columns.length; column++) {
    const host = grid.filterCellFor(column);
    if (!host) {
      continue;
    }
    host.textContent = '';

    const select = document.createElement('select');
    select.className = 'filter-op';
    for (const option of FILTER_OPS) {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      select.appendChild(node);
    }

    const input = document.createElement('input');
    input.className = 'filter-value';
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = 'filter';

    const update = (): void => {
      const op = select.value as UiFilterOp;
      const valueless = op === 'empty' || op === 'notEmpty';
      input.disabled = valueless;
      if (valueless || input.value !== '') {
        filterState.set(column, { op, value: input.value });
      } else {
        filterState.delete(column);
      }
      scheduleFilterRun();
    };

    select.addEventListener('change', update);
    input.addEventListener('input', update);

    host.appendChild(select);
    host.appendChild(input);
  }
}

function scheduleFilterRun(): void {
  if (filterTimer !== null) {
    clearTimeout(filterTimer);
  }
  // Typing in a filter box must not launch a full-file scan per keystroke.
  filterTimer = setTimeout(() => {
    filterTimer = null;
    runFilters();
  }, 350) as unknown as number;
}

function currentFilters(): UiFilter[] {
  const filters: UiFilter[] = [];
  for (const [column, state] of filterState) {
    const name = columns[column];
    if (name) {
      filters.push({ column: name, op: state.op, value: state.value });
    }
  }
  return filters;
}

function runFilters(): void {
  const filters = currentFilters();
  queryGeneration++;
  if (filters.length === 0) {
    post({ type: 'clearResult' });
    return;
  }
  // Show the equivalent SQL, so the simple mode teaches the advanced one.
  dom.queryInput.value = filtersToSql(filters);
  setQueryRunning(true);
  post({ type: 'runFilters', gen: queryGeneration, filters });
}

// ---------------------------------------------------------------- schema panel

function syncSchemaPanelVisibility(): void {
  const isFixed = dom.schemaMode.value === 'fixed';
  dom.regexRow.hidden = isFixed;
  dom.widthsRow.hidden = !isFixed;
  dom.recordLengthField.hidden = dom.schemaLineEnding.value !== 'none';
}

function populateSchemaPanel(profile: SchemaProfile): void {
  dom.schemaMode.value = profile.mode;
  dom.schemaEncoding.value = profile.encoding;
  dom.schemaLineEnding.value = profile.lineEnding;
  dom.schemaRecordLength.value = profile.recordLength ? String(profile.recordLength) : '';
  dom.schemaSkip.value = String(profile.skipRecords ?? 0);
  dom.schemaPattern.value = profile.pattern ?? '';
  dom.schemaRegexMode.value = profile.regexMode ?? 'split';
  dom.schemaWidths.value = profile.mode === 'fixed' ? profile.columns.map((c) => c.length).join(', ') : '';
  dom.schemaNames.value = profile.columns.map((c) => c.name).join(', ');
  syncSchemaPanelVisibility();
}

function readSchemaPanel(): SchemaProfile {
  const mode = dom.schemaMode.value === 'fixed' ? 'fixed' : 'regex';
  const names = dom.schemaNames.value.split(',').map((name) => name.trim()).filter(Boolean);
  const lineEnding = dom.schemaLineEnding.value as SchemaProfile['lineEnding'];
  const recordLength = Number(dom.schemaRecordLength.value) || undefined;

  const base = {
    version: 1 as const,
    encoding: dom.schemaEncoding.value as SchemaProfile['encoding'],
    lineEnding,
    skipRecords: Math.max(0, Number(dom.schemaSkip.value) || 0),
    ...(recordLength ? { recordLength } : {}),
  };

  if (mode === 'fixed') {
    const widths = dom.schemaWidths.value
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((width) => Number.isFinite(width) && width > 0);

    let start = 0;
    const columnDefs = widths.map((length, index) => {
      const definition = {
        name: names[index] ?? `col${index + 1}`,
        start,
        length,
        type: 'string' as const,
        trim: 'both' as const,
      };
      start += length;
      return definition;
    });

    return { ...base, mode: 'fixed', columns: columnDefs };
  }

  // Column count for a split pattern is inferred by the host, which has the file.
  const columnDefs = names.map((name) => ({
    name,
    start: 0,
    length: 0,
    type: 'string' as const,
    trim: 'both' as const,
  }));

  return {
    ...base,
    mode: 'regex',
    pattern: dom.schemaPattern.value || '\\s{2,}',
    regexMode: dom.schemaRegexMode.value === 'match' ? 'match' : 'split',
    columns: columnDefs,
  };
}

// ---------------------------------------------------------------- status

function setQueryRunning(running: boolean): void {
  queryRunning = running;
  dom.btnRun.disabled = running;
  dom.btnCancel.disabled = !running;
}

function showError(message: string): void {
  dom.errorText.textContent = message;
  dom.errorBanner.hidden = false;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

// ---------------------------------------------------------------- events

dom.btnSchema.addEventListener('click', () => {
  dom.schemaPanel.hidden = !dom.schemaPanel.hidden;
});

dom.btnRuler.addEventListener('click', () => {
  dom.rulerPanel.hidden = !dom.rulerPanel.hidden;
  if (!dom.rulerPanel.hidden) {
    post({ type: 'requestSample', rows: 40 });
  }
});

dom.schemaMode.addEventListener('change', syncSchemaPanelVisibility);
dom.schemaLineEnding.addEventListener('change', syncSchemaPanelVisibility);

dom.btnApplySchema.addEventListener('click', () => {
  post({ type: 'setSchema', schema: readSchemaPanel() });
});

dom.btnSaveSchema.addEventListener('click', () => post({ type: 'saveSchema' }));

dom.btnRulerClear.addEventListener('click', () => ruler.clear());

dom.btnRulerApply.addEventListener('click', () => {
  const widths = ruler.widths();
  if (widths.length === 0) {
    return;
  }
  dom.schemaMode.value = 'fixed';
  dom.schemaWidths.value = widths.join(', ');
  syncSchemaPanelVisibility();
  post({ type: 'setSchema', schema: readSchemaPanel() });
});

dom.btnRun.addEventListener('click', () => {
  const sql = dom.queryInput.value.trim();
  if (sql === '') {
    return;
  }
  queryGeneration++;
  setQueryRunning(true);
  dom.queryStatus.hidden = false;
  dom.queryStatus.textContent = 'Scanning...';
  persist({ query: sql });
  post({ type: 'runQuery', gen: queryGeneration, sql });
});

dom.queryInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    dom.btnRun.click();
  }
});

dom.btnCancel.addEventListener('click', () => {
  post({ type: 'cancel', gen: queryGeneration });
  setQueryRunning(false);
  dom.queryStatus.textContent = 'Cancelled.';
});

dom.btnClear.addEventListener('click', () => {
  for (const input of dom.gridFilters.querySelectorAll<HTMLInputElement>('.filter-value')) {
    input.value = '';
  }
  filterState.clear();
  post({ type: 'clearResult' });
});

dom.btnExport.addEventListener('click', () => post({ type: 'exportResult' }));

dom.errorDismiss.addEventListener('click', () => {
  dom.errorBanner.hidden = true;
});

dom.gotoRow.addEventListener('change', () => {
  const row = Math.max(0, (Number(dom.gotoRow.value) || 1) - 1);
  grid.scrollToRow(row);
  store.flushNow();
});

dom.gridViewport.addEventListener('scroll', () => {
  dom.gridHeader.style.transform = `translate3d(${-dom.gridViewport.scrollLeft}px, 0, 0)`;
  dom.gridFilters.style.transform = `translate3d(${-dom.gridViewport.scrollLeft}px, 0, 0)`;
}, { passive: true });

// ---------------------------------------------------------------- host messages

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'init': {
      schema = message.schema;
      columns = [...message.columns];
      dom.fileName.textContent = message.meta.fileName;
      populateSchemaPanel(message.schema);
      applyColumns();
      grid.setRowCount(message.meta.rowCount);
      store.setRowCount(message.meta.rowCount);
      updateStats(message.meta.sizeBytes, message.meta.rowCount, message.meta.rowCountFinal);

      const state = getState();
      if (state.query) {
        dom.queryInput.value = state.query;
      }
      if (state.firstRow) {
        grid.scrollToRow(state.firstRow);
      }
      break;
    }

    case 'meta': {
      grid.setRowCount(message.meta.rowCount);
      store.setRowCount(message.meta.rowCount);
      updateStats(message.meta.sizeBytes, message.meta.rowCount, message.meta.rowCountFinal);
      break;
    }

    case 'schema': {
      schema = message.schema;
      columns = [...message.columns];
      populateSchemaPanel(message.schema);
      store.invalidate();
      applyColumns();
      grid.render();
      break;
    }

    case 'rows': {
      store.accept(message.gen, message.payload);
      break;
    }

    case 'sample': {
      ruler.setSample(message.lines);
      if (schema?.mode === 'fixed' && schema.columns.length > 0) {
        ruler.setWidths(schema.columns.map((column) => column.length));
      }
      break;
    }

    case 'indexProgress': {
      dom.indexStatus.textContent = message.done
        ? `Indexed ${message.rows.toLocaleString()} rows.`
        : `Indexing… ${message.rows.toLocaleString()} rows · ${formatBytes(message.bytes)} of ${formatBytes(message.totalBytes)}`;
      break;
    }

    case 'queryProgress': {
      if (message.gen !== queryGeneration) {
        return; // A superseded query; its numbers describe a result nobody is looking at.
      }
      dom.queryStatus.hidden = false;
      const percent = message.totalBytes > 0 ? Math.round((message.scannedBytes / message.totalBytes) * 100) : 0;
      dom.queryStatus.textContent = message.done
        ? `${message.matched.toLocaleString()} matching rows in ${message.elapsedMs} ms${message.truncated ? ' (truncated)' : ''}`
        : `Scanning ${percent}% · ${message.matched.toLocaleString()} matches so far`;

      if (message.done) {
        setQueryRunning(false);
        hasResult = true;
        dom.btnClear.disabled = false;
        dom.btnExport.disabled = false;
        store.invalidate();
        grid.render();
      }
      break;
    }

    case 'resultCleared': {
      hasResult = false;
      queryRunning = false;
      dom.btnClear.disabled = true;
      dom.btnExport.disabled = true;
      dom.queryStatus.hidden = true;
      store.invalidate();
      grid.render();
      break;
    }

    case 'focusQueryBar': {
      dom.queryInput.focus();
      dom.queryInput.select();
      break;
    }

    case 'toggleRuler': {
      dom.btnRuler.click();
      break;
    }

    case 'goToRow': {
      grid.scrollToRow(message.row);
      store.flushNow();
      break;
    }

    case 'error': {
      showError(message.message);
      if (queryRunning) {
        setQueryRunning(false);
      }
      break;
    }
  }
});

function applyColumns(): void {
  const widths = schema?.mode === 'fixed' ? schema.columns.map((column) => column.length) : undefined;
  grid.setColumns(columns, widths);
  buildFilterRow();
}

function updateStats(sizeBytes: number, rowCount: number, final: boolean): void {
  const suffix = final ? '' : '+';
  const mode = hasResult ? ' · result' : '';
  dom.fileStats.textContent = `${formatBytes(sizeBytes)} · ${rowCount.toLocaleString()}${suffix} rows${mode}`;
}

post({ type: 'ready' });
