/**
 * Branded numeric units.
 *
 * Mixing a byte offset with a row index is the signature bug of this domain: both are
 * plain numbers, both are large, and the mistake surfaces as silently wrong data rather
 * than as a crash. Branding them makes the compiler reject the confusion at the few
 * boundaries where the two actually meet (index lookup, page reads, IPC ranges).
 *
 * Arithmetic on a branded value yields a plain `number`, so re-brand explicitly at the
 * point where the result regains its meaning.
 */

declare const byteOffsetBrand: unique symbol;
declare const rowIndexBrand: unique symbol;

export type ByteOffset = number & { readonly [byteOffsetBrand]: true };
export type RowIndex = number & { readonly [rowIndexBrand]: true };

export function asByteOffset(value: number): ByteOffset {
  return value as ByteOffset;
}

export function asRowIndex(value: number): RowIndex {
  return value as RowIndex;
}

/**
 * Offsets are held in Float64Array rather than BigUint64Array throughout the codebase.
 *
 * A double represents every integer up to 2^53 exactly, which covers 9 petabytes of file:
 * far beyond anything we will open, and far beyond the 4 GB where Uint32Array silently
 * overflows. Float64Array avoids BigInt boxing in the scan loops, which measurably
 * dominates when you touch one offset per row across a billion rows.
 */
export const MAX_SAFE_FILE_SIZE = Number.MAX_SAFE_INTEGER;
