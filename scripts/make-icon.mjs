/**
 * Renders media/icon.png (128x128) from scratch.
 *
 * The Marketplace requires a PNG and rejects SVG, and this machine has no image toolchain —
 * `convert` here is the Windows filesystem utility, not ImageMagick. Rather than add a
 * dependency to a project that deliberately has none, this draws the icon as pixels and
 * encodes a PNG with the zlib that ships with Node.
 *
 *   node scripts/make-icon.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SIZE = 128;
/** Supersampling factor: draw big, average down, so the rounded corners are not jagged. */
const SS = 4;
const BIG = SIZE * SS;

const BG = [0x1f, 0x24, 0x30];
const COL1 = [0x4f, 0xc1, 0xe9];
const COL2 = [0x8e, 0x9b, 0xb3];
const COL3 = [0x58, 0x61, 0x72];
const CUT = [0xf6, 0xb9, 0x3b];

const big = new Uint8Array(BIG * BIG * 4); // RGBA, transparent by default

function fillRect(x, y, w, h, [r, g, b], alpha = 255) {
  const x0 = Math.round(x * SS);
  const y0 = Math.round(y * SS);
  const x1 = Math.round((x + w) * SS);
  const y1 = Math.round((y + h) * SS);
  for (let py = Math.max(0, y0); py < Math.min(BIG, y1); py++) {
    for (let px = Math.max(0, x0); px < Math.min(BIG, x1); px++) {
      const i = (py * BIG + px) * 4;
      big[i] = r;
      big[i + 1] = g;
      big[i + 2] = b;
      big[i + 3] = alpha;
    }
  }
}

/** Background plate with rounded corners, drawn by a per-pixel radius test. */
function roundedBackground(radius, [r, g, b]) {
  const rad = radius * SS;
  for (let py = 0; py < BIG; py++) {
    for (let px = 0; px < BIG; px++) {
      // Distance from the nearest corner centre, only inside the corner squares.
      const cx = px < rad ? rad : px >= BIG - rad ? BIG - rad - 1 : px;
      const cy = py < rad ? rad : py >= BIG - rad ? BIG - rad - 1 : py;
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy > rad * rad) {
        continue; // outside the rounded corner: stays transparent
      }
      const i = (py * BIG + px) * 4;
      big[i] = r;
      big[i + 1] = g;
      big[i + 2] = b;
      big[i + 3] = 255;
    }
  }
}

// --- the drawing -------------------------------------------------------------
// Three columns of fixed-width fields, with the cut lines that define them.
roundedBackground(24, BG);

const rows = [30, 46, 62, 78, 94];
for (const y of rows) {
  fillRect(22, y, 26, 8, COL1);
  fillRect(56, y, 18, 8, COL2);
  fillRect(82, y, 24, 8, COL3);
}
// The column boundaries: the one idea the whole format is about.
fillRect(52, 22, 2, 88, CUT);
fillRect(78, 22, 2, 88, CUT);

// --- downsample --------------------------------------------------------------
const out = new Uint8Array(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * BIG + (x * SS + sx)) * 4;
        const alpha = big[i + 3];
        // Weight colour by alpha so transparent pixels do not darken the edges.
        r += big[i] * alpha;
        g += big[i + 1] * alpha;
        b += big[i + 2] * alpha;
        a += alpha;
      }
    }
    const o = (y * SIZE + x) * 4;
    if (a === 0) {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    } else {
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(a / (SS * SS));
    }
  }
}

// --- PNG encoding ------------------------------------------------------------

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

// Every scanline is prefixed with its filter type; 0 (none) is plenty for flat colour.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(out.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const target = path.join(root, 'media', 'icon.png');
writeFileSync(target, png);
console.log(`Wrote ${target} — ${SIZE}x${SIZE}, ${png.length} bytes`);
