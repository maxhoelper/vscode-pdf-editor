import * as vscode from 'vscode';
import { Disposable } from './disposable';

/**
 * The in-memory model of a PDF file. The annotated bytes live in the webview
 * (pdf.js), so this only keeps track of what was last read from / written to disk.
 */
export class PdfDocument extends Disposable implements vscode.CustomDocument {
  static async create(
    uri: vscode.Uri,
    backupId: string | undefined
  ): Promise<PdfDocument> {
    const dataFile = backupId ? vscode.Uri.parse(backupId) : uri;
    const data = await vscode.workspace.fs.readFile(dataFile);
    return new PdfDocument(uri, data, !!backupId);
  }

  private readonly _onDidDispose = this._register(
    new vscode.EventEmitter<void>()
  );
  public readonly onDidDispose = this._onDidDispose.event;

  private constructor(
    public readonly uri: vscode.Uri,
    /** Bytes the webview should open. */
    public data: Uint8Array,
    /** True when restored from a hot-exit backup, i.e. not what's on disk. */
    public readonly restoredFromBackup: boolean
  ) {
    super();
  }

  /** Bytes most recently written by us, used to ignore our own file-watcher events. */
  public lastWritten: Uint8Array | undefined;

  async reloadFromDisk(): Promise<void> {
    this.data = await vscode.workspace.fs.readFile(this.uri);
  }

  async write(target: vscode.Uri, data: Uint8Array): Promise<void> {
    if (target.toString() === this.uri.toString()) {
      this.lastWritten = data;
    }
    await vscode.workspace.fs.writeFile(target, data);
  }

  dispose(): void {
    this._onDidDispose.fire();
    super.dispose();
  }
}
