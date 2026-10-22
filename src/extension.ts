import * as vscode from 'vscode';
import { PdfEditorProvider } from './pdfProvider';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('PDF Editor', { log: true });
  context.subscriptions.push(
    log,
    vscode.window.registerCustomEditorProvider(
      PdfEditorProvider.viewType,
      new PdfEditorProvider(context.extensionUri, log),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );
}

export function deactivate(): void {}
