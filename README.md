# Fixed-Width Query

A VS Code extension for opening, navigating and querying **multi-gigabyte** fixed-width and
pattern-delimited text files — mainframe extracts, COBOL copybook layouts, banking record
files, application logs — without loading them into memory.

VS Code's own editor gives up past ~50 MB because it materializes the whole file as a
`TextDocument`. This extension never reads more than a viewport's worth at a time.

## What it does

- **Opens instantly.** A 50 GB file opens as fast as a 50 KB one: only the header is read, and
  the row index is built incrementally in a background worker.
- **Two ways to define columns.** Fixed-width by byte offsets (typed, or drawn on a visual
  ruler against real sample records), or regex — either as a field separator (`\s{2,}`, `\t`)
  or as a whole-record pattern whose capture groups become columns.
- **Two ways to query.** Per-column filter boxes for quick work, and a SQL-like bar for real
  questions. Both compile to the same AST and run in the same worker, so they always agree —
  and the filter row shows you the SQL it just built.
- **Scrolls smoothly past a million rows**, with node recycling and two-axis virtualization.
- **Exports the result** to CSV or JSONL in streaming, at flat memory.

```sql
SELECT CODE, AMOUNT, STATUS
WHERE REGION = 'NORTH' AND AMOUNT > 50000 AND STATUS NOT LIKE '%CLOSED%'
ORDER BY AMOUNT DESC
LIMIT 100
```

Supported: `=` `<>` `<` `<=` `>` `>=`, `LIKE` / `ILIKE`, `IN`, `BETWEEN`, `IS [NOT] NULL`,
`MATCHES /regex/`, `AND` / `OR` / `NOT`, `ORDER BY` (requires `LIMIT`), `LIMIT` / `OFFSET`.

## Getting started

```bash
npm install
npm run build
```

Then press `F5` in VS Code to launch the Extension Development Host, and open a data file with
**Open in Fixed-Width Query** (explorer context menu, or the command palette).

Need something to open:

```bash
node scripts/make-fixture.mjs --rows 2000000 --out tmp/sample.dat
```

## Verifying

```bash
npm run verify
```

Runs the type checker on both build targets, the unit suite over `src/core/**`, and an
end-to-end smoke test that drives the **built worker threads** against a generated file and
compares every result against a naive whole-file scan — including a run with a chunk size
deliberately misaligned to the record length, because that is where scanners silently corrupt
data.

Individually: `npm run typecheck`, `npm test`, `npm run smoke`, `npm run lint`.

## Architecture at a glance

```
Extension Host (Node)                      Webview (Chromium, sandboxed)
  FixedWidthEditorProvider                   VirtualGrid    ← node recycling, 2-axis window
  Session ── FileHandleService (LRU cache)   RowStore       ← sparse blocks, coalesced fetches
         ├─ SparseIndex                      SchemaPanel / Ruler / QueryBar
         ├─ indexer.worker                 ↑
         └─ query.worker         ──────────┘ typed IPC, binary row payloads
```

| Layer | May import | Never imports |
|---|---|---|
| `src/core/**` | nothing | `vscode`, `node:*`, DOM |
| `src/shared/**` | nothing | `vscode`, `node:*`, DOM |
| `src/extension/**` | `vscode`, `node:*`, core, shared | DOM |
| `src/workers/**` | `node:*`, core, shared | `vscode` |
| `src/webview/**` | DOM, core, shared | `vscode`, `node:*` |

These boundaries are enforced by ESLint, not by convention — see [.eslintrc.cjs](.eslintrc.cjs).

## Documentation

- [docs/00-PROJECT-CONTEXT.md](docs/00-PROJECT-CONTEXT.md) — goals, stack, performance SLOs, risks
- [docs/adr/](docs/adr/) — decisions that amend the context document
- [CLAUDE.md](CLAUDE.md) — engineering rules this codebase is held to
- [.claude/skills/](.claude/skills/) — the four competency areas, with their anti-patterns

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `fixedWidthQuery.pageSizeBytes` | 1 MiB | Disk read page size |
| `fixedWidthQuery.pageCacheBytes` | 64 MiB | Hard cache ceiling — memory stays flat regardless of file size |
| `fixedWidthQuery.checkpointStride` | 4096 | Rows between index checkpoints |
| `fixedWidthQuery.defaultEncoding` | `latin1` | Assumed when no schema profile exists |
| `fixedWidthQuery.maxQueryResults` | 2,000,000 | Scan stops and reports truncation past this |
| `fixedWidthQuery.workerHeapMb` | 192 | Per-worker heap cap; a worker that exceeds it dies alone |

## Schema profiles

Saving a schema writes `<file>.fwq.json` next to the data file, and it is loaded automatically
next time. Check it into your repo so a layout is defined once for the whole team.

```jsonc
{
  "version": 1,
  "mode": "fixed",
  "encoding": "latin1",
  "lineEnding": "none",     // no terminator: row N is at N * recordLength, so no index at all
  "recordLength": 512,
  "columns": [
    { "name": "CODE",   "start": 0, "length": 8,  "type": "string",  "trim": "right" },
    { "name": "AMOUNT", "start": 8, "length": 12, "type": "decimal", "scale": 2, "signed": "trailing" }
  ]
}
```

## Known limits

- **Read-only.** Editing is out of scope for v1 (see [ADR-001](docs/adr/ADR-001-editor-api-and-virtualizer.md)).
- **Local files only.** Positional reads are unavailable on virtual file systems, so no
  vscode.dev and no remote schemes.
- **Single query worker.** Partitioned parallel scanning is deferred until the scan is measured
  to be CPU-bound rather than IO-bound on target hardware.
- **`ORDER BY` requires `LIMIT`**, deliberately: sorting an unbounded result over a file this
  size cannot fit in memory, and failing loudly beats failing at 90%.
- Fixed-width offsets are **byte** offsets. For latin1/ascii — what these formats actually use
  — that is identical to character offsets. Under utf8 they diverge, and bytes are the honest
  reading, since the layout was written in bytes.
