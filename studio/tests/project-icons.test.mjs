import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { runInNewContext } from 'node:vm';
import { applyRecentMetadata, projectTypeIcons, rememberProjects } from '../extensions/studio-workstation/src/projects.ts';
import { studioProjectCardIcon, studioProjectGlyphMask, studioProjectIcon } from '../upstream/vscode/src/vs/workbench/common/studioProjectIcons.ts';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/project-icons.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const id = '294b1eec-23fa-42cf-9fd3-2417f71c0570';
const declaration = (type = 'workflow', identity = id) => ({ id: identity, name: 'Example', version: "0.1.0",  defaultEntry: 'main', entries: [{ entryId: 'main', type, name: 'Main', root: '.', entry: type === 'kanban' ? 'index.html' : 'index.ts' }]  });
const manifest = (type, identity = id) => JSON.stringify(declaration(type, identity));
const executor = type => `throw new Error('Must never execute'); export const executor = steamharness.defineExecutor({ projectType: '${type}' });`;
class Emitter {
  listeners = new Set();
  event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; };
  fire(value) { for (const callback of this.listeners) { callback(value); } }
  dispose() { this.listeners.clear(); }
}

function fixture(t, history = [], imports = []) {
  const files = new Map(), failures = new Map(), reads = [], changed = new Emitter(), focus = new Emitter();
  const uri = value => ({ toString: () => value, scheme: new URL(value).protocol.slice(0, -1), path: new URL(value).pathname });
  const vscode = {
    env: { language: 'en' },
    EventEmitter: Emitter, FileType: { File: 1, Directory: 2 },
    Uri: { parse: uri, joinPath: (root, ...names) => uri(`${root.toString()}/${names.join('/')}`) },
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
    const declared = new Map(['workflow', 'bot'].map(type => [executor(type), type]));
    const types = new Set(sources.map(source => declared.get(source.text)).filter(Boolean));
    return types.size === 1 ? [...types][0] : undefined;
  } };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: () => vscode, TextDecoder, URL, Date, SyntaxError, setTimeout, clearTimeout });
  const icons = new module.exports.ProjectIcons(launcher, undefined, history, () => imports);
  t.after(() => icons.dispose());
  const types = async (...uris) => Object.fromEntries((await icons.resolveMany(uris)).map(result => [result.uri, result.projectType]));
  return { files, failures, reads, icons, types, launcher, vscode, change: name => changed.fire(uri(name)), focus: () => focus.fire({ focused: true }) };
}

test('native and extension project icons share the existing template glyphs', () => {
  assert.deepEqual(Object.fromEntries(Object.keys(projectTypeIcons).map(type => [type, studioProjectIcon(type)])), projectTypeIcons);
  assert.equal(projectTypeIcons.bot, 'steamharness-bot');
  assert.equal(studioProjectIcon('__proto__'), undefined);
});

test('product UI sources do not select the legacy Hubot glyph', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const extension = path.join(root, 'studio/extensions/studio-workstation');
  const workbench = path.join(root, 'studio/upstream/vscode/src/vs/workbench');
  const directories = [path.join(root, 'cli/src/web'), path.join(extension, 'src'), path.join(extension, 'webview'), workbench];
  const files = [path.join(extension, 'package.json')];
  for (const directory of directories) {
    for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:ts|js|json|css|html)$/u.test(entry.name)) { continue; }
      const file = path.join(entry.parentPath, entry.name);
      if (directory !== workbench || path.relative(workbench, file).split(path.sep).some(segment => /^studio[A-Z-]/u.test(segment))) { files.push(file); }
    }
  }
  const offenders = (await Promise.all(files.map(async file => /\bhubot\b/iu.test(await readFile(file, 'utf8')) ? path.relative(root, file) : undefined))).filter(Boolean);
  assert.deepEqual(offenders, []);
});

