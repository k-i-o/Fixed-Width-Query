/**
 * SLO measurement at scale.
 *
 *   npm run perf                      # 500 MB, the smallest size that says anything
 *   npm run perf -- --gb 5            # the size the context document benchmarks against
 *   npm run perf -- --gb 5 --keep     # keep the fixture for repeat runs
 *   npm run perf -- --mode fixed-length
 *
 * Generating the fixture is most of the wall time. `--keep` plus `--reuse` turns a 5 GB run
 * into a fast loop while you are actually optimizing something.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const gb = Number(arg('gb', '0.5'));
const mode = arg('mode', 'delimited'); // delimited | fixed-length
const keep = flag('keep');
const reuse = flag('reuse');

// The generator writes 64 bytes of content per record, plus a terminator unless fixed-length.
const RECORD_BYTES = mode === 'fixed-length' ? 64 : 65;
const rows = Math.floor((gb * 1024 * 1024 * 1024) / RECORD_BYTES);
const fixture = path.join(root, 'tmp', `perf-${mode}-${gb}gb.dat`);

function run(command, commandArgs) {
  execFileSync(command, commandArgs, { stdio: 'inherit', cwd: root });
}

console.log('Building extension bundles and probe...');
run(process.execPath, ['esbuild.mjs']);
run(process.execPath, ['esbuild.mjs', '--probe']);

if (reuse && existsSync(fixture)) {
  console.log(`Reusing ${fixture} (${(statSync(fixture).size / 1e9).toFixed(2)} GB)`);
} else {
  console.log(`\nGenerating ${rows.toLocaleString()} rows (~${gb} GB). This is the slow part.`);
  const started = Date.now();
  run(process.execPath, [
    path.join(root, 'scripts', 'make-fixture.mjs'),
    '--rows', String(rows),
    '--out', fixture,
    '--mode', mode,
  ]);
  console.log(`Generated in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

console.log('\nMeasuring...');
let failed = false;
try {
  run(process.execPath, [
    // Lets the probe separate memory actually held from garbage awaiting collection.
    '--expose-gc',
    path.join(root, 'tmp', 'probe.js'),
    '--file', fixture,
    '--worker-dir', path.join(root, 'dist', 'workers'),
    '--mode', mode,
    // Only meaningful in fixed-length mode; the delimited schema ignores it.
    '--record-length', String(RECORD_BYTES),
    '--fetches', arg('fetches', '400'),
  ]);
} catch {
  // The probe sets a non-zero exit code when a gated SLO is missed; it has already
  // printed which one. Rethrowing the raw spawn error would bury that.
  failed = true;
}

if (!keep && !reuse) {
  rmSync(fixture, { force: true });
  console.log(`\nRemoved ${path.basename(fixture)} (pass --keep to retain it).`);
}

process.exitCode = failed ? 1 : 0;
