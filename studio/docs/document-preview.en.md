# File Previews

Opening a PDF, DOCX, PPTX, XLSX or image in Explorer displays a read-only preview in a Studio editor tab, including HEIC / HEIF images. Controls follow the current VS Code theme and display language. No extra preview extension is required.

Open previews update when their source files change, including atomic saves, deletion and recreation, and changes to background tabs. Refreshes retain zoom, scroll position, the current slide and selected worksheet. Split editors are supported. Read failures display an error while retaining the current content; the refresh button retries the read.

PDF previews support page navigation, zoom, selectable text and password-protected documents. DOCX retains pagination and document styles. PPTX fits and centers each slide in the preview area, with a border and themed background, slide navigation and a toolbar button to copy its text. XLSX displays visible worksheets, formatted cells and merged cells; text can be selected and copied. It never evaluates formulas or writes to the source file. Images provide zoom and fit-to-width controls.

`.tex` / `.latex` files open in the LaTeX formula preview by default. To edit the source, select **Text Editor** from **Reopen Editor With** in the tab context menu. The preview renders formulas supported by KaTeX rather than compiling a complete TeX document.

Previews work with ordinary folders and Workflow projects through VS Code's file system API, including remote and virtual workspaces that provide file reads and change notifications. Limits are 50 MB per document, 200 KB for LaTeX, 20,000 rows / 200 columns / 200,000 cells per worksheet, and 64 million pixels for HEIC / HEIF. Convert legacy `.doc`, `.ppt` and `.xls` files to their Office Open XML counterparts first.

Libraries, fonts, the PDF worker, character maps and WebAssembly resources are bundled with the extension and loaded by format. No external preview service receives document content. See [preview libraries and licenses](document-preview-licenses.md).

## Validation

Run daily checks in the background with `npm run check` and `npm run build:extension`. After committing and pushing, run full tests on GitLab's `linux` runner under Xvfb:

```sh
glab ci run --branch <target-branch> --variables STUDIO_FULL_TESTS:1
```

The document preview regression requires `STUDIO_TEST_PREVIEW_FILES` on the runner, pointing to a sample folder containing PDF, DOCX, PPTX, XLSX, TEX and HEIC files. Full tests explicitly skip this suite when samples are unavailable. Tests modify copies of the samples and use a separate user data directory. Do not launch real Electron regressions on the local desktop while it is in use.

Run Simplified Chinese and English regressions separately in the remote Xvfb environment:

```sh
STUDIO_TEST_UI_LANGUAGE=zh-cn npm run test:document-preview-ui
STUDIO_TEST_UI_LANGUAGE=en npm run test:document-preview-ui
```

Screenshots and verification results are written to `.studio/document-preview/<language>/` and saved as CI artifacts by full tests.
