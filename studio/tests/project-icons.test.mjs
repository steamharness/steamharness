import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { projectTypeIcons } from '../extensions/studio-workstation/src/projects.ts';
import { studioProjectIcon } from '../upstream/vscode/src/vs/workbench/common/studioProjectIcons.ts';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/project-icons.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const id = '294b1eec-23fa-42cf-9fd3-2417f71c0570';
const manifest = (type, identity = id) => JSON.stringify({ id: identity, steamHarness: { projectType: type } });
const executor = type => `throw new Error('Must never execute'); export const executor = steamharness.defineExecutor({ projectType: '${type}' });`;
class Emitter {
  listeners = new Set();
  event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; };
  fire(value) { for (const callback of this.listeners) { callback(value); } }
  dispose() { this.listeners.clear(); }
}

function fixture(t) {
  const files = new Map(), failures = new Map(), reads = [], changed = new Emitter(), focus = new Emitter();
  const uri = value => ({ toString: () => value, scheme: new URL(value).protocol.slice(0, -1), path: new URL(value).pathname });
  const vscode = {
    EventEmitter: Emitter, FileType: { File: 1, Directory: 2 },
    Uri: { parse: uri, joinPath: (root, name) => uri(`${root.toString()}/${name}`) },
    workspace: {
      createFileSystemWatcher: () => ({ onDidChange: changed.event, onDidCreate: changed.event, onDidDelete: changed.event, dispose() {} }),
      fs: {
        stat: async target => {
          const name = target.toString();
          if (failures.has(name)) { throw failures.get(name); }
          if (!files.has(name)) { throw Object.assign(new Error('Not found'), { code: 'FileNotFound' }); }
          return { size: files.get(name).length };
        },
        readFile: async target => { const name = target.toString(); reads.push(name); return new TextEncoder().encode(files.get(name)); },
        readDirectory: async target => {
          const prefix = `${target.toString()}/`, children = new Map();
          for (const name of files.keys()) {
            if (name.startsWith(prefix)) { const parts = name.slice(prefix.length).split('/'); children.set(parts[0], parts.length === 1 ? 1 : 2); }
          }
          return [...children];
        },
      },
    },
    window: { onDidChangeWindowState: focus.event },
  };
  const module = { exports: {} }, launcher = { analyzeProjectType: async sources => {
    const declared = new Map(['workflow', 'conversation'].map(type => [executor(type), type]));
    const types = new Set(sources.map(source => declared.get(source.text)).filter(Boolean));
    return types.size === 1 ? [...types][0] : undefined;
  } };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: () => vscode, TextDecoder, Date, SyntaxError, setTimeout, clearTimeout });
  const icons = new module.exports.ProjectIcons(launcher);
  t.after(() => icons.dispose());
  const types = async (...uris) => Object.fromEntries((await icons.resolveMany(uris)).map(result => [result.uri, result.projectType]));
  return { files, failures, reads, icons, types, launcher, change: name => changed.fire(uri(name)), focus: () => focus.fire({ focused: true }) };
}

test('native and extension project icons share the existing template glyphs', () => {
  assert.deepEqual(Object.fromEntries(Object.keys(projectTypeIcons).map(type => [type, studioProjectIcon(type)])), projectTypeIcons);
  assert.equal(studioProjectIcon('__proto__'), undefined);
});

test('icons pass nested source declarations to the analyzer without running project code or requiring its dependencies', async t => {
  const f = fixture(t);
  for (const type of ['workflow', 'conversation', 'kanban']) {
    f.files.set(`file:///${type}/package.json`, manifest(type === 'kanban' ? type : undefined));
    f.files.set(`file:///${type}/src/main.ts`, executor(type));
  }
  assert.deepEqual(await f.types('file:///workflow', 'file:///conversation', 'file:///kanban'), {
    'file:///workflow': 'workflow', 'file:///conversation': 'conversation', 'file:///kanban': 'kanban',
  });
  assert.equal(f.reads.some(name => name.startsWith('file:///kanban/') && name.endsWith('.ts')), false);
  f.files.set('vscode-remote://host/project/package.json', manifest());
  f.files.set('vscode-remote://host/project/index.ts', executor('conversation'));
  assert.deepEqual(await f.types('vscode-remote://host/project'), { 'vscode-remote://host/project': 'conversation' });
});

