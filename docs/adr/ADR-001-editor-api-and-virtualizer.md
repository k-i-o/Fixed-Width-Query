# ADR-001 — Custom editor API, virtualizer, and offset representation

Status: **accepted** · Date: 2026-09-11 · Supersedes parts of `00-PROJECT-CONTEXT.md` §2.1

## Context

The implementation brief asked for the **Custom Text Editor API** and for **TanStack Virtual**.
Both were evaluated against the SLOs in §3 of the context document during F2/F3 implementation.
A third decision, on how byte offsets are stored, also diverged from what the skill documents
described, and is recorded here so the two do not silently disagree.

## Decision 1 — `CustomReadonlyEditorProvider`, not `CustomTextEditorProvider`

`CustomTextEditorProvider.resolveCustomTextEditor` receives a `vscode.TextDocument`. VS Code
materializes that document — the entire file, in memory, as a string — *before* provider code
runs. There is no hook that executes earlier and no option that makes it lazy.

For a 5 GB file this means the extension has already lost before its first line of code runs:
the host allocates several times the file size (UTF-16 plus line-start bookkeeping) and either
thrashes or dies. VS Code's own editor refuses files past ~50 MB for exactly this reason.

`CustomReadonlyEditorProvider.openCustomDocument` receives only a `vscode.Uri`. All I/O stays
ours, which is what makes P1 (flat 200 MB RSS) and P3 (first row under 500 ms) achievable.

**Consequence**: the editor is read-only, which matches non-goal §1.2 anyway. Writing would
require `CustomEditorProvider` with a backup/save lifecycle, and an edit model over a file too
large to rewrite — a design problem in its own right, not a missing checkbox.

## Decision 2 — a purpose-built virtualizer, not TanStack Virtual

TanStack Virtual is a good library and solves windowing correctly. It does not solve the
problem that actually bites at our target scale: browsers cap element height near 33.5M pixels
in Chromium, so a container sized `rowCount * rowHeight` becomes imprecise at roughly 1.5M rows
— scrollbar drags start skipping, and the mapping from scroll position to row stops being
single-valued. Our stated target is "over 1,000,000 rows", i.e. straddling that limit.

Handling it means owning the scroll-position-to-row mapping, which is the core of what a
virtualizer does. Wrapping a library and then overriding its central calculation is worse than
writing the ~120 lines directly. Doing so also keeps the extension at **zero runtime
dependencies**, which matters for a webview under a strict CSP.

**Consequence**: node recycling, overscan and the two-axis window are ours to maintain and to
test. Above the pixel cap the scrollbar is approximate by construction, so the UI pairs it with
an exact "go to row" control (`virtualGrid.ts`, `blockTop()`).

## Decision 3 — `Float64Array` for byte offsets, not `BigUint64Array`

The memory-streaming skill document specifies `BigUint64Array` for byte offsets. The
implementation uses `Float64Array` throughout.

The requirement that rule exists to enforce is *do not use `Uint32Array`*, which overflows
silently past 4 GB — corrupting data rather than crashing. `Float64Array` satisfies it: a
double represents every integer up to 2^53 exactly, which is 9 PB of file. It also avoids BigInt
boxing in loops that touch one offset per row, where the difference is measurable across a
billion rows.

**Consequence**: `src/shared/branded.ts` documents the reasoning at the point of use, and
`MAX_SAFE_FILE_SIZE` names the limit. Should the extension ever need offsets past 2^53, this
decision must be revisited rather than quietly patched.

## Alternatives rejected

- **Custom Text Editor with a truncated document.** Showing the first 50 MB and pretending the
  rest is not there fails the entire premise.
- **TanStack Virtual with a segmented container.** Viable, but the segment-switching logic is
  comparable in size to the whole virtualizer while adding a dependency and an abstraction to
  work against.
- **A dense `BigUint64Array` index.** Correct and simple, and 8 GB for a billion rows. Violates
  P1 and P7.
