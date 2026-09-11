/**
 * Deterministic fixture generator.
 *
 * Large fixtures are generated, never committed: a 5 GB file does not belong in git, and a
 * seeded generator reproduces the exact same bytes on any machine, which is what makes a
 * performance regression comparable across runs.
 *
 *   node scripts/make-fixture.mjs --rows 2000000 --out tmp/sample.dat
 *   node scripts/make-fixture.mjs --rows 1000 --mode fixed-length --out tmp/blocked.dat
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const rows = Number(arg('rows', '100000'));
const out = arg('out', 'tmp/sample.dat');
const mode = arg('mode', 'delimited'); // delimited | fixed-length
const seed = Number(arg('seed', '42'));

/** xorshift32: tiny, deterministic, and identical across Node versions. */
function makeRandom(state) {
  let value = state || 1;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0xffffffff;
  };
}

const random = makeRandom(seed);
const REGIONS = ['NORTH', 'SOUTH', 'EAST', 'WEST', 'CENTRAL'];
const STATUSES = ['OPEN', 'CLOSED', 'PENDING', 'REVIEW'];

function pad(value, width, align = 'left') {
  const text = String(value).slice(0, width);
  return align === 'left' ? text.padEnd(width, ' ') : text.padStart(width, ' ');
}

/**
 * Record layout (widths 12, 20, 10, 14, 8 = 64 bytes of content):
 *   CODE     12  e.g. "C5-0000012345"
 *   NAME     20
 *   REGION   10
 *   AMOUNT   14  right aligned, two implied decimals, occasional trailing minus
 *   STATUS    8
 */
function makeRecord(index) {
  const code = pad(`C${(index % 9) + 1}-${String(index).padStart(8, '0')}`, 12);
  const name = pad(`ACCOUNT ${Math.floor(random() * 999999)}`, 20);
  const region = pad(REGIONS[Math.floor(random() * REGIONS.length)], 10);
  const cents = Math.floor(random() * 100000000);
  const negative = random() < 0.08;
  const amount = pad(`${String(cents).padStart(13, '0')}${negative ? '-' : ' '}`, 14, 'right');
  const status = pad(STATUSES[Math.floor(random() * STATUSES.length)], 8);
  return `${code}${name}${region}${amount}${status}`;
}

async function main() {
  await mkdir(path.dirname(out), { recursive: true });
  const stream = createWriteStream(out);
  const terminator = mode === 'fixed-length' ? '' : '\n';

  let buffer = '';
  for (let i = 0; i < rows; i++) {
    buffer += makeRecord(i) + terminator;
    // Backpressure: wait for the drain instead of buffering the whole file in memory.
    if (buffer.length >= 1 << 20) {
      if (!stream.write(buffer)) {
        await new Promise((resolve) => stream.once('drain', resolve));
      }
      buffer = '';
    }
  }
  if (buffer) {
    stream.write(buffer);
  }
  await new Promise((resolve) => stream.end(resolve));

  const recordBytes = 64 + terminator.length;
  console.log(`Wrote ${rows.toLocaleString()} rows to ${out} (${(rows * recordBytes / 1e6).toFixed(1)} MB, mode=${mode})`);
  if (mode === 'fixed-length') {
    console.log('Use lineEnding "none" with recordLength 64 — that file needs no index at all.');
  }
}

await main();
