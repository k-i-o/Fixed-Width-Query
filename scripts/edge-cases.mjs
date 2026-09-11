/**
 * Generates the corpus of files that break naive implementations.
 *
 *   npm run edge-cases          # writes tmp/edge/
 *
 * Every file here corresponds to a way real data misbehaves. Manual testing against a clean
 * generated fixture proves almost nothing: fixtures are uniform, and production files are
 * not. Open each of these in the extension and confirm it degrades honestly — a clear
 * message, or correct data — rather than showing something plausible and wrong.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'tmp', 'edge');
mkdirSync(out, { recursive: true });

const cases = [];

function write(name, contents, expectation, encoding = 'latin1') {
  const file = path.join(out, name);
  writeFileSync(file, contents, typeof contents === 'string' ? encoding : undefined);
  cases.push({ name, expectation });
}

const record = (code, amount, status) =>
  `${code.padEnd(12)}${String(amount).padStart(13, '0')} ${status.padEnd(8)}`;

// --- framing -----------------------------------------------------------------

write('empty.dat', '', 'Opens, shows 0 rows, no error dialog, no spinner stuck on.');

write('single-no-terminator.dat', record('C1-1', 100, 'OPEN'),
  'Exactly 1 row. A file with no trailing newline must not lose its only record.');

write('no-trailing-newline.dat',
  [record('C1-1', 100, 'OPEN'), record('C1-2', 200, 'SHUT'), record('C1-3', 300, 'OPEN')].join('\n'),
  'Exactly 3 rows. The last one has no terminator and is the one implementations drop.');

write('crlf.dat',
  [record('C1-1', 100, 'OPEN'), record('C1-2', 200, 'SHUT')].join('\r\n') + '\r\n',
  'No stray CR at the end of the last column of every row.');

write('mixed-terminators.dat',
  `${record('C1-1', 100, 'OPEN')}\r\n${record('C1-2', 200, 'SHUT')}\n${record('C1-3', 300, 'OPEN')}\r\n`,
  '3 clean rows. Mixed CRLF and LF in one file happens whenever two systems append to it.');

write('bom.dat', '﻿' + [record('C1-1', 100, 'OPEN'), record('C1-2', 200, 'SHUT')].join('\n') + '\n',
  'First column of row 1 is "C1-1", not "\\ufeffC1-1".', 'utf8');

write('blank-lines.dat',
  `${record('C1-1', 100, 'OPEN')}\n\n${record('C1-2', 200, 'SHUT')}\n\n\n`,
  'Blank lines appear as empty rows and are counted; they are not silently skipped.');

// --- record shape ------------------------------------------------------------

write('short-records.dat',
  ['C1-1', record('C1-2', 200, 'SHUT'), 'C1-3   00001'].join('\n') + '\n',
  'Truncated records yield empty trailing cells, never garbage from the next row.');

write('long-line.dat',
  `${record('C1-1', 100, 'OPEN')}\n${'X'.repeat(5 * 1024 * 1024)}\n${record('C1-2', 200, 'SHUT')}\n`,
  'A 5 MB single line must not hang the UI or truncate the rows after it.');

write('many-columns.dat',
  Array.from({ length: 50 }, (_, row) =>
    Array.from({ length: 200 }, (_, col) => `r${row}c${col}`.padEnd(10)).join('')).join('\n') + '\n',
  '200 columns: horizontal virtualization, no per-frame cost for off-screen columns.');

write('wide-and-tall.dat',
  Array.from({ length: 5000 }, (_, row) =>
    Array.from({ length: 60 }, (_, col) => `r${row}c${col}`.padEnd(12)).join('')).join('\n') + '\n',
  'Scroll both axes at once and confirm the header stays aligned with the columns.');

// --- content ------------------------------------------------------------------

write('html-injection.dat',
  ['<script>alert(1)</script>'.padEnd(40) + 'OPEN    ',
   '<img src=x onerror=alert(2)>'.padEnd(40) + 'SHUT    ',
   '${constructor.constructor("alert(3)")()}'.padEnd(40) + 'OPEN    '].join('\n') + '\n',
  'MUST render as literal text. If any dialog appears, the CSP or textContent rule is broken.');

write('high-bytes.dat',
  Buffer.from([
    ...Buffer.from('CAFE'), 0xe9, 0xe8, 0xfc, 0x20, 0x85, 0x93, 0x0a,
    ...Buffer.from('TEST'), 0x00, 0x01, 0x1f, 0x7f, 0xff, 0xfe, 0x0a,
  ]),
  'latin1 bytes 0x80-0x9F and control characters render without crashing or mojibake.');

write('utf8-multibyte.dat',
  ['CAFFÈ       ' + '000000012345 ' + 'APERTO  ',
   '日本語テキスト   ' + '000000067890 ' + 'CHIUSO  ',
   'emoji 🚀🚀   ' + '000000011111 ' + 'APERTO  '].join('\n') + '\n',
  'Set encoding to utf8. Note fixed-width offsets are BYTES, so columns shift — that is documented, not a bug.',
  'utf8');

write('signed-amounts.dat',
  ['C1-1        000000012345-OPEN    ',
   'C1-2        000000012345 SHUT    ',
   'C1-3        00000000000 -OPEN    ',
   'C1-4        000000000000 OPEN    '].join('\n') + '\n',
  'With scale 2 and trailing sign: -123.45, 123.45, 0 (or blank), 0. Query AMOUNT < 0 must find row 1 only.');

write('numeric-traps.dat',
  ['C1-1        00000000001E5 OPEN   ',
   'C1-2        ............. OPEN   ',
   'C1-3        000000000,123 OPEN   ',
   'C1-4        999999999999  OPEN   '].join('\n') + '\n',
  'Non-numeric fields must match NO numeric comparison — not sort as 0, not throw.');

write('ragged-whitespace.dat',
  ['alpha   beta\tgamma  delta',
   'alpha      beta   gamma delta',
   'alpha\t\tbeta\tgamma\t\tdelta'].join('\n') + '\n',
  'Regex mode with \\s{2,}: rows split into a DIFFERENT number of columns. Check nothing is dropped.');

// --- schema / query -----------------------------------------------------------

write('fixed-length-no-terminator.dat',
  Array.from({ length: 1000 }, (_, i) => record(`C1-${i}`, i * 100, i % 2 ? 'OPEN' : 'SHUT')).join(''),
  'Set lineEnding "none" + recordLength 34. Should open instantly with NO indexing pass at all.');

write('looks-binary.dat',
  Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7 + 13) % 256)),
  'Random bytes with no terminators. Must not hang: it is one enormous "line".');

writeFileSync(
  path.join(out, 'README.md'),
  ['# Edge-case corpus',
   '',
   'Generated by `npm run edge-cases`. Open each in the extension and check the expectation.',
   'A failure here is a bug; "it looked fine" is not a result — read the actual cell values.',
   '',
   ...cases.map((c) => `## ${c.name}\n\n${c.expectation}\n`),
  ].join('\n'),
  'utf8',
);

console.log(`Wrote ${cases.length} edge-case files to ${path.relative(root, out)}/`);
console.log('Expectations are in tmp/edge/README.md — check each one, do not eyeball it.');