test('static manifest versions appear in recent-project metadata and refresh independently of type', async t => {
  const f = fixture(t);
  f.files.set('file:///board/package.json', JSON.stringify({ id, version: '1.0.0', steamHarness: { projectType: 'kanban' } }));
  assert.equal((await f.icons.resolveMany(['file:///board']))[0].version, '1.0.0');
  assert.equal(f.icons.getVersion('file:///board'), '1.0.0');
  f.files.set('file:///board/package.json', JSON.stringify({ id, version: '1.1.0', steamHarness: { projectType: 'kanban' } }));
  f.icons.refresh();
  assert.equal((await f.icons.resolveMany(['file:///board']))[0].version, '1.1.0');
});

test('ordinary folders, broken declarations, misleading strings and conflicting types keep their default icons', async t => {
  const f = fixture(t);
  f.files.set('file:///ordinary/package.json', manifest(undefined, 'not-a-project'));
  f.files.set('file:///ordinary/index.ts', executor('workflow'));
  f.files.set('file:///broken/package.json', '{');
  f.files.set('file:///text/package.json', manifest());
  f.files.set('file:///text/index.ts', '// steamharness.defineExecutor({ projectType: "conversation" })\nconst text = "projectType: workflow";');
  f.files.set('file:///conflict/package.json', manifest());
  f.files.set('file:///conflict/a.ts', executor('workflow'));
  f.files.set('file:///conflict/b.ts', executor('conversation'));
  const uris = ['file:///ordinary', 'file:///broken', 'file:///text', 'file:///conflict', 'file:///missing', 'file:///test.code-workspace', 'https://example.com', 'command:run'];
  assert.deepEqual(await f.types(...uris), Object.fromEntries(uris.map(uri => [uri, undefined])));
});

test('project avatars refresh when only projectCard colors change and ignore image URLs', async t => {
  const f = fixture(t), root = 'file:///board';
  const card = { icon: 'database', iconColor: '#112233', iconBackgroundColor: '#aabbcc', iconUrl: 'https://example.com/private.png' };
  const pkg = { id, steamHarness: { projectType: 'kanban', projectCard: card } };
  f.files.set(`${root}/package.json`, JSON.stringify(pkg));
  const first = (await f.icons.resolveMany([root]))[0].avatarUrl;
  assert.match(decodeURIComponent(first), /stroke="#112233"/);
  assert.doesNotMatch(decodeURIComponent(first), /example.com/);
  pkg.steamHarness.projectCard.iconColor = '#334455';
  f.files.set(`${root}/package.json`, JSON.stringify(pkg)); f.icons.refresh();
  const second = (await f.icons.resolveMany([root]))[0].avatarUrl;
  assert.notEqual(first, second);
  assert.match(decodeURIComponent(second), /stroke="#334455"/);
  assert.equal(f.icons.getAvatarUrl(root), second);
});

test('parallel requests share reads; refresh preserves the last icon on transient failure and clears removed declarations', async t => {
  const f = fixture(t), root = 'file:///project', pkg = `${root}/package.json`;
  f.files.set(pkg, manifest('kanban'));
  await Promise.all([f.types(root), f.types(root)]);
  assert.equal(f.reads.length, 1);
  f.failures.set(pkg, new Error('Temporarily unavailable')); f.icons.refresh();
  assert.deepEqual(await f.types(root), { [root]: 'kanban' });
  f.failures.clear(); f.files.set(pkg, manifest()); f.files.set(`${root}/index.ts`, executor('conversation')); f.focus();
  assert.deepEqual(await f.types(root), { [root]: 'conversation' });
  f.files.delete(pkg); f.change(pkg);
  assert.deepEqual(await f.types(root), { [root]: undefined });
});

test('stale analysis cannot replace newer declarations and generated/dependency sources are ignored', async t => {
  const f = fixture(t), root = 'file:///project';
  f.files.set(`${root}/package.json`, manifest()); f.files.set(`${root}/index.ts`, executor('workflow'));
  for (const folder of ['node_modules', 'dist', '.git', 'vendor', 'upstream']) { f.files.set(`${root}/${folder}/conflict.ts`, executor('conversation')); }
  let release, started;
  const ready = new Promise(resolve => { started = resolve; }), original = f.launcher.analyzeProjectType;
  f.launcher.analyzeProjectType = async sources => { started(); return new Promise(resolve => { release = () => resolve(original(sources)); }); };
  const previous = f.types(root); await ready;
  f.launcher.analyzeProjectType = original; f.files.set(`${root}/index.ts`, executor('conversation')); f.icons.refresh();
  assert.deepEqual(await f.types(root), { [root]: 'conversation' }); release(); await previous;
  assert.equal(f.icons.get(root), 'conversation');
  assert.deepEqual(f.reads.filter(name => name.endsWith('.ts')), [`${root}/index.ts`, `${root}/index.ts`]);
});
