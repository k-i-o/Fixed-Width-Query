/**
 * Activation entry point.
 *
 * Nothing expensive happens here. Activation is driven entirely by the customEditors
 * contribution, so opening VS Code with this extension installed costs a single class
 * instantiation until the user actually opens a file with it.
 */

import * as vscode from 'vscode';
import { FixedWidthEditorProvider } from './FixedWidthEditorProvider.js';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(FixedWidthEditorProvider.register(context));
}

export function deactivate(): void {
  // Sessions are disposed through the panel lifecycle, which VS Code drives on shutdown.
}
