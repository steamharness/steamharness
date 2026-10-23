import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-file-icons.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
class Uri {
  constructor(path) { this.scheme = 'file'; this.authority = ''; this.path = posix.normalize(path.replaceAll('\\', '/')); }
  static file(path) { return new Uri(path); }
  static joinPath(uri, ...paths) { return new Uri(posix.join(uri.path, ...paths)); }
  toString() { return `file://${this.path}`; }
}
class EventEmitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire = value => { for (const listener of this.listeners) listener(value); };
  dispose() { this.listeners.clear(); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
const resource = (path, kind = 'file') => ({ path, kind });
const theme = {
  fonts: [{ id: 'file-icons', src: [{ path: './file-icons.woff2', format: 'woff2' }], size: '100%' }],
  iconDefinitions: {
    file: { fontCharacter: '\\f001', fontColor: '#777777' }, folder: { fontCharacter: '\\f002' },
    ts: { fontCharacter: '\\2a6', fontColor: '#6a9fb5', fontId: 'file-icons' },
    npm: { fontCharacter: '\\e91c', fontColor: '#ac4142' }, node: { fontCharacter: '\\e618', fontColor: '#90a959' },
    json: { fontCharacter: '\\eabe', fontColor: '#75b5aa' }, tar: { fontCharacter: 'T' },
    special: { fontCharacter: 'S' }, lightTs: { fontCharacter: '\\2a6', fontColor: '#46788d' },
    picture: { iconPath: './picture.svg' }, root: { fontCharacter: 'R' },
  },
  file: 'file', folder: 'folder', rootFolder: 'root',
  fileExtensions: { ts: 'ts', json: 'json', gz: 'file', 'tar.gz': 'tar' },
  fileNames: { 'PACKAGE.JSON': 'npm', 'special/index.ts': 'special' }, folderNames: { node_modules: 'node' },
  languageIds: { json: 'json', custom: 'special' }, light: { file: 'file', fileExtensions: { ts: 'lightTs' } },
};
function fixture(options = {}) {
  const events = Object.fromEntries(['configuration', 'color', 'extensions', 'open', 'close', 'folders'].map(key => [key, new EventEmitter()]));
  const root = new Uri('/extensions/icons'), files = new Map([
    ['/extensions/icons/themes/theme.json', Buffer.from('// installed theme\n' + JSON.stringify(options.theme ?? theme))],
    ['/extensions/icons/themes/file-icons.woff2', Buffer.from('woff2')],
    ['/extensions/icons/themes/picture.svg', Buffer.from('<svg/>')],
  ]);
  const state = { theme: 'file-icons', kind: 2, associations: {}, ...options.state };
  const extensions = [{ extensionUri: root, packageJSON: { contributes: {
    iconThemes: [{ id: 'file-icons', path: './themes/theme.json' }, { id: 'images', path: './themes/images.json' }],
    languages: [{ id: 'typescript', extensions: ['.ts'] }, { id: 'jsonc', filenames: ['tsconfig.json'] },
      { id: 'custom', filenamePatterns: ['*.{custom,odd}'] }],
  } } }];
  const reads = [], replies = [], documents = options.documents ?? [];
  const vscode = {
    Uri, EventEmitter, ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    extensions: { all: extensions, onDidChange: events.extensions.event },
    window: { activeColorTheme: { get kind() { return state.kind; } }, onDidChangeActiveColorTheme: events.color.event },
    workspace: {
      textDocuments: documents, workspaceFolders: [{ uri: Uri.file('/workspace') }],
      fs: { readFile: async uri => { reads.push(uri.path); if (options.read) return options.read(uri, files); const data = files.get(uri.path); if (!data) throw new Error('ENOENT'); return data; } },
      getConfiguration: section => ({ get: key => section === 'workbench' && key === 'iconTheme' ? state.theme : section === 'files' && key === 'associations' ? state.associations : undefined }),
      onDidChangeConfiguration: events.configuration.event, onDidOpenTextDocument: events.open.event,
      onDidCloseTextDocument: events.close.event, onDidChangeWorkspaceFolders: events.folders.event,
    },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name), TextDecoder, Uint8Array, btoa, setTimeout, clearTimeout });
  const icons = new module.exports.ProjectFileIcons(), binding = icons.bind({ postMessage: async message => { replies.push(JSON.parse(JSON.stringify(message))); } });
  let sequence = 0;
  const request = async (resources, id = `icons-${++sequence}`) => {
    assert.equal(binding.receive({ type: 'workflow-file-icons', version: 1, requestId: id, files: resources }), true); await settle();
    return replies.findLast(reply => reply.fileIcons?.requestId === id)?.fileIcons;
  };
  return { icons, binding, request, state, reads, replies, files, events, extensions, documents, dispose: () => { binding.dispose(); icons.dispose(); } };
}

