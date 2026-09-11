---
name: query-engine
description: Skill #4 — Query Engine. Use when designing or changing the SQL-like parser, the AST, the planner, compiled predicates, the filter pipeline, sorting, match counting, or result export. Applies equally to UI column filters, which are queries in disguise.
---

# Skill #4 — Query Engine

Reference: SLOs **P8, P9** and §1.1 (C4, C5, C6) of `docs/00-PROJECT-CONTEXT.md`.

## 1. Five-stage architecture

```
SQL text → Tokenizer → Parser → AST → Planner → Compiled predicate → Executor (worker)
```

Each stage is a pure module under `src/core/query/`, testable in isolation. The tokenizer and parser
know nothing about files; the executor knows nothing about syntax.

## 2. Supported SQL subset (v1)

```sql
SELECT col1, col2 | *
FROM rows                                    -- implicit, a single "table": the current file
WHERE <expr>
ORDER BY col [ASC|DESC]                      -- requires LIMIT, or an explicit external sort
LIMIT n [OFFSET m]
```

Admissible expressions: `=`, `<>`, `<`, `<=`, `>`, `>=`, `LIKE`, `NOT LIKE`, `IN (...)`, `BETWEEN`,
`IS NULL` / `IS NOT NULL` (empty or all-blank field), `AND`, `OR`, `NOT`, parentheses, and
`MATCHES /regex/` as a declared non-standard extension.

Out of scope in v1: JOIN, subqueries, GROUP BY, aggregate functions, window functions. If a request
implies one of those, say so and propose the v2 path instead of improvising half a SQL engine.

## 3. Parsing

- **Hand-written tokenizer**, not global regexes: we need the exact position of every token for errors.
- **Recursive-descent parser with precedence** (a Pratt parser for expressions). Readable, extensible,
  and dependency-free.
- **Syntax errors are data**, not exceptions: `{ ok: false, at: offset, expected, found }`. The query
  bar underlines the exact position; no generic "invalid query" message.
- **Semantic validation is separate** from parsing: column names exist, types are compatible with the
  operator, `ORDER BY` without `LIMIT` is flagged. The message suggests the closest column name on a typo.

## 4. Planner — where the wins actually are

The planner turns the AST into a physical plan. Its decisions matter more than any micro-optimization
inside the executor.

1. **Predicate pushdown onto bytes.** A comparison on a fixed-width column becomes a comparison over the
   record's byte subrange: neither the row nor the other columns need decoding.
2. **Reorder by selectivity and cost.** Predicates are evaluated cheapest-and-most-selective first:
   byte equality, then numeric comparisons, then `LIKE`, and regexes last. Selectivity is estimated
   from a sample of the first N rows and refined during execution.
3. **Short-circuiting.** `AND` and `OR` compile into chains with early exit, never evaluating the rest.
4. **Late materialization.** The scan accumulates **row ids only** for matching rows. `SELECT` columns
   are extracted afterwards, and only for rows actually displayed. This is what keeps results under
   32 MB even at 10 million matches.
5. **Literal prefilter.** If the query contains a mandatory substring, search the raw block for it first
   (`Buffer.indexOf`, which uses an optimized native search): blocks that do not contain it are skipped
   whole, without ever being split into rows.
6. **Counting shortcuts.** `COUNT` without a `WHERE` is answered from the index, with no scan.

## 5. Predicate compilation

A predicate becomes a specialized closure, built once per query:

```ts
type Predicate = (record: Uint8Array, recordStart: number) => boolean;
```

- Composed closures are sufficient and stay debuggable. Code generation via `new Function` is
  **forbidden**: the webview CSP and the injection risk from user input do not justify it. If it ever
  becomes necessary, it runs in a worker only, over an already-validated AST, as a documented decision.
- Monomorphism: one closure per operator and type (`eqAscii`, `ltDecimal`, `likeCaseInsensitive`). A
  generic function that inspects types at runtime gets deoptimized by the JIT.
- No allocation inside a predicate body: no `slice`, no temporary strings, no objects. Byte comparisons
  by offset and length.
- Numbers and decimals: parse straight from bytes into an integer accumulator, never `parseFloat` over a
  string. Fixed-scale decimals compare as scaled integers.

## 6. Execution

- Always inside a **query worker**, never in the extension host.
- Scan in 4 MB blocks, aligned to record boundaries: a record split across two blocks is edge case number one.
- **Progressive results**: roughly every 100 ms the worker emits `queryProgress { matched, scanned, done }`
  along with the row ids found so far. The user sees results while the scan continues.
- **Cancellation** checked at least once per block, releasing buffers immediately.
- **Per-record timeout** on regexes, killing the worker if exceeded: a catastrophic user-supplied regex
  must not be able to freeze anything.
- Parallelism by file partitioning: N workers over N disjoint byte ranges, each aligned to record
  boundaries, with row ids merged in order at the end. Introduce this only after measuring that the scan
  is CPU-bound rather than IO-bound.

## 7. Sorting

- Sort **row ids**, never rows. The sort key is extracted into a parallel array (`Float64Array` for
  numbers, byte offsets for strings compared on demand).
- `ORDER BY` with a small `LIMIT n`: **top-N with a heap** of size n, single pass, O(n) memory. This is
  by far the most common case and should be implemented first.
- `ORDER BY` without `LIMIT` over a huge result: external merge sort with runs on a temp file, or an
  explicit refusal with a message suggesting a `LIMIT`. Never an in-memory sort over an unbounded result.

## 8. UI filters are queries

Per-column grid filters do not get a separate engine: they build the same AST the SQL parser produces.
This guarantees one semantics, one test suite, and the ability to show the user the SQL equivalent of
what they clicked. Composing multiple filters yields an `AND` of predicates within the same plan, not a
fresh scan per filter.

## 9. Mandatory tests

- Parser golden tests: for each query, the expected serialized AST.
- Property tests: compiled predicate against a naive reference implementation over random data; they
  must always agree.
- Domain edge cases: all-blank field, trailing sign (`123-` and COBOL overpunch), leading zeros, field
  truncated at end of file, multi-byte sequence straddling a block boundary, column exceeding record length.
- A 5 GB fixture benchmark asserting P8, run reduced in CI and in full locally.

## Anti-patterns to reject on sight

| Anti-pattern | Why it is fatal |
|---|---|
| `new Function` over user input | Injection and a CSP violation |
| Decoding every row to a string to filter | An order of magnitude slower, plus per-row allocations |
| Accumulating row objects in results | Blows the 32 MB budget at a few hundred thousand matches |
| Regex built by concatenating user input | ReDoS and unpredictable semantics |
| Running the query in the extension host | Freezes the entire VS Code window |
| Waiting for completion before showing anything | Violates the progressive experience required by C5 |
