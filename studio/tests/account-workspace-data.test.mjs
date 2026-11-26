import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const [{ text: source }] = (await build({ entryPoints: ['extensions/studio-workstation/src/account-workspace-data-node.ts'],
  platform: 'node', format: 'cjs', bundle: true, write: false })).outputFiles;
const module = { exports: {} };
runInNewContext(source, { module, exports: module.exports, require: createRequire(import.meta.url), process, URL });
const { NodeAccountWorkspace } = module.exports;
const first = 'a'.repeat(64), second = 'b'.repeat(64);
const notice = { id: '1720100000000-10000000-1000-4000-8000-100000000000', title: 'Project finished', source: 'studio', read: false };
const normalize = value => JSON.parse(JSON.stringify(value));

async function rootFor(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-account-workspace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'accounts');
}

test('independent extension hosts write the same account history without losing entries', async t => {
  const root = await rootFor(t);
  const runner = path.join(path.dirname(root), 'writer.cjs');
  await writeFile(runner, `${source}
const [owner, root, label] = process.argv.slice(2);
const store = new module.exports.NodeAccountWorkspace(owner, root);
for (let i = 0; i < 10; i++) {
  const name = label + i;
  store.updateHistory(history => ({ ...history, recent: [{ uri: 'file:///' + name, label: name, kind: 'folder', lastOpened: Date.now() }, ...history.recent] }));
}`);
  const write = promisify(execFile);
  await Promise.all(['Desktop', 'Web'].map(label => write(process.execPath, [runner, first, root, label])));
  const own = new NodeAccountWorkspace(first, root), other = new NodeAccountWorkspace(second, root);
  assert.equal(own.readHistory().recent.length, 20);
  assert.deepEqual(normalize(other.readHistory()), { recent: [], imported: [] });
  assert.notEqual(own.runs, other.runs);
  assert.notEqual(own.schedules, other.schedules);
  assert.throws(() => new NodeAccountWorkspace('../invalid', root), /Invalid Studio workspace owner/);
});

test('read state and dismissal are shared; importing legacy notifications cannot resurrect cleared entries', async t => {
  const root = await rootFor(t);
  const desktop = new NodeAccountWorkspace(first, root), web = new NodeAccountWorkspace(first, root), other = new NodeAccountWorkspace(second, root);
  desktop.inbox({ kind: 'add', notice });
  web.inbox({ kind: 'read', ids: [notice.id] });
  desktop.inbox({ kind: 'import', notices: [notice], dismissed: ['social-previous'] });
  assert.deepEqual(normalize(web.inbox({ kind: 'list' })), { notices: [{ ...notice, read: true }], dismissed: ['social-previous'] });
  web.inbox({ kind: 'clear', ids: [notice.id] });
  desktop.inbox({ kind: 'import', notices: [notice] });
  assert.deepEqual(normalize(web.inbox({ kind: 'list' })), { notices: [], dismissed: ['social-previous'] });
  const next = { ...notice, id: '1720200000000-20000000-2000-4000-8000-200000000000' };
  desktop.inbox({ kind: 'add', notice: next });
  web.inbox({ kind: 'read-all' });
  assert.deepEqual(normalize(desktop.inbox({ kind: 'list' })).notices, [{ ...next, read: true, source: 'studio' }]);
  assert.deepEqual(normalize(other.inbox({ kind: 'list' })), { notices: [], dismissed: [] });
});
