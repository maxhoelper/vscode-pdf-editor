import * as vscode from 'vscode';
import { PdfDocument } from './pdfDocument';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'edit' }
  | { type: 'save' }
  | { type: 'log'; message: string }
  | { type: 'data'; requestId: number; data: Uint8Array }
  | { type: 'error'; requestId: number; message: string };

export class PdfEditorProvider
  implements vscode.CustomEditorProvider<PdfDocument>
{
  public static readonly viewType = 'pdfEditor.editor';

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<PdfDocument>
  >();
  public readonly onDidChangeCustomDocument =
    this._onDidChangeCustomDocument.event;

  private readonly webviews = new Map<PdfDocument, vscode.WebviewPanel>();
  private readonly pendingRequests = new Map<
    number,
    { resolve: (data: Uint8Array) => void; reject: (err: Error) => void }
  >();
  private nextRequestId = 1;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel
  ) {}

  async openCustomDocument(
    uri: vscode.Uri,
    context: vscode.CustomDocumentOpenContext
  ): Promise<PdfDocument> {
    return PdfDocument.create(uri, context.backupId);
  }

  async resolveCustomEditor(
    document: PdfDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    this.webviews.set(document, panel);
    panel.onDidDispose(() => this.webviews.delete(document));

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'lib')],
    };
    panel.webview.html = await this.getHtml(panel.webview);

    panel.webview.onDidReceiveMessage((msg: WebviewMessage) =>
      this.onMessage(document, panel, msg)
    );

    // A restored backup has unsaved changes that are baked into its bytes.
    if (document.restoredFromBackup) {
      this._onDidChangeCustomDocument.fire({ document });
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.joinPath(document.uri, '..'),
        document.uri.path.split('/').pop()!
      )
    );
    watcher.onDidChange(() => this.onFileChanged(document, panel));
    watcher.onDidDelete(() => panel.dispose());
    panel.onDidDispose(() => watcher.dispose());
  }

  private onMessage(
    document: PdfDocument,
    panel: vscode.WebviewPanel,
    msg: WebviewMessage
  ): void {
    switch (msg.type) {
      case 'ready':
        this.log.info(`${document.uri.path.split('/').pop()}: webview ready`);
        this.postOpen(panel, document.data);
        break;
      case 'edit':
        this._onDidChangeCustomDocument.fire({ document });
        break;
      case 'log':
        this.log.info(`${document.uri.path.split('/').pop()}: ${msg.message}`);
        break;
      case 'save':
        vscode.commands.executeCommand('workbench.action.files.save');
        break;
      case 'data':
        this.pendingRequests
          .get(msg.requestId)
          ?.resolve(new Uint8Array(msg.data));
        this.pendingRequests.delete(msg.requestId);
        break;
      case 'error':
        this.pendingRequests
          .get(msg.requestId)
          ?.reject(new Error(msg.message));
        this.pendingRequests.delete(msg.requestId);
        break;
    }
  }

  private async onFileChanged(
    document: PdfDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    const onDisk = await vscode.workspace.fs.readFile(document.uri);
    if (document.lastWritten && sameBytes(onDisk, document.lastWritten)) {
      return; // our own save
    }
    // Changed outside of VS Code: reload, unless that would throw away unsaved
    // annotations (VS Code then reports the conflict on the next save).
    if (!this.isDirty(document)) {
      document.data = onDisk;
      this.postOpen(panel, onDisk);
    }
  }

  private isDirty(document: PdfDocument): boolean {
    return vscode.window.tabGroups.all.some((g) =>
      g.tabs.some(
        (t) =>
          t.isDirty &&
          t.input instanceof vscode.TabInputCustom &&
          t.input.uri.toString() === document.uri.toString()
      )
    );
  }

  private postOpen(panel: vscode.WebviewPanel, data: Uint8Array): void {
    // Copy into a plain Uint8Array: Node Buffers don't survive postMessage intact.
    panel.webview.postMessage({ type: 'open', data: new Uint8Array(data) });
  }

  private requestData(document: PdfDocument): Promise<Uint8Array> {
    const panel = this.webviews.get(document);
    if (!panel) {
      return Promise.resolve(document.data);
    }
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      panel.webview.postMessage({ type: 'getData', requestId });
    });
  }

  async saveCustomDocument(document: PdfDocument): Promise<void> {
    await this.saveCustomDocumentAs(document, document.uri);
  }

  async saveCustomDocumentAs(
    document: PdfDocument,
    destination: vscode.Uri
  ): Promise<void> {
    await document.write(destination, await this.requestData(document));
  }

  async revertCustomDocument(document: PdfDocument): Promise<void> {
    await document.reloadFromDisk();
    const panel = this.webviews.get(document);
    if (panel) {
      this.postOpen(panel, document.data);
    }
  }

  async backupCustomDocument(
    document: PdfDocument,
    context: vscode.CustomDocumentBackupContext
  ): Promise<vscode.CustomDocumentBackup> {
    await document.write(context.destination, await this.requestData(document));
    return {
      id: context.destination.toString(),
      delete: () =>
        vscode.workspace.fs.delete(context.destination).then(undefined, () => {}),
    };
  }

  private async getHtml(webview: vscode.Webview): Promise<string> {
    const lib = vscode.Uri.joinPath(this.extensionUri, 'lib');
    const res = (...p: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(lib, ...p)).toString();

    const config = vscode.workspace.getConfiguration('pdf-editor');
    const settings = {
      pdfjsRoot: res('pdfjs', '/'),
      defaults: {
        cursor: config.get<string>('default.cursor'),
        scale: config.get<string>('default.scale'),
        sidebar: config.get<boolean>('default.sidebar'),
        scrollMode: config.get<string>('default.scrollMode'),
        spreadMode: config.get<string>('default.spreadMode'),
      },
    };

    const csp = webview.cspSource;
    const head = `
<base href="${res('pdfjs', 'web', '/')}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${csp} 'wasm-unsafe-eval'; worker-src ${csp} blob:; style-src ${csp}; img-src ${csp} blob: data:; media-src blob:; font-src ${csp} data:; connect-src ${csp} blob: data:; base-uri ${csp}; form-action 'none';">
<meta id="pdf-editor-config" data-config="${escapeAttribute(JSON.stringify(settings))}">
<link rel="stylesheet" href="${res('vscode.css')}">
<script type="module" src="${res('main.mjs')}"></script>`;

    // Use pdf.js' stock viewer.html so upgrading pdf.js is a drop-in replacement.
    const viewerHtml = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(lib, 'pdfjs', 'web', 'viewer.html')
      )
    );
    return viewerHtml
      .replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '')
      .replace(/<head>/i, `<head>${head}`);
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(b);
}
