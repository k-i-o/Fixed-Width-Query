/**
 * The single definition of what the Extension Host and the Webview may say to each other.
 *
 * Two rules make this protocol work at scale:
 *  1. Row content never travels as JSON. It travels in the binary envelope defined in
 *     `rowsCodec.ts`, transferred rather than copied.
 *  2. Every data request carries a monotonic `gen`. A response whose `gen` is stale is
 *     dropped on arrival instead of being rendered, which is what keeps fast scrolling
 *     from rendering rows the user has already scrolled past.
 */

import type { SchemaProfile } from './schema.js';

export interface RowRange {
  readonly from: number;
  readonly count: number;
}

export interface FileMeta {
  readonly fileName: string;
  readonly sizeBytes: number;
  /** Grows while indexing runs; `rowCountFinal` says whether it can still change. */
  readonly rowCount: number;
  readonly rowCountFinal: boolean;
  readonly detectedLineEnding: 'lf' | 'crlf' | 'none';
}

export type ErrorCode =
  | 'FILE_UNREADABLE'
  | 'FILE_CHANGED'
  | 'SCHEMA_INVALID'
  | 'QUERY_SYNTAX'
  | 'QUERY_SEMANTIC'
  | 'QUERY_FAILED'
  | 'INDEX_FAILED'
  | 'EXPORT_FAILED'
  | 'INTERNAL';

/** A filter built by the column filter row in the UI. Compiled through the same AST as SQL. */
export type UiFilterOp = 'contains' | 'equals' | 'notEquals' | 'startsWith' | 'endsWith' | 'gt' | 'gte' | 'lt' | 'lte' | 'regex' | 'empty' | 'notEmpty';

export interface UiFilter {
  readonly column: string;
  readonly op: UiFilterOp;
  readonly value: string;
}

export type ToHost =
  | { readonly type: 'ready' }
  | { readonly type: 'fetchRows'; readonly gen: number; readonly range: RowRange }
  | { readonly type: 'setSchema'; readonly schema: SchemaProfile }
  | { readonly type: 'requestSample'; readonly rows: number }
  | { readonly type: 'runQuery'; readonly gen: number; readonly sql: string }
  | { readonly type: 'runFilters'; readonly gen: number; readonly filters: readonly UiFilter[] }
  | { readonly type: 'clearResult' }
  | { readonly type: 'cancel'; readonly gen: number }
  | { readonly type: 'saveSchema' }
  | { readonly type: 'saveSchemaAs' }
  | { readonly type: 'loadSchema' }
  | { readonly type: 'exportResult' }
  | { readonly type: 'log'; readonly message: string };

export type ToWebview =
  | { readonly type: 'init'; readonly meta: FileMeta; readonly schema: SchemaProfile; readonly columns: readonly string[] }
  | { readonly type: 'meta'; readonly meta: FileMeta }
  | { readonly type: 'schema'; readonly schema: SchemaProfile; readonly columns: readonly string[] }
  /** `payload` is the binary envelope from rowsCodec; it arrives as a Uint8Array. */
  | { readonly type: 'rows'; readonly gen: number; readonly payload: Uint8Array }
  | { readonly type: 'sample'; readonly lines: readonly string[] }
  | { readonly type: 'indexProgress'; readonly rows: number; readonly bytes: number; readonly totalBytes: number; readonly done: boolean }
  | {
      readonly type: 'queryProgress';
      readonly gen: number;
      readonly matched: number;
      readonly scannedBytes: number;
      readonly totalBytes: number;
      readonly done: boolean;
      readonly truncated: boolean;
      readonly elapsedMs: number;
    }
  | { readonly type: 'queryPlan'; readonly gen: number; readonly description: string; readonly columns: readonly string[] }
  | { readonly type: 'resultCleared' }
  /** Which profile the current schema came from, or null if it was inferred. */
  | { readonly type: 'profile'; readonly path: string | null }
  | { readonly type: 'focusQueryBar' }
  | { readonly type: 'toggleRuler' }
  | { readonly type: 'goToRow'; readonly row: number }
  | { readonly type: 'error'; readonly code: ErrorCode; readonly message: string; readonly detail?: string };

/**
 * Inbound messages are untrusted: the webview is a browser page rendering arbitrary file
 * content. Validate shape and bounds here, once, before anything reaches the file layer.
 */
export function isToHost(value: unknown): value is ToHost {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string';
}

/** Clamp a requested range so a malformed UI message cannot ask for a gigabyte of rows. */
export const MAX_ROWS_PER_REQUEST = 2048;

export function sanitizeRange(range: unknown): RowRange | null {
  if (typeof range !== 'object' || range === null) {
    return null;
  }
  const { from, count } = range as { from?: unknown; count?: unknown };
  if (typeof from !== 'number' || typeof count !== 'number') {
    return null;
  }
  if (!Number.isFinite(from) || !Number.isFinite(count) || from < 0 || count <= 0) {
    return null;
  }
  return { from: Math.floor(from), count: Math.min(Math.floor(count), MAX_ROWS_PER_REQUEST) };
}
