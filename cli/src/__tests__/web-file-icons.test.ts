import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { fileIcon } from '../web/ui/file-icons';

it('recognizes common document, development, media and system formats using bundled icons', () => {
  const css = readFileSync(createRequire(import.meta.url).resolve('@vscode/codicons/dist/codicon.css'), 'utf8');
  const cases = {
    'report.DOCX': 'document', 'notes.txt': 'document', 'data.xlsx': 'spreadsheet', 'data.csv': 'spreadsheet',
    'slides.pptx': 'presentation', 'slides.odp': 'presentation', 'report.PDF': 'pdf', 'README.md': 'markdown',
    'photo.heic': 'image', 'drawing.svg': 'image', 'sound.flac': 'audio', 'clip.mov': 'video', 'backup.tar.gz': 'archive',
    'app.jsx': 'javascript', 'index.ts': 'typescript', 'app.tsx': 'typescript', 'test.py': 'python',
    'main.rs': 'code', 'Page.vue': 'code', 'index.html': 'markup', 'style.scss': 'style',
    'package.json': 'json', 'data.jsonl': 'json', 'config.yml': 'config', '.env.local': 'config', '.gitignore': 'config',
    'pnpm-lock.yaml': 'config', 'Cargo.lock': 'config', 'Dockerfile.dev': 'script', 'Makefile': 'script', 'install.ps1': 'script',
    'data.sqlite3': 'database', 'data.parquet': 'database', 'analysis.ipynb': 'notebook', 'formula.tex': 'formula',
    'font.woff2': 'font', 'id_rsa.pub': 'key', 'lib.dylib': 'binary', 'extension.vsix': 'package', 'book.epub': 'book',
    LICENSE: 'book', 'unknown.extension': 'file', '__proto__': 'file',
  };
  for (const [name, type] of Object.entries(cases)) {
    const result = fileIcon(name); expect(result.type, name).toBe(type);
    expect(css, result.icon).toContain(`.codicon-${result.icon}:before`);
  }
  expect(fileIcon('C:\\work\\REPORT.DOCX').type).toBe('document');
  expect(fileIcon('/work/data.xlsx').type).toBe('spreadsheet');
  expect(fileIcon('folder.pdf', '', true)).toEqual({ icon: 'folder', type: 'folder' });
});

it('uses MIME information for extensionless uploads and keeps an unknown file fallback', () => {
  for (const [mime, type] of Object.entries({
    'image/png': 'image', 'audio/wav': 'audio', 'video/mp4': 'video', 'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
    'application/vnd.ms-excel': 'spreadsheet', 'application/vnd.ms-powerpoint': 'presentation', 'text/plain': 'document',
    'application/octet-stream': 'file',
  })) expect(fileIcon('upload', mime).type).toBe(type);
});
