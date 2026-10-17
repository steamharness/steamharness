# Document Preview Libraries

Studio bundles document renderers locally and loads each format on demand. No external viewer service is used. The build includes the upstream license and notice files in `dist/document-preview/licenses/`.

| Library | Version | License | Source |
| --- | --- | --- | --- |
| PDF.js | 6.4.299 | Apache-2.0 | https://github.com/mozilla/pdf.js |
| docx-preview | 0.4.1 | Apache-2.0 | https://github.com/VolodymyrBaydalka/docxjs |
| PptxViewJS | 1.1.9 | MIT | https://www.npmjs.com/package/pptxviewjs |
| SheetJS Community Edition | 0.20.3 | Apache-2.0 | https://git.sheetjs.com/sheetjs/sheetjs |
| KaTeX | 0.19.0 | MIT | https://github.com/KaTeX/KaTeX |
| libheif-js | 1.23.5 | LGPL-3.0 | https://github.com/catdad-experiments/libheif-js |
| libheif | See bundled wasm license | LGPL-3.0 | https://github.com/strukturag/libheif |
| DOMPurify | 3.3.1 | Apache-2.0 OR MPL-2.0 | https://github.com/cure53/DOMPurify |
| JSZip | See dependency lock | MIT OR GPL-3.0 | https://github.com/Stuk/jszip |
| Chart.js | See dependency lock | MIT | https://github.com/chartjs/Chart.js |

The unmodified libheif-js WebAssembly distribution is available at https://registry.npmjs.org/libheif-js/-/libheif-js-1.23.5.tgz. Its source, build scripts, and corresponding libheif source are available from the repositories above. The HEIC decoder is a separate worker module, so a compatible replacement can be bundled through `scripts/document-preview.mjs` without changing Studio's preview host.
