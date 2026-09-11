---
name: vscode-webview-ipc
description: Skill #2 — VS Code Custom Editor & Webview IPC. Use when registering a custom editor, creating or updating a WebviewPanel, defining or changing the messaging protocol between Extension Host and Webview, or handling CSP, nonces, local resources, state persistence, or document lifecycle.
---

# Skill #2 — VS Code Custom Editor & Webview IPC

Reference: SLOs **P2, P3, P6** and §4.1/§4.3 of `docs/00-PROJECT-CONTEXT.md`.

## 1. The provider choice decides the project

```ts
// CORRECT: VS Code reads nothing, the document is a lightweight handle.
vscode.window.registerCustomEditorProvider(
  'fixedWidthQuery.editor',
  provider,
  { webviewOptions: { retainContextWhenHidden: false }, supportsMultipleEditorsPerDocument: false }
);

class FixedWidthEditorProvider implements vscode.CustomReadonlyEditorProvider<FwqDocument> {
  async openCustomDocument(uri: vscode.Uri): Promise<FwqDocument> {
    // Opens ONLY the file descriptor and reads the header. No scan, no content.
    return FwqDocument.create(uri);
  }
  async resolveCustomEditor(doc: FwqDocument, panel: vscode.WebviewPanel, token: vscode.CancellationToken) { /* … */ }
}
```

- `CustomTextEditorProvider` is **forbidden**: it hands over a `TextDocument`, i.e. the whole file in RAM.
- `FwqDocument` implements `vscode.CustomDocument` and owns the `FileHandle`, the page cache, and the
  index. Its `dispose()` closes everything: fd, workers, subscriptions.
- Declare the association in the manifest under `customEditors` with a selective `filenamePattern`
  (`*.dat`, `*.txt` at `option` priority), otherwise you hijack files the user wants in a normal editor.
- `retainContextWhenHidden: false` by default: keeping a huge grid's DOM alive in a hidden tab costs
  memory. State is rebuilt via `setState` / `getState`.

## 2. Lifecycle and session

One **Session** per (document, panel) pair. It owns the `FileHandle`, `PageCache`, `LineIndex`,
`WorkerPool`, the current `generationId`, and a `DisposableStore`.

- Everything registered goes into the `DisposableStore`, disposed in the panel's `onDidDispose` and in
  the document's `dispose`.
- The `token` passed to `resolveCustomEditor` must be honored: if the user closes the tab during open,
  all in-flight work is cancelled.
- `onDidChangeViewState` suspends background work when the panel is not visible and resumes it when it
  returns. A hidden tab must consume no CPU.
- Watch the file: on external modification (changed `mtime` or `size`), invalidate index and cache and
  surface explicit state in the UI. Never serve data from a stale index.

## 3. IPC protocol

A single file, `src/shared/protocol.ts`, with discriminated unions in both directions:

```ts
export type RowRange = { readonly from: RowIndex; readonly count: number };

export type ToHost =
  | { type: 'ready' }
  | { type: 'fetchRows';  gen: number; range: RowRange }
  | { type: 'setSchema';  schema: SchemaProfile }
  | { type: 'runQuery';   gen: number; sql: string }
  | { type: 'cancel';     gen: number };

export type ToWebview =
  | { type: 'init';          meta: FileMeta; schema: SchemaProfile | null }
  | { type: 'rows';          gen: number; range: RowRange; payload: Uint8Array } // columnar, transferred
  | { type: 'indexProgress'; rows: number; bytes: number; done: boolean }
  | { type: 'queryProgress'; gen: number; matched: number; scanned: number; done: boolean }
  | { type: 'error';         code: ErrorCode; message: string };
```

Protocol rules:

1. **Request/response correlation** via `gen` (or a monotonic `requestId`). The host drops requests
   whose `gen` is below the current one; the webview ignores responses carrying a stale `gen`.
2. **Row data travels as binary.** `payload` is a `Uint8Array` built once. VS Code serializes
   `Uint8Array`/`ArrayBuffer` in webview messages natively rather than through JSON — use that, and
   never serialize rows yourself. Note `webview.postMessage` takes **no transfer list** (unlike
   `worker.postMessage`, which does): the payload is copied once. One copy of a packed buffer is
   still an order of magnitude cheaper than `JSON.stringify` over an array of row objects.
3. **Push for progress**, never polling. The host emits throttled progress (~10 Hz max); the webview
   never loops asking for state.
4. **Every inbound webview message is untrusted input**: validate `type`, numeric ranges, and sizes
   before use. A `count` of 10 million arriving from the UI must be rejected, not served.
5. **No domain logic in the protocol.** Messages carry intents and data, never generic commands such
   as `{ type: 'eval' }`.

### Binary layout of the rows payload

```
[ u32 rowCount ][ u32 colCount ]
[ u32 cellOffsets[(rowCount * colCount) + 1] ]   // offsets into the text block, prefix-sum
[ bytes textBlock ]                              // concatenated UTF-8, no separators
```

The webview decodes with `TextDecoder` **only** the visible cells, over `subarray`. One buffer per
response means one allocation and one copy, instead of thousands of strings through a serializer.

## 4. Webview security

```ts
const nonce = randomBytes(16).toString('base64');
panel.webview.options = {
  enableScripts: true,
  localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
};
```

A mandatory CSP in the HTML, no exceptions:

```
default-src 'none';
img-src ${webview.cspSource} data:;
style-src ${webview.cspSource} 'nonce-${nonce}';
script-src 'nonce-${nonce}';
font-src ${webview.cspSource};
```

- No `unsafe-inline`, no `unsafe-eval`, no CDN resources.
- Every resource URI goes through `webview.asWebviewUri`. Raw relative paths do not work.
- User file content is injected **only** via `textContent` or framework binding. Never `innerHTML` over
  data read from the file: a log file can contain anything.
- `localResourceRoots` points exclusively at the webview build directory.

## 5. Persistence and restore

- Register a `WebviewPanelSerializer` so open tabs survive a VS Code restart.
- Persisted state is **small and reconstructible**: scroll position, active schema, current query.
  Never row data, never the index.
- In the webview, call `vscode.setState()` on every meaningful change, throttled.
- On open, if a `.fwq.json` profile sits next to the file, load it automatically.

## 6. Errors and degraded UX

- Every error reaches the webview as typed state with a `code`, and the UI shows an actionable panel
  (retry, open settings, pick another encoding). Never a silent `console.error`.
- File no longer accessible, permission denied, unrecognized encoding, invalid regex: each gets its own
  `ErrorCode` and a plain-language message.
- While the index is building, the grid shows placeholders with progress: the UI never blocks waiting
  for completion.

## Anti-patterns to reject on sight

| Anti-pattern | Why it is fatal |
|---|---|
| `CustomTextEditorProvider` | Loads the entire file into memory |
| `postMessage({ rows: [...] })` with objects | JSON serialization on the hot path: kills P2 and P5 |
| `enableScripts` without CSP and nonce | XSS surface over arbitrary file content |
| `retainContextWhenHidden: true` by default | Memory retained by invisible tabs |
| The webview polling for state | Constant traffic and pointless latency: use push |
| Heavy work inside `resolveCustomEditor` | Violates P3 and stalls tab opening |
