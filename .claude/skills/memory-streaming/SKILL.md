---
name: memory-streaming
description: Skill #1 — Memory Management & Streaming. Use when reading, indexing, or scanning a large file, designing caches and buffers, working with Node.js Streams, Worker Threads, ArrayBuffer/TypedArray, or when investigating memory pressure, backpressure, or a blocked event loop.
---

# Skill #1 — Memory Management & Streaming

Reference: SLOs **P1, P4, P6, P7, P9** in `docs/00-PROJECT-CONTEXT.md`.

## Guiding principle

The file on disk is the source of truth; RAM is only a sliding window onto it. Every time you are
about to hold something in memory, ask: *how large does this get if the file is 50 GB?* If the answer
is anything other than "the same", the design is wrong.

## 1. File access

Two modes, never mixed:

| Mode | When | API |
|---|---|---|
| **Random access** | Serving the viewport, resolving a row id | `FileHandle.read(buffer, off, len, position)` on an fd held open for the session |
| **Sequential scan** | Indexing, full-scan queries, export | `createReadStream({ start, end, highWaterMark })` or positional reads in 1–4 MB blocks |

Rules:
- One `FileHandle` per document, opened in `openCustomDocument` and closed in `dispose`.
- Set `highWaterMark` explicitly (1 MB is typical). The 64 KB default multiplies syscalls by 16×.
- Never `fs.readFile`, never `fs.readFileSync`, never `workspace.fs.readFile` on the input file.
- On Windows: open read-only without an exclusive lock, so third-party writers are not blocked.

## 2. Buffers and ArrayBuffers

- Allocate from a **reusable buffer pool** of fixed-size buffers, not `Buffer.alloc` per request.
  Repeatedly allocating multi-MB buffers is the primary cause of GC pauses in this domain.
- `Buffer.allocUnsafe` is acceptable **only** when the buffer is fully written before any read; every
  such use carries a comment stating that guarantee.
- `subarray()` creates a view, `slice()` copies. Prefer the view, but remember a view **keeps the whole
  backing ArrayBuffer alive**: never retain views over pooled buffers.
- For data headed to the webview, build a dedicated `ArrayBuffer` and **transfer** it. After transfer
  the buffer is neutered on the sender side, so never reuse it.
- Numeric structures are always TypedArrays: `BigUint64Array` for byte offsets (past 4 GB a
  `Uint32Array` silently overflows — the classic mistake), `Uint32Array` for row indices up to 4 billion.

## 3. Page cache

```
PageCache
  pageSize      = 1 MiB               // aligned, power of two
  capacityBytes = 64 MiB              // hard ceiling, not a hint
  eviction      = LRU with an intrusive list (zero allocation per access)
  key           = pageId = byteOffset >>> 20
```

- Lookup is O(1) and allocation-free. A cache that allocates on every hit is a garbage generator.
- Pages in use are pinned during a read, so they cannot be evicted mid-operation.
- On concurrent misses for the same page, perform **one** physical read: deduplicate in-flight
  requests with a `Map<pageId, Promise<Page>>`.
- A record straddling two pages is the first edge case to test.

## 4. Worker threads

- Pool of `min(4, cpus - 1)` workers, created lazily on first task and terminated after idle timeout.
- `new Worker(path, { resourceLimits: { maxOldGenerationSizeMb: 128 } })`: a worker that blows past its
  limit dies on its own instead of taking down the whole VS Code window.
- Task protocol: `{ id, type, payload }` with a correlated response; every task has a timeout and a
  cancellation path. No worker may hang on a catastrophic regex.
- Each worker opens its **own** file descriptor: fds are never shared across threads.
- Results come back as transferred `ArrayBuffer`s via `transferList`, not as cloned objects.
- Avoid shared state. If it is genuinely required, `Atomics` over a `SharedArrayBuffer` between worker
  and host is acceptable for progress counters and cancellation flags only.

## 5. Streaming and backpressure

- Every pipeline uses `stream/promises.pipeline`, never manual `.pipe()`: correct error propagation
  and stream destruction come for free.
- The consumer sets the pace. If the webview has not consumed the previous chunk, do not produce the
  next one: `postMessage` has no backpressure, so flow control is yours to implement, via explicit
  acks or a maximum in-flight chunk window.
- For export: `pipeline(rowIterator, transformToCsv, createWriteStream(dest))`, never an intermediate
  array of rows.
- An async iterator yielding rows must periodically yield control (`await setImmediate()` every N
  records) when it runs in the extension host.

## 6. Sparse index

```
checkpointStride = 4096                // rows between two checkpoints
offsets          = BigUint64Array      // one offset per stride
```

- Resolving row N: read `offsets[floor(N / stride)]`, then count terminators forward for at most
  `stride` rows. Cost is dominated by a single page read.
- Indexing is **incremental and in the background**: navigation works over the already-indexed portion
  while the rest proceeds; total row count is progressive state, not a precondition for opening the file.
- With `lineEnding: "none"` and a fixed `recordLength`, build no index at all: the offset is
  `rowIndex * recordLength`. Detect this case before anything else.
- The index may be persisted under `ExtensionContext.storageUri`, keyed by `(path, size, mtime)`; if
  any of the three changes, the index is invalidated, no debate.

## 7. Diagnostics

- `process.memoryUsage()` sampled into a dedicated output channel, behind a debug setting.
- `perf_hooks.monitorEventLoopDelay()` with a histogram: a p99 above 50 ms means P6 is violated.
- Heap snapshots compared before and after a scroll scenario: growth between two at-rest snapshots must
  be zero. If it grows, find who is retaining views over pooled buffers.
- Mandatory soak test: 10 minutes of continuous scrolling over a 5 GB fixture, with flat RSS.

## Anti-patterns to reject on sight

| Anti-pattern | Why it is fatal |
|---|---|
| `const lines = content.split('\n')` | Materializes the entire file plus an array of millions of strings |
| `Uint32Array` for byte offsets | Silent overflow past 4 GB: data corruption, not a crash |
| An offset entry per row | 8 GB of index for a billion rows: violates P1 and P7 |
| `readline` on the extension host | Blocks the event loop and allocates a string per row |
| A cache with no byte ceiling | The OOM killer will impose the limit for you |
| `await` inside a per-row loop | One promise per row means millions of allocations |
