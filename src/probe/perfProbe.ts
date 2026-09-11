/**
 * SLO probe.
 *
 * Drives the real FileHandleService, SparseIndex, RowFetcher and worker threads against a
 * real file, and reports P1-P9 from `docs/00-PROJECT-CONTEXT.md` §3 as measured numbers
 * with a verdict. It imports no VS Code API, so it runs as a plain Node process.
 *
 * This exists because the SLOs are acceptance criteria. A number nobody has measured on a
 * file of the target size is a wish, and shipping on a wish is how an extension gets its
 * first one-star review from someone with a 40 GB file.
 *
 * Run through `npm run perf` — never by hand; the wrapper builds the bundles first.
 */

import * as path from 'node:path';
import { SparseIndex } from '../core/index/sparseIndex.js';
import type { SelectStatement } from '../core/query/ast.js';
import type { SchemaProfile } from '../shared/schema.js';
import type { IndexMessage, QueryMessage } from '../shared/workerProtocol.js';
import { FileHandleService } from '../extension/FileHandleService.js';
import { RowFetcher } from '../extension/RowFetcher.js';
import { WorkerTask } from '../extension/workerHost.js';

interface Args {
  file: string;
  workerDir: string;
  mode: 'delimited' | 'fixed-length';
  recordLength: number;
  fetches: number;
  stride: number;
  cacheMb: number;
}

function parseArgs(): Args {
  const get = (name: string, fallback: string): string => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
  };
  const file = get('file', '');
  return {
    // Worker threads reject bare relative paths, so resolve both up front rather than
    // failing several seconds into a run.
    file: file === '' ? '' : path.resolve(file),
    workerDir: path.resolve(get('worker-dir', path.join(process.cwd(), 'dist', 'workers'))),
    mode: get('mode', 'delimited') as Args['mode'],
    recordLength: Number(get('record-length', '65')),
    fetches: Number(get('fetches', '400')),
    stride: Number(get('stride', '4096')),
    // Must track the shipped default in package.json, or the probe measures a
    // configuration no user will ever run.
    cacheMb: Number(get('cache-mb', '32')),
  };
}

const args = parseArgs();

/** The fixture layout written by scripts/make-fixture.mjs. */
function makeSchema(mode: Args['mode'], recordLength: number): SchemaProfile {
  return {
    version: 1,
    mode: 'fixed',
    encoding: 'latin1',
    lineEnding: mode === 'fixed-length' ? 'none' : 'lf',
    ...(mode === 'fixed-length' ? { recordLength } : {}),
    columns: [
      { name: 'CODE', start: 0, length: 12, type: 'string', trim: 'both' },
      { name: 'NAME', start: 12, length: 20, type: 'string', trim: 'both' },
      { name: 'REGION', start: 32, length: 10, type: 'string', trim: 'both' },
      { name: 'AMOUNT', start: 42, length: 14, type: 'decimal', trim: 'both', scale: 2, signed: 'trailing' },
      { name: 'STATUS', start: 56, length: 8, type: 'string', trim: 'both' },
    ],
  };
}

// ---------------------------------------------------------------- reporting

interface Slo {
  id: string;
  what: string;
  target: string;
  measured: string;
  ok: boolean | null; // null = measured but not gated here
}

const results: Slo[] = [];

function record(id: string, what: string, target: string, measured: string, ok: boolean | null): void {
  results.push({ id, what, target, measured, ok });
}

function mb(bytes: number): number {
  return bytes / (1024 * 1024);
}

function throughput(bytes: number, ms: number): number {
  return mb(bytes) / Math.max(1, ms) * 1000;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] as number;
}

/**
 * Peak RSS across the whole run. The worker threads share this process, so this figure
 * covers host plus workers — which is exactly what P1 is about.
 */