test('project identity surfaces share the Lucide card glyphs instead of legacy codicons', () => {
  const glyphs = Object.fromEntries(['workflow', 'bot', 'kanban'].map(type => [type, decodeURIComponent(studioProjectCardIcon(type))]));
  assert.match(glyphs.workflow, /viewBox="0 0 64 64"/);
  assert.match(glyphs.bot, /viewBox="0 0 64 64"/);
  assert.match(glyphs.kanban, /viewBox="0 0 64 64"/);
  assert.match(glyphs.workflow, /rect/);
  assert.match(glyphs.bot, /M12 8V4H8/);
  assert.match(glyphs.kanban, /M12 13.5V19/);
  assert.equal(studioProjectCardIcon('__proto__'), undefined);
  assert.equal(studioProjectCardIcon('aggregate'), undefined);
});

test('the monochrome Bot mask uses the project card glyph without its tile', t => {
  const svg = uri => {
    const { window } = new JSDOM(decodeURIComponent(uri.split(',')[1]), { contentType: 'image/svg+xml' });
    t.after(() => window.close());
    return window.document.documentElement;
  };
  const mask = svg(studioProjectGlyphMask('bot'));
  const glyph = svg(studioProjectCardIcon('bot')).querySelector('g');
  assert.equal(mask.getAttribute('viewBox'), '0 0 24 24');
  assert.equal(mask.getAttribute('fill'), 'none');
  assert.deepEqual(Array.from(mask.children, node => node.outerHTML), Array.from(glyph.children, node => node.outerHTML));
  assert.equal(studioProjectGlyphMask('__proto__'), undefined);
});

test('a Bot workspace without an avatar uses the same project card icon as a Bot project', async t => {
  const bundle = await build({ entryPoints: ['upstream/vscode/src/vs/workbench/browser/studioProjectDetails.ts'], bundle: true,
    format: 'iife', globalName: 'studioDetails', loader: { '.css': 'empty' }, write: false });
  const { window } = new JSDOM('', { runScripts: 'outside-only' });
  t.after(() => window.close());
  const { projectMark, projectDetails } = window.eval(`${bundle.outputFiles[0].text}\nstudioDetails`);
  const bot = { kind: 'workspace', projectType: 'bot', uri: 'file:///bot.code-workspace', name: 'Bot', path: '/folder' };
  const standardAvatar = studioProjectCardIcon('bot');
  assert.equal(projectMark(bot).getAttribute('src'), standardAvatar);
  assert.equal(projectDetails(bot, en => en, { actions: [] }).querySelector('.lp-detail-mark img')?.getAttribute('src'), standardAvatar);
  const customAvatar = studioProjectCardIcon('workflow');
  assert.equal(projectMark({ ...bot, avatarUrl: customAvatar }).getAttribute('src'), customAvatar);
  assert.ok(projectMark({ kind: 'folder' }).classList.contains('codicon-folder'));
  assert.ok(projectMark({ kind: 'workspace' }).classList.contains('codicon-project'));
});

