// Glue between pdf.js' stock viewer and the VS Code custom editor.
// Loaded before viewer.mjs so the options below are in place when it starts.

const vscode = acquireVsCodeApi();
const config = JSON.parse(
  document.getElementById('pdf-editor-config').dataset.config
);

// Diagnostics end up in VS Code's "PDF Editor" output channel.
const log = (message) => vscode.postMessage({ type: 'log', message });
window.addEventListener('error', (e) => log(`error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) =>
  log(`unhandled rejection: ${e.reason?.stack ?? e.reason}`)
);

const CURSOR = { select: 0, hand: 1 };
const SCROLL = { vertical: 0, horizontal: 1, wrapped: 2 };
const SPREAD = { none: 0, odd: 1, even: 2 };

document.addEventListener('webviewerloaded', () => {
  const opts = window.PDFViewerApplicationOptions;
  const root = config.pdfjsRoot;
  const { defaults } = config;
  opts.set('disablePreferences', true);
  opts.set('disableHistory', true);
  opts.set('defaultUrl', '');
  opts.set('enableScripting', false);
  opts.set('enableHighlightFloatingButton', true);
  opts.set('workerSrc', `${root}build/pdf.worker.mjs`);
  opts.set('cMapUrl', `${root}web/cmaps/`);
  opts.set('standardFontDataUrl', `${root}web/standard_fonts/`);
  opts.set('wasmUrl', `${root}web/wasm/`);
  opts.set('iccUrl', `${root}web/iccs/`);
  opts.set('cursorToolOnLoad', CURSOR[defaults.cursor] ?? 0);
  opts.set('scrollModeOnLoad', SCROLL[defaults.scrollMode] ?? -1);
  opts.set('spreadModeOnLoad', SPREAD[defaults.spreadMode] ?? -1);
  opts.set('sidebarViewOnLoad', defaults.sidebar ? 1 : 0);
  opts.set('defaultZoomValue', defaults.scale);

  // Must happen before the viewer binds its events: the save button and
  // Cmd/Ctrl+S would otherwise trigger a browser download ("Save As" dialog).
  window.PDFViewerApplication.downloadOrSave = () => {
    // Cmd/Ctrl+S already reaches VS Code's own save keybinding.
    if (!(window.event instanceof KeyboardEvent)) {
      vscode.postMessage({ type: 'save' });
    }
  };
});

// --- Document loading and saving --------------------------------------------

// Undo/redo stays with pdf.js (it merges steps, e.g. strokes into one drawing);
// VS Code only learns that the document became dirty.
function trackModifications(app) {
  const init = app._initializeAnnotationStorageCallbacks;
  app._initializeAnnotationStorageCallbacks = function (pdfDocument) {
    init.call(this, pdfDocument);
    const storage = pdfDocument.annotationStorage;
    const onSetModified = storage.onSetModified;
    storage.onSetModified = () => {
      onSetModified?.();
      vscode.postMessage({ type: 'edit' });
    };
  };
}

// pdf.js only accepts pasted images while an editing tool is active; switch to
// the image tool on the fly so Cmd/Ctrl+V works anywhere.
const STAMP_MODE = 13; // AnnotationEditorType.STAMP
function pasteImagesAnywhere(app) {
  document.addEventListener(
    'paste',
    (event) => {
      const hasImage = [...(event.clipboardData?.items ?? [])].some((item) =>
        item.type.startsWith('image/')
      );
      if (!hasImage || app.pdfViewer.annotationEditorMode !== 0) {
        return;
      }
      event.stopImmediatePropagation();
      event.preventDefault();
      const replay = new DataTransfer();
      for (const item of event.clipboardData.items) {
        const file = item.getAsFile();
        if (file) {
          replay.items.add(file);
        }
      }
      // Paste listeners are installed once editing is enabled.
      const replayPaste = ({ details }) => {
        if (!details.isEditing) {
          return;
        }
        app.eventBus.off('editingstateschanged', replayPaste);
        document.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: replay, bubbles: true })
        );
      };
      app.eventBus.on('editingstateschanged', replayPaste);
      app.eventBus.dispatch('switchannotationeditormode', {
        source: window,
        mode: STAMP_MODE,
      });
    },
    true
  );
}

// Normalize whatever shape the bytes arrive in from the extension host.
function toBytes(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
  }
  if (Array.isArray(data?.data)) {
    return Uint8Array.from(data.data); // serialized Node Buffer
  }
  return Uint8Array.from(Object.values(data ?? {}));
}

// pdf.js would start its worker from a blob that imports pdf.worker.mjs, but
// requests made from inside a worker bypass VS Code's resource service worker
// and never complete. Fetch the script here instead and run it from a blob.
async function createWorkerPort() {
  const response = await fetch(`${config.pdfjsRoot}build/pdf.worker.mjs`);
  const blob = new Blob([await response.text()], { type: 'text/javascript' });
  return new Worker(URL.createObjectURL(blob), { type: 'module' });
}

async function openDocument(app, data) {
  const pdfViewer = app.pdfViewer;
  const previous = app.pdfDocument && {
    scale: pdfViewer.currentScaleValue,
    scrollTop: app.appConfig.viewerContainer.scrollTop,
  };
  log(`opening ${data.length} bytes`);
  const started = Date.now();
  const stalled = setTimeout(() => log('still loading after 10s'), 10000);
  try {
    // Same reason: the worker can't fetch cmaps, fonts, wasm or ICC data itself.
    await app.open({ data, useWorkerFetch: false });
    log(`opened ${app.pagesCount} pages in ${Date.now() - started}ms`);
  } catch (err) {
    log(`open failed: ${err?.stack ?? err}`);
    return;
  } finally {
    clearTimeout(stalled);
  }
  if (previous) {
    app.eventBus.on(
      'pagesloaded',
      () => {
        pdfViewer.currentScaleValue = previous.scale;
        app.appConfig.viewerContainer.scrollTop = previous.scrollTop;
      },
      { once: true }
    );
  }
}

async function getData(app) {
  app.pdfViewer._layerProperties.annotationEditorUIManager?.endCurrentEditing();
  const { annotationStorage } = app.pdfDocument;
  const data =
    annotationStorage.size > 0
      ? await app.pdfDocument.saveDocument()
      : await app.pdfDocument.getData();
  // Re-arm onSetModified so the next change marks the file dirty again.
  annotationStorage.resetModified();
  return data;
}

(async () => {
  // viewer.mjs defines the app once it has executed.
  while (!window.PDFViewerApplication) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const app = window.PDFViewerApplication;
  await app.initializedPromise;

  window.PDFViewerApplicationOptions.set('workerPort', await createWorkerPort());
  trackModifications(app);
  pasteImagesAnywhere(app);

  window.addEventListener('message', async ({ data: msg }) => {
    switch (msg.type) {
      case 'open':
        await openDocument(app, toBytes(msg.data));
        break;
      case 'getData':
        try {
          const data = await getData(app);
          vscode.postMessage({ type: 'data', requestId: msg.requestId, data });
        } catch (err) {
          vscode.postMessage({
            type: 'error',
            requestId: msg.requestId,
            message: String(err?.message ?? err),
          });
        }
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
