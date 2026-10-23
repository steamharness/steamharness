export interface FileIcon { icon: string; type: string }

// Use the bundled Codicons font so attachments also work offline.
const groups = [
  { type: 'document', icon: 'file-text', extensions: 'doc docx docm dot dotx dotm odt ott rtf pages wps txt text log rst adoc asciidoc org' },
  { type: 'spreadsheet', icon: 'table', extensions: 'xls xlsx xlsm xlsb xlt xltx xltm ods ots csv tsv numbers et' },
  { type: 'presentation', icon: 'preview', extensions: 'ppt pptx pptm pot potx potm pps ppsx ppsm odp otp dps' },
  { type: 'pdf', icon: 'file-pdf', extensions: 'pdf' },
  { type: 'markdown', icon: 'markdown', extensions: 'md markdown mdx mdown mkd' },
  { type: 'image', icon: 'file-media', extensions: 'png jpg jpeg jfif gif webp bmp avif svg ico icns heic heif tif tiff raw cr2 nef psd ai eps sketch fig xcf' },
  { type: 'audio', icon: 'music', extensions: 'mp3 wav flac aac m4a ogg opus wma aiff aif mid midi amr alac' },
  { type: 'video', icon: 'device-camera-video', extensions: 'mp4 mov mkv avi webm m4v wmv mpg mpeg m2ts vob flv 3gp' },
  { type: 'archive', icon: 'file-zip', extensions: 'zip rar 7z tar gz tgz bz2 tbz2 xz txz zst lz lzma cab iso dmg' },
  { type: 'javascript', icon: 'file-code', extensions: 'js jsx mjs cjs' },
  { type: 'typescript', icon: 'file-code', extensions: 'ts tsx mts cts' },
  { type: 'python', icon: 'file-code', extensions: 'py pyw pyi pyx' },
  { type: 'code', icon: 'file-code', extensions: 'c h cpp cxx cc hpp hxx cs java kt kts scala sc go rs rb erb php phtml swift m mm dart vue svelte astro lua pl pm r jl ex exs erl hrl hs lhs fs fsx clj cljs cljc el lisp lsp pas vb vbs sol zig nim groovy gradle proto graphql gql asm s smali wasm' },
  { type: 'markup', icon: 'code', extensions: 'html htm xhtml xml xsl xslt xsd dtd wxml axml pug jade hbs handlebars mustache ejs' },
  { type: 'style', icon: 'symbol-color', extensions: 'css scss sass less styl wxss qss' },
  { type: 'json', icon: 'json', extensions: 'json jsonc json5 jsonl ndjson geojson ipynb-meta' },
  { type: 'config', icon: 'settings-gear', extensions: 'yaml yml toml ini cfg conf config properties env editorconfig gitignore gitattributes npmrc nvmrc babelrc eslintrc prettierrc code-workspace' },
  { type: 'script', icon: 'terminal', extensions: 'sh bash zsh fish bat cmd ps1 psm1 psd1' },
  { type: 'database', icon: 'database', extensions: 'sql sqlite sqlite3 db db3 mdb accdb parquet arrow avro h5 hdf5' },
  { type: 'notebook', icon: 'notebook', extensions: 'ipynb' },
  { type: 'formula', icon: 'symbol-numeric', extensions: 'tex latex bib sty cls' },
  { type: 'font', icon: 'text-size', extensions: 'ttf otf woff woff2 eot ttc' },
  { type: 'key', icon: 'key', extensions: 'pem key crt cer p12 pfx pub asc gpg' },
  { type: 'binary', icon: 'file-binary', extensions: 'exe dll so dylib bin dat o obj a lib class pyc pyo' },
  { type: 'package', icon: 'package', extensions: 'apk aab ipa app deb rpm msi msix vsix crx jar war nupkg whl' },
  { type: 'book', icon: 'book', extensions: 'epub mobi azw azw3' },
] as const;
const byExtension = new Map<string, FileIcon>(groups.flatMap(group => group.extensions.split(' ').map(extension => [extension, group] as const)));
const ofType = (type: typeof groups[number]['type']): FileIcon => groups.find(group => group.type === type)!;

export function fileIcon(name: string, mimeType = '', directory = false): FileIcon {
  if (directory) return { icon: 'folder', type: 'folder' };
  const filename = name.split(/[\\/]/).at(-1)!.toLowerCase();
  if (/^(?:dockerfile|makefile|cmakelists\.txt|jenkinsfile|vagrantfile)(?:\.|$)/.test(filename)) return ofType('script');
  if (/^(?:\.?env|\.gitignore|\.gitattributes|\.npmrc|\.nvmrc|\.editorconfig|\.eslintrc|\.prettierrc)(?:\.|$)/.test(filename) || filename.endsWith('.lock')) return ofType('config');
  if (/^(?:readme|license|licence|copying|notice)(?:\.|$)/.test(filename) && !filename.includes('.')) return ofType('book');
  const match = byExtension.get(filename.slice(filename.lastIndexOf('.') + 1));
  if (match) return match;
  if (mimeType.startsWith('image/')) return ofType('image');
  if (mimeType.startsWith('audio/')) return ofType('audio');
  if (mimeType.startsWith('video/')) return ofType('video');
  if (mimeType === 'application/pdf') return ofType('pdf');
  if (/wordprocessingml|msword|opendocument.text/.test(mimeType)) return ofType('document');
  if (/spreadsheetml|excel|opendocument.spreadsheet/.test(mimeType)) return ofType('spreadsheet');
  if (/presentationml|powerpoint|opendocument.presentation/.test(mimeType)) return ofType('presentation');
  if (mimeType.startsWith('text/')) return ofType('document');
  return { icon: 'file', type: 'file' };
}
