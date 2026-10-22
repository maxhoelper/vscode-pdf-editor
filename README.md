# PDF Editor for VS Code

View **and annotate** PDF files right in VS Code — a fork of
[vscode-pdf](https://github.com/tomoki1207/vscode-pdfviewer) on top of the
current [PDF.js](https://mozilla.github.io/pdf.js/) viewer and its editing tools.

- **Highlight** text (or draw free highlights)
- **Text**: add text boxes anywhere
- **Draw**: freehand ink with color, thickness and opacity
- **Images**: paste with `Cmd/Ctrl+V`, drag & drop, or *Add image*
- Move, resize and delete everything you added; undo/redo with `Cmd/Ctrl+Z`
- Save with `Cmd/Ctrl+S` — annotations are written as standard PDF
  annotations, so they show up (and stay editable) in other PDF apps too.

## Install

Download `pdf-editor-x.y.z.vsix` from the
[latest release](https://github.com/maxhoelper/vscode-pdf-editor/releases/latest)
and run *Extensions: Install from VSIX…* in VS Code (or build it yourself, see below).

## Develop

```sh
npm install
npm run compile      # or: npm run watch, then F5 "Launch Extension"
npm run package      # builds pdf-editor-x.y.z.vsix
```

## How it works

- `src/pdfProvider.ts` – custom editor: loads the file, tracks dirty state,
  saves/backs up/reverts by asking the webview for the current bytes.
- `lib/main.mjs` – glue loaded into PDF.js' stock `viewer.html`: sets viewer
  options, sends "edited" to VS Code, answers save requests via
  `pdfDocument.saveDocument()`.
- `lib/pdfjs/` – unmodified PDF.js release (`pdfjs-x.y.z-dist.zip` minus the
  sample PDF, debugger and source maps).

### Upgrade PDF.js

Replace `lib/pdfjs/` with the `build/` and `web/` folders of a new
`pdfjs-*-dist.zip` release and delete `web/compressed.tracemonkey-pldi-09.pdf`,
`web/debugger.*` and `*.map`. No other changes needed — `viewer.html` is used as is.

## License

MIT, see [LICENSE](./LICENSE). PDF.js is Apache-2.0, see `lib/pdfjs/LICENSE`.
