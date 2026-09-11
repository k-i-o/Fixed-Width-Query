# Changelog

All notable changes to Fixed-Width Query are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-12

First public release.

### Added

- **Custom read-only editor** for fixed-width and pattern-delimited text files, built on
  `CustomReadonlyEditorProvider` so the file is never loaded into memory.
- **Sparse row index** built in a background worker: one checkpoint every 4096 rows, about
  2 MB per billion rows. Navigation works on the indexed prefix while the rest is scanning.
- **O(1) open for fixed-length records**: with no terminator and a known record length, row
  N is at `N * recordLength` and no index is built at all.
- **Virtualized grid** on both axes, with node recycling and a scroll model that stays exact
  past the browser's ~33.5M pixel height limit.
- **Column resizing** by drag, double-click to fit, and a Fit columns command. Widths persist.
- **Schema editor** in fixed-width or regex mode, plus a visual ruler for placing cut points
  against real sample records.
- **Schema profiles** (`.fwq.json`): saved beside the data file and reloaded automatically,
  or saved anywhere and applied to any file with the same layout.
- **SQL-like queries** — `SELECT … WHERE … ORDER BY … LIMIT` with `LIKE`/`ILIKE`, `IN`,
  `BETWEEN`, `IS NULL`, `MATCHES /regex/` — executed in a worker with progressive results.
- **Per-column filters** that compile to the same AST as the SQL bar and show their SQL.
- **Streaming export** of a result to CSV or JSONL at flat memory.
- Support for latin1, utf8 and ascii; BOM, LF, CRLF and mixed terminators; COBOL trailing
  signs and implied decimal scale.

### Known limitations

- Read-only. Editing is out of scope for this release.
- Local files only: positional reads are unavailable on virtual file systems.
- `ORDER BY` requires `LIMIT`, deliberately — sorting an unbounded result over a file this
  size cannot fit in memory.
- Memory is flat in file size, but a query returning millions of rows holds roughly 100 bytes
  per match. Use `LIMIT`, or lower `fixedWidthQuery.maxQueryResults`, on very broad queries.
