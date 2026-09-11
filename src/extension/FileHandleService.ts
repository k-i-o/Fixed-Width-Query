/**
 * Positional file reads behind a page cache with a hard byte ceiling.
 *
 * This is the only place in the extension that touches file content. Everything above it
 * asks for a byte range and gets one; nothing above it knows or cares whether the bytes
 * came from the cache or the disk. The ceiling is what makes P1 hold: a 50 GB file and a
 * 50 MB file produce exactly the same cache footprint.
 */

import { promises as fs, type Stats } from 'node:fs';

interface CachedPage {
  readonly bytes: Uint8Array;
  /** Pinned pages are mid-read and must survive eviction. */
  pins: number;
}

export interface FileStamp {
  readonly size: number;
  readonly mtimeMs: number;
}

export class FileHandleService {
  private handle: fs.FileHandle | null = null;
  private stamp: FileStamp = { size: 0, mtimeMs: 0 };

  /** Insertion order is the LRU order; Map guarantees it, so no separate list is needed. */
  private readonly pages = new Map<number, CachedPage>();
  private readonly inFlight = new Map<number, Promise<CachedPage>>();
  private cachedBytes = 0;
  private disposed = false;

  constructor(
    private readonly path: string,
    private readonly pageSize: number,
    private readonly capacityBytes: number,
  ) {}

  async open(): Promise<FileStamp> {
    // Read-only, no exclusive lock: another process must stay free to append to this file.
    this.handle = await fs.open(this.path, 'r');
    const stats: Stats = await this.handle.stat();
    this.stamp = { size: stats.size, mtimeMs: stats.mtimeMs };
    return this.stamp;
  }

  get size(): number {
    return this.stamp.size;
  }

  get fileStamp(): FileStamp {
    return this.stamp;
  }

  get cacheBytes(): number {
    return this.cachedBytes;
  }

  /** Diagnostics for the performance probe: what the cache actually holds. */
  get cacheStats(): { pages: number; trackedBytes: number; backingBytes: number } {
    let backingBytes = 0;
    for (const page of this.pages.values()) {
      // What the cache *costs* is the backing ArrayBuffer, not the view's length.
      backingBytes += page.bytes.buffer.byteLength;
    }
    return { pages: this.pages.size, trackedBytes: this.cachedBytes, backingBytes };
  }

  /** Detect external modification. Serving rows from a stale index corrupts what the user sees. */
  async hasChangedOnDisk(): Promise<boolean> {
    try {
      const stats = await fs.stat(this.path);
      return stats.size !== this.stamp.size || stats.mtimeMs !== this.stamp.mtimeMs;
    } catch {
      return true;
    }
  }

  private evictIfNeeded(): void {
    // Oldest first. A pinned page is skipped rather than dropped mid-read.
    for (const [id, page] of this.pages) {
      if (this.cachedBytes <= this.capacityBytes) {
        return;
      }
      if (page.pins > 0) {
        continue;
      }
      this.pages.delete(id);
      this.cachedBytes -= page.bytes.byteLength;
    }
  }

  private async loadPage(pageId: number): Promise<CachedPage> {
    const cached = this.pages.get(pageId);
    if (cached) {
      // Refresh recency: delete + set moves the entry to the end of the iteration order.
      this.pages.delete(pageId);
      this.pages.set(pageId, cached);
      return cached;
    }

    // Concurrent misses on the same page must produce exactly one physical read.
    const pending = this.inFlight.get(pageId);
    if (pending) {
      return pending;
    }

    const promise = (async (): Promise<CachedPage> => {
      const handle = this.requireHandle();
      const start = pageId * this.pageSize;
      const length = Math.min(this.pageSize, Math.max(0, this.stamp.size - start));
      const buffer = new Uint8Array(length);
      if (length > 0) {
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        if (bytesRead < length) {
          return { bytes: buffer.subarray(0, bytesRead), pins: 0 };
        }
      }
      return { bytes: buffer, pins: 0 };
    })();

    this.inFlight.set(pageId, promise);
    try {
      const page = await promise;
      if (!this.disposed) {
        this.pages.set(pageId, page);
        this.cachedBytes += page.bytes.byteLength;
        this.evictIfNeeded();
      }
      return page;
    } finally {
      this.inFlight.delete(pageId);
    }
  }

  private requireHandle(): fs.FileHandle {
    if (!this.handle || this.disposed) {
      throw new Error('File handle is closed.');
    }
    return this.handle;
  }

  /**
   * Read `length` bytes from `offset`, clamped to EOF.
   *
   * Requests spanning more than a few pages bypass the cache entirely: a sequential export
   * or a large block read would otherwise flush every page the viewport is using, which is
   * the classic way a cache makes an application slower than no cache at all.
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (this.disposed) {
      return new Uint8Array(0);
    }
    const clampedOffset = Math.max(0, Math.min(offset, this.stamp.size));
    const clampedLength = Math.max(0, Math.min(length, this.stamp.size - clampedOffset));
    if (clampedLength === 0) {
      return new Uint8Array(0);
    }

    const firstPage = Math.floor(clampedOffset / this.pageSize);
    const lastPage = Math.floor((clampedOffset + clampedLength - 1) / this.pageSize);
    const pageSpan = lastPage - firstPage + 1;

    if (pageSpan > 4) {
      const buffer = new Uint8Array(clampedLength);
      const { bytesRead } = await this.requireHandle().read(buffer, 0, clampedLength, clampedOffset);
      return buffer.subarray(0, bytesRead);
    }

    if (pageSpan === 1) {
      const page = await this.loadPage(firstPage);
      const start = clampedOffset - firstPage * this.pageSize;
      // A view, not a copy: the caller must not retain it past the current operation.
      return page.bytes.subarray(start, Math.min(start + clampedLength, page.bytes.length));
    }

    // Spanning pages: pin each while assembling, so eviction cannot pull one out mid-copy.
    const loaded: CachedPage[] = [];
    try {
      for (let id = firstPage; id <= lastPage; id++) {
        const page = await this.loadPage(id);
        page.pins++;
        loaded.push(page);
      }
      const result = new Uint8Array(clampedLength);
      let written = 0;
      for (let id = firstPage; id <= lastPage; id++) {
        const page = loaded[id - firstPage] as CachedPage;
        const pageStart = id * this.pageSize;
        const copyFrom = Math.max(0, clampedOffset - pageStart);
        const copyTo = Math.min(page.bytes.length, clampedOffset + clampedLength - pageStart);
        if (copyTo > copyFrom) {
          result.set(page.bytes.subarray(copyFrom, copyTo), written);
          written += copyTo - copyFrom;
        }
      }
      return result.subarray(0, written);
    } finally {
      for (const page of loaded) {
        page.pins--;
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pages.clear();
    this.cachedBytes = 0;
    const handle = this.handle;
    this.handle = null;
    if (handle) {
      // Swallowing here is deliberate: a failing close on teardown must not mask the
      // error that caused the teardown.
      await handle.close().catch(() => undefined);
    }
  }
}