test('the kernel and shared project avatars stay byte-identical for every project type', async () => {
  const bundle = await build({ entryPoints: ['../shared/project-card-metadata/avatar.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
  const module = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  for (const type of ['workflow', 'bot', 'kanban']) {
    assert.equal(studioProjectCardIcon(type), module.projectAvatarDataUrl(undefined, type));
  }
  const contents = svg => svg.slice(svg.indexOf('>') + 1, -'</svg>'.length);
  assert.equal(contents(module.projectBotGlyphSvg()), contents(decodeURIComponent(studioProjectGlyphMask('bot'))));
});

test('icons read the default registered entry without analyzing or executing project code', async t => {
  const f = fixture(t);
  f.launcher.analyzeProjectType = () => { throw new Error('Static manifests must not execute an analyzer'); };
  for (const type of ['workflow', 'bot', 'kanban']) {
    f.files.set(`file:///${type}/steamharness.json`, manifest(type));
    f.files.set(`file:///${type}/src/main.ts`, executor(type));
  }
  assert.deepEqual(await f.types('file:///workflow', 'file:///bot', 'file:///kanban'), {
    'file:///workflow': 'workflow', 'file:///bot': 'bot', 'file:///kanban': 'kanban',
  });
  const aggregate = declaration('workflow');
  aggregate.entries.push({ entryId: 'chat', root: 'chat' });
  f.files.set('vscode-remote://host/project/chat/steamharness.json', JSON.stringify({type:'bot', name:'Chat',entry:'index.ts'}));
  aggregate.defaultEntry = 'chat';
  f.files.set('vscode-remote://host/project/steamharness.json', JSON.stringify(aggregate));
  assert.deepEqual(await f.types('vscode-remote://host/project'), { 'vscode-remote://host/project': 'bot' });
  assert.equal(f.reads.some(name => name.endsWith('.ts')), false);
});

test('static manifest versions appear in recent-project metadata and refresh independently of type', async t => {
  const f = fixture(t);
  f.files.set('file:///board/steamharness.json', JSON.stringify({ ...declaration('kanban'), version: '1.0.0' }));
  assert.equal((await f.icons.resolveMany(['file:///board']))[0].version, '1.0.0');
  assert.equal(f.icons.getVersion('file:///board'), '1.0.0');
  f.files.set('file:///board/steamharness.json', JSON.stringify({ ...declaration('kanban'), version: '1.1.0' }));
  f.icons.refresh();
  assert.equal((await f.icons.resolveMany(['file:///board']))[0].version, '1.1.0');
});

test('local entries retain their icons without a release UUID', async t => {
  const f = fixture(t);
  for (const type of ['workflow', 'bot', 'kanban']) {
    for (const identity of [undefined, 'local-draft']) {
      const root = `file:///${type}-${identity ?? 'no-id'}`, pkg = declaration(type);
      pkg.id = identity;
      f.files.set(`${root}/steamharness.json`, JSON.stringify(pkg));
      assert.deepEqual(await f.types(root), { [root]: type });
    }
  }
});

test('default Bot projects have stable colors and share their library avatar with the primary artwork', async t => {
  const f = fixture(t);
  const a = 'file:///first', copy = 'file:///copy', b = 'file:///second';
  for (const root of [a, copy]) f.files.set(`${root}/steamharness.json`, manifest('bot'));
  f.files.set(`${b}/steamharness.json`, manifest('bot', id.replace(/0$/, '1')));
  const rows = new Map((await f.icons.resolveMany([a, copy, b])).map(row => [row.uri, row]));
  assert.equal(rows.get(a).avatarUrl, rows.get(copy).avatarUrl);
  assert.notEqual(rows.get(a).avatarUrl, rows.get(b).avatarUrl);
  for (const row of rows.values()) assert.equal(row.artwork.entries[0], row.avatarUrl);
});

test('an aggregate uses its custom project card in the library, or the primary Bot card if not set', async t => {
  const f = fixture(t);
  const root = 'file:///aggregate';
  const pkg = { ...declaration(), defaultEntry: 'agent' };
  pkg.entries.push({ entryId: 'agent', root: 'agent' });
  f.files.set(`${root}/agent/steamharness.json`, JSON.stringify({ type: 'bot', name: 'Agent', entry: 'index.ts',
    projectCard: { icon: 'brain', iconBackgroundColor: '#321954', iconColor: '#f2e3ca' } }));
  f.files.set(`${root}/steamharness.json`, JSON.stringify(pkg));
  let [row] = await f.icons.resolveMany([root]);
  assert.match(decodeURIComponent(row.avatarUrl), /fill="#321954".*stroke="#f2e3ca"/);
  assert.equal(row.artwork.entries[1], row.avatarUrl);
  f.files.set(`${root}/steamharness.json`, JSON.stringify({ ...pkg, projectCard: { icon: 'cpu', iconBackgroundColor: '#152035' } }));
  f.icons.refresh();
  [row] = await f.icons.resolveMany([root]);
  assert.match(decodeURIComponent(row.avatarUrl), /fill="#152035"/);
  assert.equal(row.artwork.entries[1], row.avatarUrl);
});

test('library format repairs an old download badge for locally created source without reclassifying installed artifacts', async t => {
  const root = 'file:///projects/source', entry = { id, uri:root, name:'Example' }, source = { ...declaration('bot'), release:{files:['data/example.json']} };
  const history = [{ uri:root, label:entry.name, kind:'folder', lastOpened:1, projectType:'bot', projectId:id, distribution:'download' }];
  const imports = [entry], f = fixture(t, history, imports);
  f.files.set(`${root}/steamharness.json`,JSON.stringify(source));
  const updates = new Promise(resolve=>f.icons.onDidChange(resolve));
  const detect = async () => { f.icons.refresh(); return (await f.icons.resolveMany([root]))[0]; };
  const result = await detect(); assert.equal(result.distribution,'source');
  assert.deepEqual(JSON.parse(JSON.stringify(result.entries)),[{entryId:'main',name:'Main',type:'bot',primary:true}]);
  assert.equal(applyRecentMetadata(history,await updates)[0].distribution,'source','the corrected format survives a restart');
  imports[0] = {...entry,version:'0.0.1'}; assert.equal((await detect()).distribution,'source');
  imports[0] = {...entry,version:source.version}; assert.equal((await detect()).distribution,'download');
  imports.length = 0;
  f.files.set(`${root}/.steamharness/download.json`,JSON.stringify({kind:'steamharness.download',version:1,projectId:id,projectVersion:source.version}));
  assert.equal((await detect()).distribution,'download');
  f.files.delete(`${root}/.steamharness/download.json`);
  f.files.set(`${root}/steamharness.json`,JSON.stringify({...declaration('bot'),distribution:{kind:'release',version:1}}));
  assert.equal((await detect()).distribution,undefined,'an incomplete release must not be advertised as runnable in Steam');
  f.files.set(`${root}/steamharness.release.json`, JSON.stringify({kind:'steamharness.project.release',version:1,projectId:id,projectVersion:source.version,entries:[{entryId:'main'}]}));
  assert.equal((await detect()).distribution,'release');
  f.files.set(`${root}/steamharness.json`,JSON.stringify({...declaration('bot'),entries:[{entryId:'main',root:'older-entry'}],distribution:{kind:'release',version:1}}));
  const older = await detect(); assert.deepEqual([older.distribution,older.projectId,older.version,older.entries],['release',id,source.version,undefined]);
});

test('ordinary folders, broken and old declarations, invalid entries and unsupported schemes keep default icons', async t => {
  const f = fixture(t);
  f.files.set('file:///ordinary/steamharness.json', JSON.stringify({ name: 'Ordinary folder' }));
  f.files.set('file:///ordinary/index.ts', executor('workflow'));
  f.files.set('file:///broken/steamharness.json', '{');
  f.files.set('file:///text/steamharness.json', JSON.stringify({ id, name: 'Old declaration', version: "0.1.0",  projectType: 'bot'  }));
  f.files.set('file:///text/index.ts', '// steamharness.defineExecutor({ projectType: "bot" })\nconst text = "projectType: workflow";');
  const duplicate = declaration('workflow'); duplicate.entries.push({ ...duplicate.entries[0], type: 'bot' });
  f.files.set('file:///conflict/steamharness.json', JSON.stringify(duplicate));
  f.files.set('file:///conflict/a.ts', executor('workflow'));
  f.files.set('file:///conflict/b.ts', executor('bot'));
  const uris = ['file:///ordinary', 'file:///broken', 'file:///text', 'file:///conflict', 'file:///missing', 'file:///test.code-workspace', 'https://example.com', 'command:run'];
  assert.deepEqual(await f.types(...uris), Object.fromEntries(uris.map(uri => [uri, undefined])));
});

test('persist detected metadata, paint it synchronously on restart, and clear it after a confirmed removal', async t => {
  const uri='file:///bot', row={uri,kind:'folder',label:'Bot',lastOpened:1};
  const first=fixture(t), detection=new Promise(resolve=>first.icons.onDidChange(resolve));
  first.files.set(`${uri}/steamharness.json`,manifest('bot'));
  await first.icons.resolveMany([uri]);
  const saved=JSON.parse(JSON.stringify(applyRecentMetadata([row],await detection)));
  const reopened=rememberProjects(saved,[{...row,lastOpened:2}],12);
  const second=fixture(t,reopened), removed=new Promise(resolve=>second.icons.onDidChange(resolve));
  assert.equal(second.icons.get(uri),'bot'); assert.match(second.icons.getAvatarUrl(uri),/^data:image\/svg\+xml,/);
  await second.icons.resolveMany([uri]);
  const latest=applyRecentMetadata(reopened,await removed);
  assert.equal(latest[0].projectType,undefined); assert.equal(latest[0].avatarUrl,undefined); assert.equal(latest[0].lastOpened,2);
  assert.deepEqual(applyRecentMetadata([],new Map([[uri,saved[0]]])),[],'never resurrect removed history');
});

test('project avatars refresh when only projectCard colors change and ignore image URLs', async t => {
  const f = fixture(t), root = 'file:///board';
  const card = { icon: 'database', iconColor: '#112233', iconBackgroundColor: '#aabbcc', iconUrl: 'https://example.com/private.png' };
  const pkg = declaration('kanban'); pkg.projectCard = card;
  f.files.set(`${root}/steamharness.json`, JSON.stringify(pkg));
  const first = (await f.icons.resolveMany([root]))[0].avatarUrl;
  assert.match(decodeURIComponent(first), /stroke="#112233"/);
  assert.doesNotMatch(decodeURIComponent(first), /example.com/);
  pkg.projectCard.iconColor = '#334455';
  f.files.set(`${root}/steamharness.json`, JSON.stringify(pkg)); f.icons.refresh();
  const second = (await f.icons.resolveMany([root]))[0].avatarUrl;
  assert.notEqual(first, second);
  assert.match(decodeURIComponent(second), /stroke="#334455"/);
  assert.equal(f.icons.getAvatarUrl(root), second);
});

test('parallel requests share reads; refresh preserves the last icon on transient failure and clears removed declarations', async t => {
  const f = fixture(t), root = 'file:///project', pkg = `${root}/steamharness.json`;
  f.files.set(pkg, manifest('kanban'));
  await Promise.all([f.types(root), f.types(root)]);
  assert.equal(f.reads.length, 1);
  f.failures.set(pkg, new Error('Temporarily unavailable')); f.icons.refresh();
  assert.deepEqual(await f.types(root), { [root]: 'kanban' });
  f.failures.clear(); f.files.set(pkg, manifest('bot')); f.files.set(`${root}/index.ts`, executor('bot')); f.focus();
  assert.deepEqual(await f.types(root), { [root]: 'bot' });
  f.files.delete(pkg); f.change(pkg);
  assert.deepEqual(await f.types(root), { [root]: undefined });
});

test('stale manifest reads cannot replace newer entry declarations', async t => {
  const f = fixture(t), root = 'file:///project';
  f.files.set(`${root}/steamharness.json`, manifest('workflow'));
  let release, started;
  const ready = new Promise(resolve => { started = resolve; }), original = f.vscode.workspace.fs.readFile;
  f.vscode.workspace.fs.readFile = async target => {
    const previous = await original(target); started();
    return new Promise(resolve => { release = () => resolve(previous); });
  };
  const previous = f.types(root); await ready;
  f.vscode.workspace.fs.readFile = original;
  f.files.set(`${root}/steamharness.json`, manifest('bot')); f.icons.refresh();
  assert.deepEqual(await f.types(root), { [root]: 'bot' }); release(); await previous;
  assert.equal(f.icons.get(root), 'bot');
  assert.deepEqual(f.reads, [`${root}/steamharness.json`, `${root}/steamharness.json`]);
});
