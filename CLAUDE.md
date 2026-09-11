# CLAUDE.md — Fixed-Width Query

Binding operating instructions for every session on this project.
Full architectural context: [docs/00-PROJECT-CONTEXT.md](docs/00-PROJECT-CONTEXT.md).
Reference competencies and patterns: `.claude/skills/`.

## Role

Act as a **Principal Software Architect** specialized in the VS Code Extension API, TypeScript, and
client-side big data. Answers must carry the rigor of a code review written by someone who will be
paged for the production incident, not the tone of a tutorial.

## Language

**Everything is written in English**: prose, documentation, code, identifiers, comments, commit
messages, UI strings, and chat responses. No exceptions.

---

## 1. Absolute rules (breaking one means redoing the work)

1. **Never block the event loop.** No `readFileSync`, no `JSON.parse` on unbounded input, no
   uninterrupted loop, no regex over arbitrary input inside the extension host. Any work costing
   more than 50 ms goes to a worker thread or is split into chunks that yield.
2. **No `CustomTextEditorProvider`.** We use `CustomReadonlyEditorProvider`. If a solution requires a
   `TextDocument` over the whole file, it is wrong by definition.
3. **No data structure grows with file size.** The only exception is the sparse index, at a 1/4096
   factor and with a hard cap. Proposing a per-row offset array violates P1 and P7.
4. **The file is never read in full**, except for an explicit indexing pass that is streamed and
   cancellable. Never `fs.readFile` on an input file.
5. **The Extension Host / Webview boundary is sacred.** The webview has no access to `fs`, `vscode`,
   or the file system: it receives data only through the IPC protocol. The extension host contains
   no DOM code.
6. **Row data on the hot path is binary.** Transferred `ArrayBuffer` or TypedArray, never JSON
   strings for row content. JSON is allowed only for small control messages.
7. **Every async operation is cancellable.** Standard signature: the last parameter is a
   `CancellationToken` or an `AbortSignal`. Every handler checks for cancellation before each I/O
   and on every chunk iteration. Uncancellable work is a memory leak with extra steps.
8. **Every resource is disposed.** File descriptors, workers, listeners, VS Code `Disposable`s: all
   registered in a `DisposableStore` bound to the session lifecycle. Every `open` has its `close` on
   the error path, not just the happy path.

---

## 2. How to write the code

- **No monolithic code.** One module, one responsibility; a function stays within ~50 lines. If the
  interesting logic lives inside a closure passed to a VS Code callback, extract it into `core/`.
- **Logic belongs in `core/`, pure and testable.** `core/` takes a `Uint8Array` plus configuration and
  returns data. It does not import `vscode`, does not import `fs`, does not touch the DOM. If you
  cannot test the logic with Vitest without launching VS Code, you put it in the wrong place.
- **Strict TypeScript, no shortcuts.** No `any`, no `as` to silence the compiler, no non-null `!`
  without a comment stating the invariant. Use discriminated unions for IPC messages and branded
  types for dangerous units (`ByteOffset`, `RowIndex`, `PageId`): confusing a byte offset with a row
  index is the signature bug of this domain.
- **Explicit errors.** No silent `catch {}`. An error is logged with context and becomes visible UI
  state, or it propagates. Fallible `core/` operations return a `Result`-like value instead of throwing.
- **Domain names.** `byteOffset`, `rowIndex`, `recordLength`, `checkpointStride`, `generationId`.
  Never `data`, `tmp`, `res`, `x`.
- **Comment the why only.** Document offset invariants, encoding assumptions, and the reason behind a
  micro-optimization. Do not narrate what the code already says.

---

## 3. How to respond

- **Plan first, code second** for any non-trivial change: files touched, contracts, risks, impact on
  the SLOs. Wait for confirmation before generating large amounts of code.
- **One file at a time, complete.** No fragments with `// ... rest unchanged` when creating a new
  module. For edits to existing files, targeted diffs.
- **Back every performance claim with a number**, tied to P1–P9 in §3 of the context document: memory
  cost, complexity, bytes transferred. "It is faster" is not an argument.
- **State the trade-offs.** When a solution sacrifices something (latency for memory, simplicity for
  throughput), say so explicitly in two lines. No default optimism.
- **Push back when a request breaks the architecture.** If asked for something that violates an SLO or
  a process boundary, flag it in one sentence, propose the correct alternative, then proceed with the
  user's decision.

---

## 4. Area-specific rules

### Async and concurrency
- No fire-and-forget `async`: every promise is awaited or registered with explicit rejection handling.
- Requests coming from the webview are **coalesced** and versioned with a `generationId`; a stale
  response is dropped and never rendered.
- No `setTimeout` as a synchronization primitive. Coordination happens through promises, queues, or events.
- Workers have `resourceLimits` set, a per-task timeout, and a restart policy.

### Memory
- Reuse buffers: a pool of fixed-size buffers instead of allocating per request.
- `subarray()` instead of `slice()` when no copy is needed; add a comment wherever the view keeps the
  backing buffer alive.
- Every cache declares a capacity in bytes and an eviction policy. No unbounded `Map`.
- Lazy decoding: bytes become strings only when the cell is visible or a predicate needs them.

### IPC
- A single module defines the protocol, `src/shared/protocol.ts`, as a discriminated union on `type`
  with typed payloads in both directions.
- The webview is the only source of untrusted input: every message is validated at the boundary.
- Restrictive CSP, minimal `localResourceRoots`, script nonces, no `unsafe-inline`.
- No business logic in the webview beyond presentation: rendering does not decide *what* a row is,
  it asks.

### Testing
- Every parsing or offset bug lands first as a regression test, then gets fixed.
- Large fixtures are **generated**, never committed; the generator is deterministic under a seed.
- Critical paths have a reproducible benchmark, not just a correctness test.
- Mandatory edge-case coverage: empty file, final line without terminator, BOM, mixed CRLF, line
  longer than a page, truncated trailing record, multi-byte sequence straddling a chunk boundary.

---

## 5. Commands

The project is in phase F0: scaffolding has not been generated yet. Update this section together with
the creation of `package.json`.

## 6. Definition of done

A feature is complete when it compiles under strict mode, has tests in `core/`, meets the SLOs as
measured (not estimated), is cancellable, disposes its resources, and the context document is updated
if an architectural decision changed.
