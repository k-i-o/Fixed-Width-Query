# Testing before publishing

Ordered so each stage is cheap and catches what the next one cannot. Stop at the first
failure; running stage 5 on a build that fails stage 1 wastes an afternoon.

Stages 1–3 are automated and take under a minute. Stages 4–6 need a human and roughly an
hour. **Nothing has ever been published from this repo, so the first run of stages 4–6 is
also the first time anyone has seen the UI work.**

---

## Stage 1 — static checks (seconds)

```bash
npm run typecheck && npm run lint
```

Covers both build targets and the layer boundaries (`core/` must not reach `vscode`, the
webview must not reach `node:*`). A cross-layer import is the kind of mistake that works on
your machine and fails for everyone else.

## Stage 2 — unit tests (seconds)

```bash
npm test
```

36 tests over `src/core/**`. Weighted toward the failures that corrupt data silently rather
than crash: unterminated final records, mixed CRLF, BOM, short records, trailing COBOL signs,
row numbers past 2³².

## Stage 3 — end-to-end against the built workers (~10 seconds)

```bash
npm run smoke
```

Generates a file, drives the **built** worker bundles against it, and compares every answer to
a naive whole-file scan. Includes a run with the chunk size deliberately misaligned to the
record length so a record straddles every chunk boundary — where scanners silently corrupt
data. This is the stage that catches a bundling or worker-wiring break that unit tests cannot
see, because unit tests never load `dist/`.

## Stage 4 — SLO measurement at scale (minutes)

```bash
npm run perf                 # 500 MB — the minimum that says anything
npm run perf -- --gb 5       # the size the context document benchmarks against
npm run perf -- --gb 5 --keep --reuse   # fast loop while optimizing
npm run perf -- --mode fixed-length     # the no-index path
```

Reports P1–P9 with a verdict per SLO and exits non-zero if a gated one is missed. It drives
the real `FileHandleService`, `SparseIndex`, `RowFetcher` and workers — not reimplementations.

Read the per-phase memory table, not just the verdict. `peak RSS` includes garbage the
collector has not reached; `settled RSS` is measured after a forced collection and is what
actually constitutes held memory. A phase where those two diverge wildly means transient
allocation; one where `settled` stays high means something is retained.

**Run this on the slowest disk you support.** P4 and P8 are dominated by I/O, and NVMe
numbers tell you nothing about a network share or a spinning disk — which is exactly where
files this size tend to live.

Do not publish with a FAIL unless you have written down why it is acceptable.

## Stage 5 — manual, in a real VS Code (~45 minutes)

Press **F5** (`Run Extension`). It builds first and opens a window with `tmp/` as the
workspace and other extensions disabled.

### 5a. The corpus

```bash
npm run edge-cases
```

Writes 19 files to `tmp/edge/` with per-file expectations in `tmp/edge/README.md`. Open each
and check the stated expectation. Do not eyeball it — read the actual cell values. A grid
that renders plausible-looking wrong data is the failure mode this extension exists to avoid.

Three that matter most:

- **`html-injection.dat`** — if any dialog appears, the CSP or the `textContent` rule is
  broken and you must not publish. This file contains what a hostile log line looks like.
- **`no-trailing-newline.dat`** — must be exactly 3 rows. Dropping the last record is the
  single most common bug in this class of tool.
- **`fixed-length-no-terminator.dat`** — with `lineEnding: none` and `recordLength: 34` it
  must open with no indexing pass at all.

### 5b. Interaction, on a large file

```bash
node scripts/make-fixture.mjs --rows 2000000 --out tmp/sample.dat
```

- Drag the scrollbar end to end. No blank rows that persist, no frozen UI.
- `Ctrl+End`, then `Ctrl+G` to a random row. The row number in the gutter must match.
- Past ~1.5M rows the scrollbar is approximate by design (ADR-001) — confirm "go to row" is
  still exact, since that is the compensation.
- Resize the window mid-scroll. Column headers stay aligned with their columns.
- Type in a column filter. Confirm the query bar shows the equivalent SQL.
- Run a query, then **Cancel** mid-scan. The UI must return to a usable state.
- Run a query, change the schema while it runs. No stale rows from the old schema.
- Export a result to CSV and diff a few rows against the source file.

### 5c. Environment

- **Light, dark, and a high-contrast theme.** Every colour comes from a theme variable, so a
  hardcoded one shows up immediately as unreadable text.
- **Nothing is on screen that should not be.** The error banner, the ruler and schema panels,
  and the conditional schema fields (record length, column widths) all start hidden. A CSS
  rule that sets `display` outranks the browser's `[hidden]` rule, so an element can be hidden
  in the markup, hidden in the logic, and still visible — there is a global `[hidden]` guard
  in `style.css`, and this is the check that it still works.
- Close the tab mid-index and mid-query. Check Task Manager: no orphaned worker process.
- Open four large files at once; watch the extension host's memory in
  **Developer: Open Process Explorer**.
- Delete the file while it is open. Modify it externally while open — expect the
  `FILE_CHANGED` banner, not silently stale rows.

## Stage 6 — package and install (~10 minutes)

```bash
npx vsce package
```

Then check:

- **Contents**: `npx vsce ls`. `src/`, `test/`, `scripts/`, `docs/`, `tmp/` and `node_modules/`
  must all be absent. If the `.vsix` is above a megabyte or two, `.vscodeignore` is wrong.
- **Install the artifact itself**, not the dev build: `code --install-extension fixed-width-query-0.1.0.vsix`,
  then restart and repeat a short version of 5a. A packaged extension resolves paths
  differently from `--extensionDevelopmentPath`, and worker scripts loaded by path are exactly
  the kind of thing that only breaks once packaged.
- Open a file with the extension **not** activated yet, to confirm activation works from a
  cold start via the `customEditors` contribution.

## Before you publish

- [ ] Stages 1–4 pass; any SLO FAIL is documented with a reason
- [ ] Stage 5 done on Windows and on at least one of macOS/Linux — path handling and file
      locking differ, and this extension holds an open file descriptor for the session
- [ ] Stage 6 done from the `.vsix`, not the dev build
- [ ] `publisher` in `package.json` is a publisher ID you actually own
- [ ] `repository`, `LICENSE` and an icon are present — the Marketplace page looks abandoned
      without them
- [ ] `CHANGELOG.md` exists
- [ ] Version bumped
- [ ] Known limits in the README still match reality

## What is deliberately not automated

`@vscode/test-electron` integration tests would cover activation and the custom editor
lifecycle, and are the obvious next investment. They are not here yet, which is precisely why
stage 5 is long and specific. If this extension grows past v1, convert 5a into an automated
suite first — it is mechanical, and it is the stage most likely to be skipped when rushed.