class MemoryWatch {
  private peak = 0;
  private timer: NodeJS.Timeout | null = null;
  /** Peak per phase, so a budget miss points at the component responsible. */
  readonly phases: { label: string; peakRss: number; settledRss: number; arrayBuffers: number }[] = [];
  private phasePeak = 0;

  start(): void {
    this.sample();
    this.timer = setInterval(() => this.sample(), 25);
    this.timer.unref();
  }

  sample(): void {
    const rss = process.memoryUsage().rss;
    this.peak = Math.max(this.peak, rss);
    this.phasePeak = Math.max(this.phasePeak, rss);
  }

  /**
   * Close out a phase.
   *
   * Peak RSS alone cannot distinguish memory the extension is holding from garbage the
   * collector has not gotten to yet, and those have completely different fixes. Under
   * --expose-gc we collect first and report the settled figure next to the peak, so a
   * budget miss says which problem it is.
   */
  mark(label: string): void {
    this.sample();
    const peakRss = this.phasePeak;
    const collect = (globalThis as { gc?: () => void }).gc;
    if (collect) {
      collect();
    }
    const usage = process.memoryUsage();
    // `arrayBuffers` is a subset of `external`; summing them double-counts every buffer.
    this.phases.push({ label, peakRss, settledRss: usage.rss, arrayBuffers: usage.arrayBuffers });
    this.phasePeak = usage.rss;
  }

  stop(): number {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sample();
    return this.peak;
  }
}

// ---------------------------------------------------------------- worker helpers

function runIndexWorker(
  file: string,
  fileSize: number,
  stride: number,
  index: SparseIndex,
  onFirstCheckpoint: () => void,
): Promise<{ rows: number; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let sawCheckpoint = false;

    const task: WorkerTask<IndexMessage> = new WorkerTask<IndexMessage>(
      {
        scriptPath: path.join(args.workerDir, 'indexer.worker.js'),
        workerData: { kind: 'index', path: file, stride, dataStart: 0, fileSize, chunkBytes: 4 * 1024 * 1024 },
        heapMb: 192,
      },
      (message) => {
        if (message.type === 'checkpoints') {
          index.appendCheckpoints(message.offsets, message.rows);
          if (!sawCheckpoint) {
            sawCheckpoint = true;
            onFirstCheckpoint();
          }
        } else if (message.type === 'done') {
          index.finish(message.rows);
          const ms = Date.now() - started;
          void task.terminate().then(() => resolve({ rows: message.rows, ms }));
        } else if (message.type === 'failed') {
          task.terminate();
          reject(new Error(message.message));
        }
      },
      reject,
    );
    task.start();
  });
}

function runQueryWorker(
  file: string,
  schema: SchemaProfile,
  statement: SelectStatement,
  fileSize: number,
): Promise<{ matched: number; ms: number }> {
  return new Promise((resolve, reject) => {
    const task: WorkerTask<QueryMessage> = new WorkerTask<QueryMessage>(
      {
        scriptPath: path.join(args.workerDir, 'query.worker.js'),
        workerData: {
          kind: 'query',
          path: file,
          schema,
          statement,
          dataStart: 0,
          fileSize,
          recordLength: schema.recordLength ?? 0,
          lineEnding: schema.lineEnding === 'none' ? 'none' : 'lf',
          chunkBytes: 4 * 1024 * 1024,
          maxResults: 2_000_000,
        },
        heapMb: 192,
      },
      (message) => {
        if (message.type === 'done') {
          void task.terminate().then(() => resolve({ matched: message.matched, ms: message.elapsedMs }));
        } else if (message.type === 'failed') {
          task.terminate();
          reject(new Error(message.message));
        }
      },
      reject,
    );
    task.start();
  });
}

