/**
 * The custom editor.
 *
 * Implemented as a CustomReadonlyEditorProvider, NOT a CustomTextEditorProvider. The text
 * variant hands the provider a fully materialized TextDocument, meaning VS Code has read
 * the whole file into memory before any of this code runs — which fails at exactly the
 * sizes this extension exists for. The readonly variant hands over the URI and nothing
 * else, leaving every byte of I/O under our control.
 */

import * as vscode from 'vscode';

import { isToHost, sanitizeRange, type ToHost, type ToWebview } from '../shared/protocol.js';
import type { SchemaProfile } from '../shared/schema.js';
import { Session, type SessionSettings } from './Session.js';
import { renderWebviewHtml } from './webviewHtml.js';

/**
 * A CustomDocument that holds no content — only identity and the session that owns the
 * file handle. Everything expensive hangs off `session` and dies with it.
 */
class FwqDocument implements vscode.CustomDocument {
  session: Session | null = null;

  constructor(readonly uri: vscode.Uri) {}

  dispose(): void {
    void this.session?.dispose();
    this.session = null;
  }
}

function readSettings(): SessionSettings {
  const config = vscode.workspace.getConfiguration('fixedWidthQuery');
  return {
    pageSizeBytes: config.get<number>('pageSizeBytes', 1048576),
    pageCacheBytes: config.get<number>('pageCacheBytes', 33554432),
    checkpointStride: config.get<number>('checkpointStride', 4096),
    defaultEncoding: config.get<'utf8' | 'latin1' | 'ascii'>('defaultEncoding', 'latin1'),
    maxQueryResults: config.get<number>('maxQueryResults', 2000000),
    workerHeapMb: config.get<number>('workerHeapMb', 192),
  };
}

export class FixedWidthEditorProvider implements vscode.CustomReadonlyEditorProvider<FwqDocument> {
  static readonly viewType = 'fixedWidthQuery.editor';