test('uses installed theme glyphs, font data, exact filenames, multi-part extensions and named folders', async t => {
  const f = fixture(); t.after(f.dispose);
  const resources = [resource('/src/INDEX.TS'), resource('/package.json'), resource('/node_modules', 'directory'), resource('/archive.tar.gz'), resource('/special/index.ts'), resource('/tsconfig.json'), resource('/something.odd'), resource('/workspace', 'directory')];
  const result = await f.request(resources);
  assert.deepEqual(result.icons.map(icon => icon.glyph), ['\u02a6', '\ue91c', '\ue618', 'T', 'S', '\ueabe', 'S', 'R']);
  assert.equal(result.icons[0].color, '#6a9fb5'); assert.equal(result.icons[0].size, '100%');
  assert.equal(result.fonts.length, 1); assert.equal(result.fonts[0].src, `data:font/woff2;base64,${Buffer.from('woff2').toString('base64')}`);
  assert.ok(result.icons.every(icon => icon.font === result.fonts[0].id));
  const cached = await f.request([resources[0]]); assert.equal(cached.fonts.length, 0);
  assert.equal(f.reads.filter(path => path.endsWith('theme.json')).length, 1); assert.equal(f.reads.filter(path => path.endsWith('.woff2')).length, 1);
  assert.ok(f.reads.every(path => path.startsWith('/extensions/icons/')));
});

test('shares font payloads across concurrent batches and reuses them after language and color changes', async t => {
  const f = fixture(); t.after(f.dispose);
  const batches = await Promise.all([f.request([resource('/a.ts')]), f.request([resource('/package.json')])]);
  assert.equal(batches.reduce((count, reply) => count + reply.fonts.length, 0), 1);
  f.events.open.fire(); f.events.close.fire(); f.events.color.fire();
  await new Promise(resolve => setTimeout(resolve, 120));
  const result = await f.request([resource('/b.ts')]); assert.equal(result.fonts.length, 0);
  assert.equal(f.reads.filter(path => path.endsWith('theme.json')).length, 1);
  assert.equal(f.reads.filter(path => path.endsWith('.woff2')).length, 1);
});

test('matches parent-qualified extension rules and CSS specificity across light and high-contrast overrides', async t => {
  const document = structuredClone(theme); document.fileExtensions['src/ts'] = 'special'; document.highContrast = { fileExtensions: { ts: 'npm' } };
  const f = fixture({ theme: document, state: { kind: 1 } }); t.after(f.dispose);
  let result = await f.request([resource('/other/index.ts'), resource('/src/index.ts'), resource('/package.json')]);
  assert.equal(result.icons[0].color, '#46788d');
  // Parent-qualified base and light extension selectors have equal specificity; the later definition wins.
  assert.equal(result.icons[1].glyph, '\u02a6'); assert.equal(result.icons[2].glyph, '\ue91c');
  f.state.kind = 3; f.events.color.fire(); await new Promise(resolve => setTimeout(resolve, 120));
  assert.ok(f.replies.some(reply => reply.fileIconsChanged?.version === 1));
  result = await f.request([resource('/other/index.ts')]); assert.equal(result.icons[0].glyph, '\ue91c');
});