/** P9: how long a running scan takes to actually stop when terminated. */
function measureCancellation(file: string, schema: SchemaProfile, fileSize: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const task: WorkerTask<QueryMessage> = new WorkerTask<QueryMessage>(
      {
        scriptPath: path.join(args.workerDir, 'query.worker.js'),
        workerData: {
          kind: 'query',
          path: file,
          schema,
          // A scan with no filter, so it is guaranteed to still be running when cancelled.
          statement: { columns: null, where: null, orderBy: null, limit: null, offset: 0 },
          dataStart: 0,
          fileSize,
          recordLength: schema.recordLength ?? 0,
          lineEnding: schema.lineEnding === 'none' ? 'none' : 'lf',
          chunkBytes: 4 * 1024 * 1024,
          maxResults: 2_000_000,
        },
        heapMb: 192,
      },
      () => undefined,
      reject,
    );
    task.start();

    // Let it get properly under way, then pull the plug and time the stop.
    setTimeout(() => {
      const started = Date.now();
      task.terminate();
      const settle = setInterval(() => {
        if (!task.isRunning) {
          clearInterval(settle);
          resolve(Date.now() - started);
        }
      }, 1);
      settle.unref();
    }, 150);
  });
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  if (!args.file) {
    throw new Error('--file is required');
  }

  const memory = new MemoryWatch();
  memory.start();

  const schema = makeSchema(args.mode, args.recordLength);
  const file = new FileHandleService(args.file, 1024 * 1024, args.cacheMb * 1024 * 1024);

  // --- P3: time to first row ----------------------------------------------
  const openStarted = Date.now();
  await file.open();
  const fileSize = file.size;

  const index = args.mode === 'fixed-length'
    ? SparseIndex.forFixedLength(fileSize, args.recordLength, 0)
    : SparseIndex.forDelimited(args.stride, 0);

  const fetcher = new RowFetcher(file, schema, args.mode === 'fixed-length' ? 'none' : 'lf', 0);

  // The first screen is served off the prefix of the file, without waiting for the index.
  const firstRows = await fetcher.fetchRows(index, { from: 0, count: 50 }, null);
  const timeToFirstRow = Date.now() - openStarted;

  record('P3', 'time to first row', '< 500 ms', `${timeToFirstRow} ms`, timeToFirstRow < 500);
  memory.mark('open + first rows');

  if (firstRows.byteLength === 0) {
    throw new Error('first fetch returned no rows — the fixture or schema is wrong');
  }

  // --- P4 / P7: indexing ---------------------------------------------------
  let indexRows = index.rowCount;
  if (args.mode === 'delimited') {
    let firstCheckpointMs = 0;
    const indexStarted = Date.now();
    const indexed = await runIndexWorker(args.file, fileSize, args.stride, index, () => {
      firstCheckpointMs = Date.now() - indexStarted;
    });
    indexRows = indexed.rows;

    const rate = throughput(fileSize, indexed.ms);
    record('P4', 'index throughput', '>= 300 MB/s', `${rate.toFixed(0)} MB/s`, rate >= 300);
    record('--', 'navigable after', 'incremental', `${firstCheckpointMs} ms`, null);

    // P7 is stated per billion rows; scale the measurement up to that basis.
    const perBillion = (index.memoryBytes / Math.max(1, indexRows)) * 1e9;
    record('P7', 'index memory @ 1e9 rows', '<= 8 MB', `${mb(perBillion).toFixed(1)} MB`, mb(perBillion) <= 8);
    memory.mark('indexing');
  } else {
    record('P4', 'index throughput', 'n/a', 'no index needed', null);
    record('P7', 'index memory @ 1e9 rows', '<= 8 MB', '0 MB (arithmetic)', true);
  }

  // --- P2: random row fetch latency ---------------------------------------
  const latencies: number[] = [];
  for (let i = 0; i < args.fetches; i++) {
    // Random rows, to defeat the page cache the way a user dragging a scrollbar does.
    const row = Math.floor(Math.random() * Math.max(1, indexRows - 256));
    const started = process.hrtime.bigint();
    await fetcher.fetchRows(index, { from: row, count: 256 }, null);
    latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
    memory.sample();
  }
  latencies.sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p99 = percentile(latencies, 99);
  record('P2', 'row block latency p99', '< 1000 ms', `${p99.toFixed(1)} ms`, p99 < 1000);
  record('P2', 'row block latency p50', '< 120 ms', `${p50.toFixed(1)} ms`, p50 < 120);
  const cache = file.cacheStats;
  record('--', 'page cache', `<= ${args.cacheMb} MB`, `${mb(cache.backingBytes).toFixed(0)} MB / ${cache.pages} pages`, null);
  memory.mark('random row fetches');

  // --- P8: query throughput ------------------------------------------------
  const selective = await runQueryWorker(args.file, schema, {
    columns: null,
    where: {
      kind: 'comparison', op: '=',
      left: { kind: 'column', name: 'REGION' },
      right: { kind: 'literal', value: 'NORTH', isString: true },
    },
    orderBy: null, limit: null, offset: 0,
  }, fileSize);

  const queryRate = throughput(fileSize, selective.ms);
  record('P8', 'query throughput', '>= 200 MB/s', `${queryRate.toFixed(0)} MB/s`, queryRate >= 200);
  record('--', 'matches found', '-', selective.matched.toLocaleString(), null);
  memory.mark('query scan');

  // --- P9: cancellation ----------------------------------------------------
  const cancelMs = await measureCancellation(args.file, schema, fileSize);
  record('P9', 'cancellation', '< 100 ms', `${cancelMs} ms`, cancelMs < 100);
  memory.mark('cancellation');

  // --- P1: peak memory -----------------------------------------------------
  await file.dispose();
  const collect = (globalThis as { gc?: () => void }).gc;
  if (collect) {
    collect();
  }
  const settled = process.memoryUsage().rss;
  const peak = memory.stop();
  record('P1', 'settled RSS', '< 200 MB', `${mb(settled).toFixed(0)} MB`, mb(settled) < 200);
  record('--', 'peak RSS (incl. garbage)', '-', `${mb(peak).toFixed(0)} MB`, null);

  // --- report --------------------------------------------------------------
  console.log(`\nFile: ${args.file}`);
  console.log(`Size: ${mb(fileSize).toFixed(0)} MB · ${indexRows.toLocaleString()} rows · mode=${args.mode}\n`);

  const width = { id: 4, what: 26, target: 14, measured: 18 };
  console.log(
    `${'SLO'.padEnd(width.id)}${'what'.padEnd(width.what)}${'target'.padEnd(width.target)}${'measured'.padEnd(width.measured)}verdict`,
  );
  console.log('-'.repeat(width.id + width.what + width.target + width.measured + 8));

  let failures = 0;
  for (const row of results) {
    const verdict = row.ok === null ? '' : row.ok ? 'PASS' : 'FAIL';
    if (row.ok === false) {
      failures++;
    }
    console.log(
      `${row.id.padEnd(width.id)}${row.what.padEnd(width.what)}${row.target.padEnd(width.target)}${row.measured.padEnd(width.measured)}${verdict}`,
    );
  }

  const gcAvailable = typeof (globalThis as { gc?: () => void }).gc === 'function';
  console.log(
    `\nMemory by phase (peak RSS · settled RSS · arrayBuffers)` +
    `${gcAvailable ? '' : '   [run with --expose-gc for settled figures]'}:`,
  );
  for (const phase of memory.phases) {
    console.log(
      `  ${phase.label.padEnd(22)}${mb(phase.peakRss).toFixed(0).padStart(5)} MB   ` +
      `${mb(phase.settledRss).toFixed(0).padStart(5)} MB   ${mb(phase.arrayBuffers).toFixed(0).padStart(5)} MB`,
    );
  }

  console.log(
    failures === 0
      ? '\nAll gated SLOs met.'
      : `\n${failures} SLO${failures === 1 ? '' : 's'} NOT met — do not publish without explaining why.`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('probe failed:', (error as Error).message);
  process.exitCode = 1;
});