  /** The session behind the focused panel, so palette commands know what to act on. */
  private activeSession: Session | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new FixedWidthEditorProvider(context);
    const registration = vscode.window.registerCustomEditorProvider(
      FixedWidthEditorProvider.viewType,
      provider,
      {
        // A hidden tab holding a million-row DOM is pure waste; state is restored from
        // the webview's own persisted scroll position instead.
        webviewOptions: { retainContextWhenHidden: false },
        supportsMultipleEditorsPerDocument: false,
      },
    );
    context.subscriptions.push(provider.registerCommands());
    return registration;
  }

  private registerCommands(): vscode.Disposable {
    const send = (message: ToWebview): void => this.activePost?.(message);
    return vscode.Disposable.from(
      vscode.commands.registerCommand('fixedWidthQuery.focusQueryBar', () => send({ type: 'focusQueryBar' })),
      vscode.commands.registerCommand('fixedWidthQuery.toggleRuler', () => send({ type: 'toggleRuler' })),
      vscode.commands.registerCommand('fixedWidthQuery.goToRow', async () => {
        const answer = await vscode.window.showInputBox({
          prompt: 'Go to row',
          validateInput: (value) => (/^\d+$/.test(value.trim()) ? null : 'Enter a row number.'),
        });
        if (answer) {
          send({ type: 'goToRow', row: Math.max(0, Number(answer.trim()) - 1) });
        }
      }),
      vscode.commands.registerCommand('fixedWidthQuery.saveSchema', () => this.saveSchema()),
      vscode.commands.registerCommand('fixedWidthQuery.saveSchemaAs', () => this.saveSchemaAs()),
      vscode.commands.registerCommand('fixedWidthQuery.loadSchema', () => this.loadSchema()),
      vscode.commands.registerCommand('fixedWidthQuery.exportResult', () => this.exportResult()),
      vscode.commands.registerCommand('fixedWidthQuery.openWith', async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (target) {
          await vscode.commands.executeCommand('vscode.openWith', target, FixedWidthEditorProvider.viewType);
        }
      }),
    );
  }

  private activePost: ((message: ToWebview) => void) | null = null;

  // ------------------------------------------------------------ provider API

  openCustomDocument(uri: vscode.Uri): FwqDocument {
    // Nothing is read here beyond constructing the handle: opening a 50 GB file must cost
    // the same as opening a 50 KB one.
    return new FwqDocument(uri);
  }

  async resolveCustomEditor(
    document: FwqDocument,
    panel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const disposables: vscode.Disposable[] = [];

    panel.webview.options = {
      enableScripts: true,
      // The only directory the page may load anything from.
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
    };
    panel.webview.html = renderWebviewHtml(panel.webview, this.context.extensionUri);

    const post = (message: ToWebview): void => {
      // postMessage on a disposed panel throws; a race with tab closure is normal.
      //
      // Note there is no transfer list here: the VS Code webview API takes the message
      // only. It does serialize Uint8Array natively rather than through JSON, which is the
      // property the binary row envelope actually depends on — the row payload never
      // becomes a string, it just is not zero-copy.
      try {
        void panel.webview.postMessage(message);
      } catch {
        // Panel is gone; the session is being torn down anyway.
      }
    };

    const workerDir = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'workers').fsPath;
    const session = new Session(document.uri, readSettings(), workerDir, post);
    document.session = session;

    try {
      await session.open();
    } catch (error) {
      post({
        type: 'error',
        code: 'FILE_UNREADABLE',
        message: `Cannot open ${document.uri.fsPath}: ${(error as Error).message}`,
      });
      return;
    }

    // The user closed the tab while the file was opening.
    if (token.isCancellationRequested) {
      await session.dispose();
      return;
    }

    this.activeSession = session;
    this.activePost = post;
    void vscode.commands.executeCommand('setContext', 'fixedWidthQuery.editorFocused', true);

    disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        if (!isToHost(raw)) {
          return;
        }
        void this.handleMessage(session, raw, post);
      }),
    );

    disposables.push(
      panel.onDidChangeViewState(() => {
        if (panel.active) {
          this.activeSession = session;
          this.activePost = post;
        }
        void vscode.commands.executeCommand('setContext', 'fixedWidthQuery.editorFocused', panel.active);
      }),
    );

    // External modification invalidates the index; serving stale rows would quietly show
    // the user data that is no longer in the file.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(document.uri, '..'), '*'),
      true,
      false,
      true,
    );
    disposables.push(
      watcher,
      watcher.onDidChange(async (changed) => {
        if (changed.fsPath === document.uri.fsPath && (await session.checkForExternalChange())) {
          post({
            type: 'error',
            code: 'FILE_CHANGED',
            message: 'The file changed on disk. Close and reopen the tab to rebuild the index.',
          });
        }
      }),
    );

    panel.onDidDispose(() => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
      if (this.activeSession === session) {
        this.activeSession = null;
        this.activePost = null;
        void vscode.commands.executeCommand('setContext', 'fixedWidthQuery.editorFocused', false);
      }
      void session.dispose();
    });
  }

  // ------------------------------------------------------------ message routing

  private async handleMessage(
    session: Session,
    message: ToHost,
    post: (message: ToWebview) => void,
  ): Promise<void> {
    switch (message.type) {
      case 'ready': {
        session.sendInit();
        break;
      }

      case 'fetchRows': {
        // Untrusted input: a malformed or oversized range is rejected, never served.
        const range = sanitizeRange(message.range);
        if (!range) {
          return;
        }
        try {
          const payload = await session.fetchRows(range);
          post({ type: 'rows', gen: message.gen, payload });
        } catch (error) {
          post({ type: 'error', code: 'FILE_UNREADABLE', message: (error as Error).message });
        }
        break;
      }

      case 'setSchema': {
        await session.setSchema(message.schema as SchemaProfile);
        break;
      }

      case 'requestSample': {
        const lines = await session.sampleRecords(Math.min(200, Math.max(1, message.rows)));
        post({ type: 'sample', lines });
        break;
      }

      case 'runQuery': {
        session.runSql(message.gen, message.sql);
        break;
      }

      case 'runFilters': {
        session.runFilters(message.gen, message.filters);
        break;
      }

      case 'cancel': {
        session.cancelQuery(message.gen);
        break;
      }

      case 'clearResult': {
        session.clearResult();
        post({ type: 'resultCleared' });
        post({ type: 'meta', meta: session.meta });
        break;
      }

      case 'saveSchema': {
        await this.saveSchema();
        break;
      }

      case 'saveSchemaAs': {
        await this.saveSchemaAs();
        break;
      }

      case 'loadSchema': {
        await this.loadSchema();
        break;
      }

      case 'exportResult': {
        await this.exportResult();
        break;
      }

      case 'log': {
        console.log('[fwq webview]', message.message);
        break;
      }
    }
  }

  // ------------------------------------------------------------ commands

  private async saveSchema(): Promise<void> {
    const session = this.activeSession;
    if (!session) {
      return;
    }
    try {
      const target = await session.saveSchemaProfile();
      void vscode.window.showInformationMessage(`Schema profile saved to ${target}`);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not save the schema profile: ${(error as Error).message}`);
    }
  }

  /** Save the current layout anywhere, so it can be shared or reused across files. */
  private async saveSchemaAs(): Promise<void> {
    const session = this.activeSession;
    if (!session) {
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(session.profilePath ?? `${session.uri.fsPath}.fwq.json`),
      filters: { 'Schema profile': ['json'] },
      saveLabel: 'Save profile',
    });
    if (!target) {
      return;
    }
    try {
      await session.saveSchemaProfileTo(target.fsPath);
      void vscode.window.showInformationMessage(`Schema profile saved to ${target.fsPath}`);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not save the schema profile: ${(error as Error).message}`);
    }
  }

  /** Apply a profile authored against a different file with the same layout. */
  private async loadSchema(): Promise<void> {
    const session = this.activeSession;
    if (!session) {
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      defaultUri: vscode.Uri.joinPath(session.uri, '..'),
      canSelectMany: false,
      filters: { 'Schema profile': ['json'] },
      openLabel: 'Apply profile',
    });
    const source = picked?.[0];
    if (source) {
      await session.applyProfileFrom(source.fsPath);
    }
  }

  private async exportResult(): Promise<void> {
    const session = this.activeSession;
    if (!session) {
      return;
    }
    if (!session.hasResult) {
      void vscode.window.showWarningMessage('Run a query first: export writes the current result, not the whole file.');
      return;
    }

    const target = await vscode.window.showSaveDialog({
      filters: { 'CSV': ['csv'], 'JSON Lines': ['jsonl'] },
      saveLabel: 'Export',
    });
    if (!target) {
      return;
    }
    const format = target.fsPath.toLowerCase().endsWith('.jsonl') ? 'jsonl' : 'csv';

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Exporting result', cancellable: true },
      async (_progress, token) => {
        try {
          const rows = await session.exportResult(target, format, token);
          void vscode.window.showInformationMessage(`Exported ${rows.toLocaleString()} rows to ${target.fsPath}`);
        } catch (error) {
          void vscode.window.showErrorMessage(`Export failed: ${(error as Error).message}`);
        }
      },
    );
  }
}