test('honors open document languages and configured language globs without reading user files', async t => {
  const f = fixture({ documents: [{ uri: Uri.file('/source/extensionless'), languageId: 'custom' }], state: { associations: { '**/config/*.{data,settings}': 'jsonc' } } }); t.after(f.dispose);
  const result = await f.request([resource('/source/extensionless'), resource('/project/config/a.data'), resource('C:\\work\\index.TS')]);
  assert.deepEqual(result.icons.map(icon => icon.glyph), ['S', '\ueabe', '\u02a6']);
  assert.ok(f.reads.every(path => path.startsWith('/extensions/icons/')));
});

test('supports image and currentColor themes and resends fonts when an iframe reloads', async t => {
  const f = fixture(); t.after(f.dispose); await f.request([resource('/a.ts')]);
  f.binding.receive({ type: 'workflow-frame-ready' });
  assert.equal((await f.request([resource('/a.ts')])).fonts.length, 1);
  f.files.set('/extensions/icons/themes/images.json', Buffer.from(JSON.stringify({ ...theme, fonts: [], usesCurrentColor: true, fileExtensions: { ts: 'picture' } })));
  f.state.theme = 'images'; f.events.configuration.fire({ affectsConfiguration: section => section === 'workbench.iconTheme' });
  await new Promise(resolve => setTimeout(resolve, 120));
  const result = await f.request([resource('/a.ts')]);
  assert.equal(result.fonts.length, 0); assert.equal(result.icons[0].glyph, undefined); assert.equal(result.icons[0].mask, true);
  assert.equal(result.icons[0].image, `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`);
});

test('debounces invalidations and discards outdated theme reads and disposed frame replies', async t => {
  let finish;
  const f = fixture({ read: (uri, files) => uri.path.endsWith('theme.json') ? new Promise(resolve => { finish = () => resolve(files.get(uri.path)); }) : files.get(uri.path) }); t.after(f.dispose);
  const first = f.request([resource('/a.ts')], 'first'); await settle();
  f.events.color.fire(); f.events.extensions.fire(); f.events.open.fire(); finish(); await first;
  assert.equal(f.replies.length, 0); await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(f.replies.length, 1); assert.equal(f.replies[0].fileIconsChanged.version, 1);
  const next = f.request([resource('/a.ts')], 'next'); await settle(); f.binding.dispose(); finish(); await next;
  assert.equal(f.replies.length, 1); assert.equal(f.binding.receive({ type: 'workflow-file-icons', version: 1, requestId: 'closed', files: [] }), false);
});

test('rejects malformed requests and never loads remote or out-of-extension icon assets', async t => {
  const document = structuredClone(theme); document.fonts[0].src[0].path = '../../../private.woff2'; document.iconDefinitions.picture.iconPath = 'https://example.com/icon.svg'; document.fileExtensions.svg = 'picture';
  const f = fixture({ theme: document }); t.after(f.dispose);
  const valid = { type: 'workflow-file-icons', version: 1, requestId: 'valid', files: [resource('/a.ts')] };
  for (const message of [undefined, {}, { ...valid, version: 2 }, { ...valid, requestId: '' }, { ...valid, files: Array(33).fill(resource('/a')) }, { ...valid, files: [resource('/a\nb')] }, { ...valid, files: [{ path: '/a', kind: 'command' }] }]) assert.equal(f.binding.receive(message), false);
  const result = await f.request([resource('/a.ts'), resource('/logo.svg')]); assert.equal(result.fonts.length, 0); assert.equal(result.icons[1].image, undefined);
  assert.ok(f.reads.every(path => path === '/extensions/icons/themes/theme.json'));
});

test('handles missing or disabled themes and read failures as empty icon descriptions', async t => {
  const f = fixture({ state: { theme: null } }); t.after(f.dispose);
  let result = await f.request([resource('/unknown')]); assert.deepEqual(result.icons, [resource('/unknown')]); assert.equal(f.reads.length, 0);
  f.state.theme = 'file-icons'; f.files.clear(); f.events.extensions.fire();
  await new Promise(resolve => setTimeout(resolve, 120));
  result = await f.request([resource('/unknown')]); assert.deepEqual(result.icons, [resource('/unknown')]);
});
