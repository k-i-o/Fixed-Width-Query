---
name: virtual-rendering
description: Skill #3 — Virtualization & High-Performance Rendering. Use when building or changing the webview grid, virtual scrolling, the RowStore, placeholder handling, selection, column resizing, or when investigating scroll jank, dropped frames, and layout thrashing.
---

# Skill #3 — Virtualization & High-Performance Rendering

Reference: SLOs **P2, P5** in `docs/00-PROJECT-CONTEXT.md`. Target: 1,000,000+ rows at 55+ fps.

## 1. The frame budget rule

16 ms per frame. Work on the scroll path is limited to: compute the visible range, position nodes,
write text. Everything else (fetching, parsing, measuring, formatting) happens off-frame or asynchronously.

## 2. Windowing

- `@tanstack/virtual-core` owns the visible range. Do not reimplement scroll math: the edge cases
  (elastic scroll, zoom, dynamic rows) are already solved there.
- **Virtualize both axes**: a fixed-width layout can carry 200 columns. Columns outside the horizontal
  viewport are not rendered.
- `overscan` between 5 and 10 rows. High values waste fetches and DOM; zero produces blank rows on scroll.
- **Fixed row height** in v1: it makes the scroll↔row mapping exact and O(1). Variable height would
  require measurement, therefore reflow: out of scope.

## 3. The browser height limit

A container sized `rowCount * rowHeight` exceeds the browser's maximum pixel extent (roughly 33 million
in Chromium) at around 1.5 million rows: scrolling becomes imprecise and jumps. Admissible solutions,
in order of preference:

1. **Scaled virtual scrolling** — cap the container at a safe height (~10M px) and apply a conversion
   factor between scroll position and row index, compensating drift with an anchor offset during fine
   scrolling.
2. **Segmented paging** — virtualize within a segment and switch segments at the boundaries.

In both cases the native scrollbar becomes approximate: always pair it with a "go to row" field and an
exact position indicator. Nobody navigates a billion rows by scrollbar feel.

## 4. RowStore — the heart of smoothness

```
RowStore
  ├─ sparse cache: Map<blockId, DecodedBlock>   // 256-row blocks, capped at ~3× viewport
  ├─ inFlight:     Map<blockId, AbortController>
  ├─ generation:   number                        // invalidated on schema or query change
  └─ policy:       fetch on near-idle scroll, placeholders immediately
```

Required behavior:

- **Immediate placeholders.** An unavailable row draws instantly as a skeleton of identical height. The
  grid never waits for data: waiting is something you see, not something you suffer.
- **Coalescing.** Requests for contiguous blocks within one tick become a single range request.
- **Fast-scroll debounce.** During rapid scrolling, do not emit a fetch for every position crossed:
  emit on settle (~80 ms) and only for the block actually at rest.
- **Cancellation.** Blocks that leave the viewport while still in flight are aborted with `cancel{gen}`.
- **LRU eviction** of decoded blocks, capped in bytes, not in item count.
- **No array reallocation**: the cache is sparse by definition, never an array as long as the file with
  holes in it.

## 5. DOM rendering rules

- **Recycle nodes**, do not create and destroy them. The number of row elements in the DOM is constant
  at `visibleRows + overscan`. A recycled cell updates `textContent` and nothing more.
- **Transforms, not `top`.** Positioning uses `transform: translate3d(0, Ypx, 0)`: it stays on the
  compositor and avoids layout.
- **No layout reads inside the render loop.** `offsetHeight`, `getBoundingClientRect` and friends force
  a synchronous reflow. Measure once at init and on resize, never per row.
- `contain: strict` on the rows container, and `content-visibility: auto` where applicable.
- `font-variant-numeric: tabular-nums` with a monospace font: in a fixed-width layout, character
  alignment is part of how the data is read.
- No shadows, no filters, no transitions on rows: those are per-element paint costs.
- Cells are not decoded until visible: `TextDecoder` over a `subarray` at render time.

## 6. Interactions

- **Selection** stored as row-id ranges, never as a list of DOM elements. Selecting "all" is a range,
  not a billion objects.
- **Copying** a large selection is requested from the host, streamed, bounded, and warned about; the
  webview never builds a gigabyte-sized string.
- **Column resizing** uses an overlay during the drag and a single re-layout on release.
- **Go to row N** is O(1) into the RowStore, which asks the host: no simulated scrolling through the
  intermediate rows.
- **Search** is delegated to the host: the webview does not own the text being searched.

## 7. Verification tooling

- Chrome DevTools inside the webview: the *Developer: Open Webview Developer Tools* command.
- Performance panel: look for long tasks over 50 ms and for "Recalculate Style" / "Layout" entries
  inside the scroll.
- A `PerformanceObserver` on `longtask` in dev builds, logging the visible range at the moment of the stall.
- Mandatory manual test: drag the scrollbar from start to end across 1M rows, then `Ctrl+End`, then jump
  to a random row. No visible dropped frames, no persistent blank rows.

## Anti-patterns to reject on sight

| Anti-pattern | Why it is fatal |
|---|---|
| Rendering every row and trusting the browser | The DOM collapses past a few thousand nodes |
| A native `<table>` for the grid | Table layout is global: every update recomputes everything |
| One stateful component per cell | Thousands of reactive instances per frame |
| Fetching on every scroll event | Saturates the IPC channel and produces out-of-order responses |
| Keying by viewport index | Node recycling breaks and text "dances" between rows |
| Formatting (dates, decimals) during render | Belongs at block decode time, once, not per frame |
