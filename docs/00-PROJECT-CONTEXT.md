# Fixed-Width Query — Project Context Document

> Authoritative context document. Every subsequent technical decision must be consistent with this
> file, or must change it explicitly with the rationale recorded in `docs/adr/`.
> Last updated: 2026-09-11 · Owner: Principal Architect

---

## 1. Goal

A VS Code extension to **open, navigate, filter, and query large tabular text files (from 100 MB to
tens of GB)** whose schema is defined by either:

- **Fixed-Width** — each field occupies a fixed byte range: COBOL copybooks, banking and insurance
  record layouts, mainframe extracts, legacy reports.
- **Regex-split** — each line is decomposed into columns through a regex with capture groups:
  application logs, semi-structured formats, irregular delimiters.

The extension exists because **VS Code alone cannot open these files**: the native text editor refuses
or degrades past ~50 MB, because it materializes the entire `TextDocument` in memory.

### 1.1 Target capabilities (v1)

| # | Capability | Description |
|---|---|---|
| C1 | Instant open | The file opens without being read in full: header plus progressive index only |
| C2 | Virtualized grid | Smooth scrolling across 1,000,000+ rows, with direct jump to row N |
| C3 | Schema editor | Column definition (offset/length/type) or regex, saveable as a `.fwq.json` profile |
| C4 | SQL-like query | `SELECT … WHERE … ORDER BY … LIMIT` over schema columns, executed in streaming |
| C5 | Incremental filters | Per-column filters in the UI, composable into a pipeline, with progressive match count |
| C6 | Export | Result export to CSV/JSONL **in streaming**, with no materialization |

### 1.2 Non-goals (v1, explicitly out of scope)

- Editing or writing the source file. The editor is **read-only**.
- Joins across multiple files, complex analytical aggregations, window functions.
- Native EBCDIC support (deferred to v2, through a pluggable transcoding layer).
- Remote or virtual file systems. v1 supports the `file://` scheme only.

---

## 2. Tech Stack

### 2.1 Decisions

