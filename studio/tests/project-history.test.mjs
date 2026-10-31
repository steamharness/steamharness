import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/project-history.ts'], bundle: true,
  platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const id = '294b1eec-23fa-42cf-9fd3-2417f71c0570';
const imported = uri => ({ id, uri, name: uri });
const recent = uri => ({ uri, label: uri, kind: 'folder', lastOpened: 1 });
function fixture() {
  const storage = new Map(), errors = new Map(), writes = [];
  const f = { storage, errors, writes };
  const vscode = { Uri: { parse: value => ({ scheme: new URL(value).protocol.slice(0, -1), toString: () => value }) },
    workspace: { workspaceFolders: [], fs: { stat: async resource => {
      await f.stat?.(resource.toString());
      const code = errors.get(resource.toString());
      if (code) { throw { code }; }
    } } } };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, URL, require: () => vscode });
  const context = { globalState: { get: key => storage.get(key), update: async (key, value) => {
    writes.push(key); await f.write?.(key); storage.set(key, JSON.parse(JSON.stringify(value)));
  } } };
  return Object.assign(f, { vscode, context, ...module.exports });
}

test('deleted local history is removed from recent and imported records while current, remote and unreadable locations remain', async () => {
  const f = fixture();
  const uris = ['file:///deleted', 'file:///catalog-only', 'file:///current', 'file:///denied', 'vscode-remote://ssh-remote+host/missing', 'file:///available'];
  f.storage.set('studio.recentProjects', uris.filter(uri => !uri.includes('catalog-only')).map(recent));
  f.storage.set('studio.importedProjects', uris.map(imported));
  f.errors.set(uris[0], 'FileNotFound'); f.errors.set(uris[1], 'ENOENT');
  f.errors.set(uris[2], 'FileNotFound'); f.errors.set(uris[3], 'NoPermissions');
  f.vscode.workspace.workspaceFolders = [{ uri: { toString: () => uris[2] } }];
  await f.pruneMissingProjectHistory(f.context);
  const retained = uris.slice(2);
  assert.deepEqual({ recent: f.storage.get('studio.recentProjects').map(project => project.uri),
    imported: f.storage.get('studio.importedProjects').map(project => project.uri) }, { recent: retained, imported: retained });
  f.writes.length = 0;
  assert.equal(await f.pruneMissingProjectHistory(f.context), false);
  assert.deepEqual(f.writes, []);
});

test('a delayed filesystem check does not overwrite concurrent imports or reopened history', async () => {
  const f = fixture(), uri = 'file:///old';
  f.storage.set('studio.recentProjects', [recent(uri)]);
  f.storage.set('studio.importedProjects', [imported(uri)]);
  f.errors.set(uri, 'FileNotFound');
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.stat = () => new Promise(resolve => { started(); release = resolve; });
  const pruning = f.pruneMissingProjectHistory(f.context); await ready;
  const reopened = { ...recent(uri), lastOpened: 2 }, added = imported('file:///new');
  await f.updateProjectHistory(f.context, history => ({ recent: [reopened], imported: [...history.imported, added] }));
  release(); await pruning;
  assert.deepEqual({ recent: f.storage.get('studio.recentProjects'), imported: f.storage.get('studio.importedProjects') },
    { recent: [reopened], imported: [imported(uri), added] });
});

test('history updates serialize and a failed save does not block later updates', async () => {
  const f = fixture(); let release;
  const blocked = new Promise(resolve => { release = resolve; });
  f.write = async () => { await blocked; f.write = undefined; };
  const first = f.updateProjectHistory(f.context, history => ({ ...history, imported: [imported('file:///first')] }));
  const second = f.updateProjectHistory(f.context, history => ({ ...history, imported: [...history.imported, imported('file:///second')] }));
  release(); await Promise.all([first, second]);
  f.write = () => { throw new Error('storage unavailable'); };
  await assert.rejects(f.updateProjectHistory(f.context, history => ({ ...history, recent: [recent('file:///failed')] })), /storage unavailable/);
  f.write = undefined;
  await f.updateProjectHistory(f.context, history => ({ ...history, recent: [recent('file:///saved')] }));
  assert.deepEqual({ recent: f.storage.get('studio.recentProjects'), imported: f.storage.get('studio.importedProjects') },
    { recent: [recent('file:///saved')], imported: [imported('file:///first'), imported('file:///second')] });
});
