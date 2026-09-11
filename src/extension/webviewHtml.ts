/**
 * Webview shell.
 *
 * The CSP here is the security boundary for the whole extension: the page renders bytes
 * from arbitrary user files, including files the user did not write. `default-src 'none'`
 * with a per-load nonce means a log line containing markup is inert text, not code.
 */

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

export function renderWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'style.css'));

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Fixed-Width Query</title>
</head>
<body>
  <div id="app">
    <header id="toolbar">
      <div class="toolbar-row">
        <span id="file-name" class="file-name">&nbsp;</span>
        <span id="file-stats" class="stats"></span>
        <span class="spacer"></span>
        <label class="field">
          <span>Go to row</span>
          <input id="goto-row" type="number" min="1" step="1" placeholder="1">
        </label>
        <button id="btn-fit-columns" type="button" title="Resize every column to fit its visible contents">Fit columns</button>
        <button id="btn-schema" type="button">Schema</button>
        <button id="btn-ruler" type="button">Ruler</button>
        <button id="btn-load-schema" type="button" title="Apply a .fwq.json profile saved for another file">Load profile</button>
        <button id="btn-save-schema" type="button" title="Save beside this file, so it reloads automatically next time. Shift-click to choose a location.">Save profile</button>
      </div>

      <div class="toolbar-row">
        <input id="query-input" type="text" spellcheck="false" autocomplete="off"
               placeholder="SELECT * WHERE col2 LIKE '%C5%' ORDER BY col1 DESC LIMIT 100">
        <button id="btn-run" type="button" class="primary">Run</button>
        <button id="btn-cancel" type="button" disabled>Cancel</button>
        <button id="btn-clear" type="button" disabled>Clear result</button>
        <button id="btn-export" type="button" disabled>Export</button>
      </div>

      <div id="query-status" class="status" hidden></div>
      <div id="index-status" class="status subtle"></div>
      <div id="profile-status" class="status subtle"></div>
    </header>

    <section id="schema-panel" class="panel" hidden>
      <div class="panel-row">
        <label class="field">
          <span>Mode</span>
          <select id="schema-mode">
            <option value="regex">Regex / whitespace</option>
            <option value="fixed">Fixed width</option>
          </select>
        </label>
        <label class="field">
          <span>Encoding</span>
          <select id="schema-encoding">
            <option value="latin1">latin1</option>
            <option value="utf8">utf8</option>
            <option value="ascii">ascii</option>
          </select>
        </label>
        <label class="field">
          <span>Record terminator</span>
          <select id="schema-line-ending">
            <option value="auto">auto-detect</option>
            <option value="lf">LF</option>
            <option value="crlf">CRLF</option>
            <option value="none">none (fixed length)</option>
          </select>
        </label>
        <label class="field" id="record-length-field" hidden>
          <span>Record length</span>
          <input id="schema-record-length" type="number" min="1" step="1">
        </label>
        <label class="field">
          <span>Skip leading records</span>
          <input id="schema-skip" type="number" min="0" step="1" value="0">
        </label>
      </div>

      <div class="panel-row" id="regex-row">
        <label class="field grow">
          <span>Separator or capture pattern</span>
          <input id="schema-pattern" type="text" spellcheck="false" placeholder="\\s{2,}">
        </label>
        <label class="field">
          <span>Pattern is</span>
          <select id="schema-regex-mode">
            <option value="split">a separator</option>
            <option value="match">a whole-record match</option>
          </select>
        </label>
      </div>

      <div class="panel-row" id="widths-row" hidden>
        <label class="field grow">
          <span>Column widths (comma separated)</span>
          <input id="schema-widths" type="text" spellcheck="false" placeholder="15, 12, 30, 10, 30">
        </label>
      </div>

      <div class="panel-row">
        <label class="field grow">
          <span>Column names (optional, comma separated)</span>
          <input id="schema-names" type="text" spellcheck="false" placeholder="CODE, AMOUNT, DESCRIPTION">
        </label>
        <button id="btn-apply-schema" type="button" class="primary">Apply</button>
      </div>
    </section>

    <section id="ruler-panel" class="panel" hidden>
      <p class="hint">Click the ruler to place or remove a cut. Cuts become column boundaries.</p>
      <div id="ruler-scroll" class="ruler-scroll">
        <div id="ruler-track" class="ruler-track"></div>
        <pre id="ruler-sample" class="ruler-sample"></pre>
      </div>
      <div class="panel-row">
        <span id="ruler-summary" class="stats"></span>
        <span class="spacer"></span>
        <button id="btn-ruler-clear" type="button">Clear cuts</button>
        <button id="btn-ruler-apply" type="button" class="primary">Apply as fixed width</button>
      </div>
    </section>

    <div id="grid-shell" class="grid-shell">
      <div id="grid-header" class="grid-header"></div>
      <div id="grid-filters" class="grid-filters"></div>
      <div id="grid-viewport" class="grid-viewport" tabindex="0">
        <div id="grid-sizer" class="grid-sizer"></div>
        <div id="grid-rows" class="grid-rows"></div>
      </div>
    </div>

    <div id="error-banner" class="error-banner" hidden>
      <span id="error-text"></span>
      <button id="error-dismiss" type="button">Dismiss</button>
    </div>
  </div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