| Layer | Choice | Rationale |
|---|---|---|
| Language | **TypeScript 5.x** with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` | An offset mistake in a binary parser is a silent bug: the compiler is the first test |
| Host runtime | **Node.js** (desktop extension host) | We need `fs.createReadStream`, `worker_threads`, positional `read()`. v1 does **not** support vscode.dev / web |
| VS Code editor | **`CustomReadonlyEditorProvider`** with a `WebviewPanel` | Critical constraint: `CustomTextEditorProvider` hands over a `TextDocument`, loading the whole file into RAM — unacceptable. The *readonly* custom editor receives only the URI and leaves I/O control to us |
| I/O | `fs.promises.open` with `read(buffer, off, len, position)` for random access, `createReadStream` for sequential scans | Positional reads on an already-open fd are the minimum cost per page fault |
| Parallelism | **`worker_threads`**, pool sized at `min(4, cpus - 1)` | Indexing and querying are CPU/IO-bound and must stay outside the extension host, whose stall freezes **the entire** VS Code window |
| Data transport | `postMessage` with **`ArrayBuffer` / TypedArray** — VS Code serializes these natively rather than as JSON (it accepts no transfer list, so one copy, not zero) | `JSON.stringify` over 10,000 rows is the number-one bottleneck in this class of application |
| Webview UI | **Vanilla TypeScript**, zero runtime dependencies *(revised — see [ADR-001](adr/ADR-001-editor-api-and-virtualizer.md))* | The grid is one recycling virtualizer, not an application tree; no framework earned its place. Originally Svelte 5, itself chosen over React to avoid reconciliation cost on the scroll path |
| Virtualization | **Purpose-built**, ~120 lines *(revised — see [ADR-001](adr/ADR-001-editor-api-and-virtualizer.md))* | TanStack Virtual does not address the browser's ~33.5M px height cap, which we cross at ~1.5M rows — and owning the scroll-to-row mapping is most of what a virtualizer is |
| Bundler | **esbuild**, two distinct targets (extension CJS/Node, webview ESM/browser) | Sub-second builds, a watch mode that is actually usable |
| Testing | **Vitest** over `src/core/**` (pure, no VS Code dependency); `@vscode/test-electron` for integration; procedurally generated fixtures | 90% of the critical logic must be testable without launching VS Code |
| Linting | ESLint flat config with type-aware `@typescript-eslint` | Custom rules forbidding cross-layer imports (§4.2) |

### 2.2 Evaluated and rejected

- **DuckDB-WASM / SQLite** — would require full ingestion of the file, with a disk copy and load time
  proportional to size. This contradicts C1. Worth revisiting in v2 as an *optional backend* for heavy
  analytical queries over already-indexed files.
- **Apache Arrow** — conceptual overhead not justified until columnar aggregations are needed.
- **SharedArrayBuffer** — requires cross-origin isolation, which is not guaranteed in the webview
  context. We pass a single packed `ArrayBuffer` instead. Worker-to-host messages *are* zero-copy
  (`worker.postMessage` takes a transfer list); host-to-webview costs one copy, which is not where
  the bottleneck was.

---

## 3. Performance constraints (non-negotiable SLOs)

These numbers are **acceptance criteria**, not aspirations. A change that violates one is rejected, or
comes with an explicit revision of this document.

| ID | Constraint | Target | How it is measured |
|---|---|---|---|
| **P1** | Extension resident memory | **< 200 MB RSS**, constant and independent of file size: 1 GB and 50 GB must show the same profile | `process.memoryUsage().rss` sampled over a 10-minute scroll scenario |
| **P2** | Viewport chunk latency | **< 1 s** at p99, with p50 under 120 ms | Timestamp from request to render commit, via `performance.mark` |
| **P3** | Time-to-first-row | **< 500 ms** from open, regardless of file size | From `openCustomDocument` to the first painted row |
| **P4** | Indexing throughput | **≥ 300 MB/s** per core on NVMe SSD; the index is incremental and does **not** block navigation | Bytes scanned over elapsed time, isolated worker |
| **P5** | Scroll frame rate | **≥ 55 fps** sustained (16 ms frame budget) across 1M+ rows | `requestAnimationFrame` deltas, long-task observer |
| **P6** | Extension host event loop | **No task over 50 ms** | `perf_hooks.monitorEventLoopDelay`, threshold enforced in CI |
| **P7** | Index cost | **≤ 8 MB** for one billion rows | Sparse index: one offset every 4096 rows in a `Float64Array`; intermediate rows resolved by a local scan of at most 4096 rows |
| **P8** | Full-scan query | **≥ 200 MB/s** per worker, with **progressive** results: first matches visible before completion | Benchmark against a 5 GB fixture |
| **P9** | Cancellation | Every operation (index, query, fetch) is cancellable and **releases memory within 100 ms** | Stress test: 100 queries launched and cancelled in sequence |

### 3.1 Meeting P1 — memory budget breakdown

Every component gets a **hard** ceiling, not a guideline:

| Component | Budget | Strategy |
|---|---|---|
| Sparse row index | ≤ 8 MB | `Float64Array`, checkpoint every 4096 rows — exact to 2^53, no BigInt cost in scan loops ([ADR-001](adr/ADR-001-editor-api-and-virtualizer.md)) |
| Raw byte page cache | ≤ 64 MB | LRU over 1 MB pages, deterministic eviction |
| Decoded rows (viewport plus overscan) | ≤ 16 MB | Roughly 3× the viewport; nothing is retained beyond that |
| Query results | ≤ 32 MB | Only **byte offsets and row ids** are materialized (`Float64Array`), never rows |
| Runtime, workers, webview | ≤ 80 MB | Bounded pool, worker heaps capped via `resourceLimits` |

**Architectural invariant**: *no data structure may grow proportionally to file size, except the
sparse index, which grows at a 1/4096 factor and is capped regardless.*

---

## 4. Architecture

### 4.1 Processes and boundaries

```
┌──────────────────────── Extension Host (Node) ─────────────────────────┐
│  FixedWidthEditorProvider   (CustomReadonlyEditorProvider)             │
│  ├─ SessionManager       — lifecycle per open document                 │
│  ├─ IpcRouter            — typed protocol: request/response + push     │
│  ├─ FileHandleService    — open fd, positional read, LRU page cache    │
│  └─ WorkerPool ──────────┬─ indexer.worker  (scan, row offsets)        │
│                          └─ query.worker    (predicates, filters, sort)│
└───────────────────────────┬────────────────────────────────────────────┘
                            │  postMessage: control JSON + ArrayBuffer data
┌───────────────────────────┴──── Webview (Chromium, sandboxed) ─────────┐
│  Svelte 5 app                                                          │
│  ├─ VirtualGrid    — TanStack virtual-core, windowing                  │
│  ├─ RowStore       — sparse cache, coalesced requests, placeholders    │
│  ├─ SchemaPanel    — fixed-width / regex column editor                 │
│  └─ QueryBar       — SQL-like input, progressive state                 │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Code layers and dependency rules

```
src/
  core/       ← pure logic. Does NOT import 'vscode', DOM, or 'fs'.
              ← operates on externally supplied Buffer/Uint8Array. 100% testable with Vitest.
    index/    ← LineIndex, SparseIndex, checkpoint resolution
    parse/    ← FixedWidthParser, RegexParser, decoders, type coercion
    query/    ← tokenizer, SQL-like parser, AST, planner, compiled predicates
  shared/     ← IPC protocol types. Zero runtime dependencies. Imported by everyone.
  extension/  ← may import 'vscode', 'node:*', core, shared. NEVER DOM code.
  workers/    ← may import 'node:*', core, shared. NEVER 'vscode'.
  webview/    ← may import DOM, core, shared. NEVER 'vscode' or 'node:*'.
```

The dependency graph is **acyclic and unidirectional**: `core` and `shared` know nobody. Violations
are blocked by a per-directory ESLint `no-restricted-imports` rule.

### 4.3 Read flow (happy path)

1. **Webview** — scrolling brings rows `[N, N+50]` into view. `RowStore` coalesces the request onto a
   range aligned to 256-row blocks and tags it with a monotonic `generationId`.
2. **IpcRouter** — receives `fetchRows{from, count, gen}`; if `gen` is stale, it is dropped immediately.
3. **LineIndex** — resolves the byte offset: nearest checkpoint plus a local scan (≤ 4096 rows).
4. **FileHandleService** — reads the required pages; on a cache miss, a positional `read()` on the fd.
5. **Parsing** — happens **over bytes**, without decoding unrequested fields into strings.
6. **Response** — a single `ArrayBuffer` with a columnar layout and an offset table. Note the VS Code
   webview API accepts no transfer list, so this is one copy, not zero — but it never becomes JSON,
   which is the cost that actually matters.
7. **Webview** — lazy decoding (`TextDecoder` only for cells actually visible) and render.

### 4.4 Schema profile format (`*.fwq.json`)

A versionable artifact, shareable inside the user's own repository:

```jsonc
{
  "version": 1,
  "mode": "fixed",                                // "fixed" | "regex"
  "encoding": "latin1",                           // "utf8" | "latin1" | "ascii"
  "lineEnding": "crlf",                           // "auto" | "lf" | "crlf" | "none"
  "recordLength": 512,                            // required when lineEnding = "none"
  "columns": [
    { "name": "CODE",   "start": 0, "length": 8,  "type": "string",  "trim": "right" },
    { "name": "AMOUNT", "start": 8, "length": 12, "type": "decimal", "scale": 2, "signed": "trailing" }
  ],
  "pattern": "^(\\S+)\\s+\\[(\\w+)\\]\\s+(.*)$"   // only when mode = "regex"
}
```

> **High-value special case.** With `lineEnding: "none"` and a fixed `recordLength`, the offset of row
> N is exactly `N * recordLength`: no index, no scan, O(1) open even on 50 GB. Recognize and optimize
> this path first, before writing the indexer at all.

---

## 5. Implementation roadmap

| Phase | Content | Exit criterion |
|---|---|---|
| **F0** | Setup (this document), scaffolding, CI, fixture generator | Tests green, 5 GB fixture generable on demand |
| **F1** | Pure `core/index` and `core/parse`, with benchmarks | P4 and P7 demonstrated on fixtures, without VS Code |
| **F2** | `CustomReadonlyEditorProvider`, IPC, static grid | 5 GB file opens with P3 met |
| **F3** | Full virtualization, page cache, schema editor | P1, P2, P5 met across 1M+ rows |
| **F4** | Query engine (filters through SQL-like) on workers | P8 and P9 met, results progressive |
| **F5** | Streaming export, profiles, performance telemetry | 10M-row export with flat RSS |

---

## 6. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Wrongly choosing `CustomTextEditorProvider` | Fatal (OOM on open) | Explicit constraint in §2.1 plus a CI regression test that opens a 5 GB fixture |
| JSON serialization on the hot path | Loss of P2 and P5 | Binary protocol mandatory for row data (§4.3), enforced on the IPC module |
| A dense index adopted "for simplicity" | Violates P1 and P7 | The sparse index is the only admissible implementation |
| Global sort over a huge file | OOM | Sort row ids only, external merge sort on a temp file, or a mandatory `LIMIT` |
| Catastrophic user-supplied regex | Worker stall | Execution in a worker, per-row timeout, worker kill. Never run user regex in the extension host |
| Mixed CRLF, BOM, or encodings | Silent data corruption | Explicit sniffing, never implicit heuristics: the profile always declares the encoding |
