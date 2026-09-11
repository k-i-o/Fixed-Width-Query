/**
 * Messages between the extension host and its worker threads.
 *
 * Bulk results travel as transferred Float64Arrays. Structured-cloning an array of a few
 * million numbers would cost more than the scan that produced them.
 */

import type { SelectStatement } from '../core/query/ast.js';
import type { SchemaProfile } from './schema.js';

export interface IndexRequest {
  readonly kind: 'index';
  readonly path: string;
  readonly stride: number;
  readonly dataStart: number;
  readonly fileSize: number;
  readonly chunkBytes: number;
}

export type IndexMessage =
  | {
      readonly type: 'checkpoints';
      /** Absolute offsets of the rows at each new checkpoint. Transferred. */
      readonly offsets: Float64Array;
      readonly rows: number;
      readonly bytes: number;
    }
  | { readonly type: 'done'; readonly rows: number; readonly bytes: number }
  | { readonly type: 'failed'; readonly message: string };

export interface QueryRequest {
  readonly kind: 'query';
  readonly path: string;
  readonly schema: SchemaProfile;
  readonly statement: SelectStatement;
  readonly dataStart: number;
  readonly fileSize: number;
  readonly recordLength: number;
  readonly lineEnding: 'lf' | 'crlf' | 'none';
  readonly chunkBytes: number;
  readonly maxResults: number;
}

export type QueryMessage =
  | {
      readonly type: 'batch';
      /** Byte offset of each matching record; the row fetcher reads these directly. */
      readonly offsets: Float64Array;
      readonly rowIndices: Float64Array;
      readonly scannedBytes: number;
      readonly matched: number;
    }
  | { readonly type: 'progress'; readonly scannedBytes: number; readonly matched: number }
  | {
      readonly type: 'done';
      readonly offsets: Float64Array;
      readonly rowIndices: Float64Array;
      readonly matched: number;
      readonly scannedBytes: number;
      readonly truncated: boolean;
      readonly elapsedMs: number;
      /** True when results were sorted, so earlier batches must be discarded. */
      readonly replacesPartials: boolean;
    }
  | { readonly type: 'failed'; readonly message: string };

export type WorkerRequest = IndexRequest | QueryRequest;
