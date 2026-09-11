/**
 * Byte-to-text decoding, and numeric parsing straight from bytes.
 *
 * Nothing here imports Buffer: `core/` stays isomorphic so the same code is exercised by
 * Vitest, by the worker threads, and (for the numeric helpers) by the webview.
 */

import type { Encoding, TrimMode } from '../../shared/schema.js';

export type Decoder = (bytes: Uint8Array, start: number, end: number) => string;

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * latin1 is decoded by hand rather than through TextDecoder.
 *
 * TextDecoder('latin1') is an alias for windows-1252, which differs from true ISO-8859-1
 * in the 0x80-0x9F range — exactly where mainframe extracts park control characters. A
 * byte-to-code-point loop is both correct and faster for the short slices we decode.
 */
function decodeLatin1(bytes: Uint8Array, start: number, end: number): string {
  const length = end - start;
  if (length <= 0) {
    return '';
  }
  // fromCharCode.apply beats a += loop by a wide margin, but blows the argument limit on
  // long inputs, so chunk it. Cells are short; the chunking is for pathological records.
  if (length <= 4096) {
    return String.fromCharCode.apply(null, bytes.subarray(start, end) as unknown as number[]);
  }
  let out = '';
  for (let i = start; i < end; i += 4096) {
    const stop = Math.min(i + 4096, end);
    out += String.fromCharCode.apply(null, bytes.subarray(i, stop) as unknown as number[]);
  }
  return out;
}

export function makeDecoder(encoding: Encoding): Decoder {
  if (encoding === 'utf8') {
    return (bytes, start, end) => (end > start ? utf8Decoder.decode(bytes.subarray(start, end)) : '');
  }
  // ascii is latin1 with the high bit unused; the same loop handles both.
  return decodeLatin1;
}

const SPACE = 0x20;
const TAB = 0x09;
const NUL = 0x00;

function isBlankByte(byte: number): boolean {
  return byte === SPACE || byte === TAB || byte === NUL;
}

/** Trim on the byte range, before decoding, so we never allocate the untrimmed string. */
export function trimRange(
  bytes: Uint8Array,
  start: number,
  end: number,
  mode: TrimMode,
): { start: number; end: number } {
  let s = start;
  let e = end;
  if (mode === 'left' || mode === 'both') {
    while (s < e && isBlankByte(bytes[s] ?? 0)) {
      s++;
    }
  }
  if (mode === 'right' || mode === 'both') {
    while (e > s && isBlankByte(bytes[e - 1] ?? 0)) {
      e--;
    }
  }
  return { start: s, end: e };
}

export function isBlankRange(bytes: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (!isBlankByte(bytes[i] ?? 0)) {
      return false;
    }
  }
  return true;
}

const ZERO = 0x30;
const NINE = 0x39;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const COMMA = 0x2c;

export interface NumericOptions {
  readonly scale?: number | undefined;
  readonly signed?: 'none' | 'leading' | 'trailing' | undefined;
}

/**
 * Parse a number directly from bytes into an integer accumulator.
 *
 * Going through a string plus parseFloat costs an allocation and a full re-scan per value;
 * at one value per row across a multi-GB scan that difference is the whole performance
 * budget. Returns NaN for anything that is not a clean number, which every comparison
 * predicate then treats as "no match".
 */
export function parseNumericBytes(
  bytes: Uint8Array,
  start: number,
  end: number,
  options: NumericOptions = {},
): number {
  let s = start;
  let e = end;
  while (s < e && isBlankByte(bytes[s] ?? 0)) {
    s++;
  }
  while (e > s && isBlankByte(bytes[e - 1] ?? 0)) {
    e--;
  }
  if (s >= e) {
    return Number.NaN;
  }

  let negative = false;
  const first = bytes[s] ?? 0;
  if (first === MINUS) {
    negative = true;
    s++;
  } else if (first === PLUS) {
    s++;
  }

  // Mainframe convention: the sign trails the digits ("00123-").
  if (options.signed === 'trailing' || options.signed === undefined) {
    const last = bytes[e - 1] ?? 0;
    if (last === MINUS) {
      negative = true;
      e--;
    } else if (last === PLUS) {
      e--;
    }
  }

  let intPart = 0;
  let fracPart = 0;
  let fracDigits = 0;
  let sawDot = false;
  let sawDigit = false;

  for (let i = s; i < e; i++) {
    const byte = bytes[i] ?? 0;
    if (byte >= ZERO && byte <= NINE) {
      sawDigit = true;
      if (sawDot) {
        fracPart = fracPart * 10 + (byte - ZERO);
        fracDigits++;
      } else {
        intPart = intPart * 10 + (byte - ZERO);
      }
      continue;
    }
    if ((byte === DOT || byte === COMMA) && !sawDot) {
      sawDot = true;
      continue;
    }
    // Anything else means this field is not a number.
    return Number.NaN;
  }

  if (!sawDigit) {
    return Number.NaN;
  }

  let value = sawDot ? intPart + fracPart / Math.pow(10, fracDigits) : intPart;

  // An implied scale means the stored digits carry no decimal point: 12345 with scale 2
  // is 123.45. Only applies when the field did not spell the point out itself.
  if (!sawDot && options.scale && options.scale > 0) {
    value = value / Math.pow(10, options.scale);
  }

  return negative ? -value : value;
}

/** SQL LIKE, translated once into a RegExp. `%` is any run, `_` is one character. */
export function likeToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === '%') {
      source += '[\\s\\S]*';
    } else if (char === '_') {
      source += '[\\s\\S]';
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  source += '$';
  return new RegExp(source, caseInsensitive ? 'i' : '');
}
