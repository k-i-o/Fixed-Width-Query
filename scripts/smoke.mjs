/**
 * End-to-end smoke test against the built bundles.
 *
 * Unit tests cover the pure core; this covers what they cannot: that the real worker
 * threads, reading a real file through real streams, produce the same answer as a naive
 * whole-file scan. Chunk-boundary bugs only ever show up here.
 *
 *   npm run build && node scripts/smoke.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, 'tmp', 'smoke.dat');
const ROWS = 120_000;

const schema = {
  version: 1,
  mode: 'fixed',
  encoding: 'latin1',
  lineEnding: 'lf',
  columns: [
    { name: 'CODE', start: 0, length: 12, type: 'string', trim: 'both' },
    { name: 'NAME', start: 12, length: 20, type: 'string', trim: 'both' },
    { name: 'REGION', start: 32, length: 10, type: 'string', trim: 'both' },
    { name: 'AMOUNT', start: 42, length: 14, type: 'decimal', trim: 'both', scale: 2, signed: 'trailing' },
    { name: 'STATUS', start: 56, length: 8, type: 'string', trim: 'both' },
  ],
};

function runWorker(script, workerData, onMessage) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(root, 'dist', 'workers', script), {
      workerData,
      resourceLimits: { maxOldGenerationSizeMb: 192 },
    });
    worker.on('message', (message) => {
      onMessage(message);
      if (message.type === 'done') {
        worker.terminate().then(() => resolve(message), reject);
      } else if (message.type === 'failed') {
        worker.terminate().then(() => reject(new Error(message.message)), reject);
      }
    });
    worker.on('error', reject);
  });
}

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`);
  if (!ok) {
    process.exitCode = 1;
  }
  return ok;
}

async function main() {
  console.log(`Generating ${ROWS.toLocaleString()} rows...`);
  execFileSync(process.execPath, [
    path.join(root, 'scripts', 'make-fixture.mjs'),
    '--rows', String(ROWS), '--out', fixture,
  ], { stdio: 'inherit' });

  const size = statSync(fixture).size;

  // Ground truth: the obvious, slow, obviously-correct implementation.
  const text = readFileSync(fixture, 'latin1');
  const lines = text.split('\n').filter((line) => line.length > 0);
  // AMOUNT is 14 bytes: 13 digits plus a trailing sign position, mainframe style. Reading
  // only the digits would silently treat every negative amount as positive.
  const amountOf = (line) => {
    const digits = Number(line.slice(42, 55));
    return (line[55] === '-' ? -digits : digits) / 100;
  };
  const expectedNorth = lines.filter((line) => line.slice(32, 42).trim() === 'NORTH').length;
  const expectedLarge = lines.filter((line) => amountOf(line) > 500_000).length;

  console.log(`\nFixture: ${(size / 1e6).toFixed(1)} MB, ${lines.length.toLocaleString()} records\n`);

  // --- index worker -------------------------------------------------------
  let indexProgressSeen = 0;
  const indexStarted = Date.now();
  const indexed = await runWorker('indexer.worker.js', {
    kind: 'index',
    path: fixture,
    stride: 4096,
    dataStart: 0,
    fileSize: size,
    chunkBytes: 4 * 1024 * 1024,
  }, (message) => {
    if (message.type === 'checkpoints') indexProgressSeen++;
  });
  const indexMs = Date.now() - indexStarted;

  check('indexer row count', indexed.rows, lines.length);
  console.log(`      indexed in ${indexMs} ms (${(size / 1e6 / (indexMs / 1000)).toFixed(0)} MB/s), ${indexProgressSeen} progress flushes`);

  // --- query worker: string equality on the byte fast path ----------------
  const queryStarted = Date.now();
  let batches = 0;
  const north = await runWorker('query.worker.js', {
    kind: 'query',
    path: fixture,
    schema,
    statement: {
      columns: null,
      where: {
        kind: 'comparison', op: '=',
        left: { kind: 'column', name: 'REGION' },
        right: { kind: 'literal', value: 'NORTH', isString: true },
      },
      orderBy: null, limit: null, offset: 0,
    },
    dataStart: 0,
    fileSize: size,
    recordLength: 0,
    lineEnding: 'lf',
    chunkBytes: 4 * 1024 * 1024,
    maxResults: 2_000_000,
  }, (message) => {
    if (message.type === 'batch') batches++;
  });

  check("query REGION = 'NORTH' match count", north.matched, expectedNorth);
  check('query returned one offset per match', north.offsets.length, expectedNorth);
  console.log(`      scanned in ${north.elapsedMs} ms (${(size / 1e6 / Math.max(1, north.elapsedMs) * 1000).toFixed(0)} MB/s), ${batches} progressive batches`);

  // Offsets must point at real record starts, not at arbitrary bytes.
  const firstOffset = north.offsets[0];
  const atOffset = text.slice(firstOffset, firstOffset + 64);
  check('first result offset lands on a record boundary', atOffset.slice(32, 42).trim(), 'NORTH');
  check('offsets are strictly increasing', north.offsets.every((v, i, a) => i === 0 || v > a[i - 1]), true);

  // --- query worker: numeric comparison with implied scale ---------------
  const large = await runWorker('query.worker.js', {
    kind: 'query',
    path: fixture,
    schema,
    statement: {
      columns: null,
      where: {
        kind: 'comparison', op: '>',
        left: { kind: 'column', name: 'AMOUNT' },
        right: { kind: 'literal', value: 500000, isString: false },
      },
      orderBy: null, limit: null, offset: 0,
    },
    dataStart: 0,
    fileSize: size,
    recordLength: 0,
    lineEnding: 'lf',
    chunkBytes: 4 * 1024 * 1024,
    maxResults: 2_000_000,
  }, () => {});

  check('query AMOUNT > 500000 match count', large.matched, expectedLarge);

  // --- query worker: ORDER BY with LIMIT (top-N path) --------------------
  const top = await runWorker('query.worker.js', {
    kind: 'query',
    path: fixture,
    schema,
    statement: {
      columns: null,
      where: null,
      orderBy: { column: 'AMOUNT', direction: 'desc' },
      limit: 10, offset: 0,
    },
    dataStart: 0,
    fileSize: size,
    recordLength: 0,
    lineEnding: 'lf',
    chunkBytes: 4 * 1024 * 1024,
    maxResults: 2_000_000,
  }, () => {});

  check('top-N returns exactly LIMIT rows', top.offsets.length, 10);

  const amounts = Array.from(top.offsets, (offset) => amountOf(text.slice(offset, offset + 64)));
  const sortedDesc = [...amounts].sort((a, b) => b - a);
  check('top-N rows are in descending order', JSON.stringify(amounts), JSON.stringify(sortedDesc));

  const globalMax = Math.max(...lines.map(amountOf));
  check('top-N first row is the global maximum', amounts[0], globalMax);

  // --- chunk boundary: a tiny chunk forces records to straddle -----------
  let straddledBatches = 0;
  const straddled = await runWorker('query.worker.js', {
    kind: 'query',
    path: fixture,
    schema,
    statement: {
      columns: null,
      where: {
        kind: 'comparison', op: '=',
        left: { kind: 'column', name: 'REGION' },
        right: { kind: 'literal', value: 'NORTH', isString: true },
      },
      orderBy: null, limit: null, offset: 0,
    },
    dataStart: 0,
    fileSize: size,
    recordLength: 0,
    lineEnding: 'lf',
    // 1000 is not a multiple of the 65-byte record, so records straddle every chunk.
    chunkBytes: 1000,
    maxResults: 2_000_000,
  }, (message) => {
    if (message.type === 'batch') straddledBatches++;
  });

  check('same count with records straddling every chunk', straddled.matched, expectedNorth);
  console.log(`      ${straddledBatches} progressive batches emitted during the slow scan`);

  console.log(process.exitCode ? '\nSMOKE TEST FAILED' : '\nAll smoke checks passed.');
}

await main();
