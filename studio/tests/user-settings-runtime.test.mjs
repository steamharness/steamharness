import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-runtime-node.ts'],
  bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const require = createRequire(import.meta.url);
async function until(read, accept) {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    assert.ok(Date.now() < deadline, 'The host update must arrive');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('startup resends the latest user snapshot and live updates debounce, ignore workspace scope and reset', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-settings-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = path.join(directory, 'node_modules/@steamharness/cli');
  await mkdir(path.join(cli, 'dist'), { recursive: true });
  await writeFile(path.join(cli, 'package.json'), JSON.stringify({ name: '@steamharness/cli', version: '1.0.0', type: 'module', bin: { steamharness: 'dist/index.js' } }));
  await writeFile(path.join(cli, 'dist/index.js'), `
    import { existsSync, writeFileSync } from 'node:fs';
    import { createServer } from 'node:http';
    import { createInterface } from 'node:readline';
    const messages = [], input = createInterface({ input: process.stdin });
    const server = createServer((_request, response) => response.end(JSON.stringify(messages)));
    let timer;
    input.on('line', line => {
      const message = JSON.parse(line); messages.push(message);
      if (message.type === 'configure') {
        writeFileSync('configured.json', JSON.stringify(message));
        timer = setInterval(() => {
          if (!existsSync('release')) return;
          clearInterval(timer);
          server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ type: 'ready', protocolVersion: 1,
            hostProtocolVersion: 1, accountProtocolVersion: 1, entriesProtocolVersion:1,databaseSpacesProtocolVersion:1, userSettingsProtocolVersion: 1,
            url: 'http://127.0.0.1:' + server.address().port + '/entries/main/#session=' + 'a'.repeat(64),
            project: { id: 'settings-project', name: 'Settings', projectType: 'conversation',entryId:'main',defaultEntry:'main',entries:[{entryId:'main',name:'Main',type:'conversation',root:'.',entry:'index.ts',databases:[]}],databases:[] } })));
        }, 10);
      }
    });
    input.on('close', () => { writeFileSync('closed', 'yes'); clearInterval(timer); process.stdin.pause(); server.close(); });
  `);
  let globalValue = 'auto', workspaceValue = 'read-only', listener;
  const errors = [];
  const vscode = { env: { language: 'en' }, ColorThemeKind: { Light: 1, HighContrastLight: 4 },
    workspace: { isTrusted: true,
      onDidChangeConfiguration: callback => { listener = callback; return { dispose() { listener = undefined; } }; },
      getConfiguration: () => ({ get: () => '', inspect: () => ({ defaultValue: 'auto', globalValue, workspaceValue }) }),
    }, window: { activeColorTheme: { kind: 1 }, showErrorMessage: message => errors.push(message) } };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name),
    process, structuredClone, AbortController, AbortSignal, URL, setTimeout, clearTimeout, queueMicrotask });
  const runtime = module.exports.createProjectRuntime({ extensionUri: { fsPath: directory }, globalStorageUri: { fsPath: path.join(directory, 'storage') } },
    { getConnection: () => undefined, onDidChange: () => ({ dispose() {} }) });
  t.after(() => runtime.dispose());
  const starting = runtime.start({ id: 'settings-project', folderPath: directory, uri: '', projectType: 'conversation',entryId:'main',defaultEntry:'main',entries:[{entryId:'main',name:'Main',type:'conversation',root:'.',entry:'index.ts',databases:[]}],databases:[] }, 'editor');
  const initial = await until(() => readFile(path.join(directory, 'configured.json'), 'utf8').then(JSON.parse).catch(() => undefined), Boolean);
  assert.equal(initial.userSettings.agent.permissionPolicy, 'auto');
  const changed = () => listener({ affectsConfiguration: key => key === 'studio.agent.permissionPolicy' });
  globalValue = 'workspace'; changed(); globalValue = 'read-only'; changed();
  await new Promise(resolve => setTimeout(resolve, 70));
  await writeFile(path.join(directory, 'release'), 'ready');
  const session = await starting; t.after(() => session.close());
  const messages = () => fetch(session.ready.url).then(response => response.json());
  const updates = () => messages().then(items => items.filter(item => item.type === 'user-settings'));
  let sent = await until(updates, items => items.length === 1);
  assert.equal(sent[0].userSettings.agent.permissionPolicy, 'read-only');
  globalValue = 'workspace'; changed(); changed(); changed();
  sent = await until(updates, items => items.length === 2);
  assert.equal(sent[1].userSettings.agent.permissionPolicy, 'workspace');
  workspaceValue = 'auto'; changed();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal((await updates()).length, 2, 'Workspace-only changes cannot override the user snapshot');
  globalValue = undefined; changed();
  sent = await until(updates, items => items.length === 3);
  assert.equal(sent[2].userSettings.agent.permissionPolicy, 'auto');
  globalValue = 'invalid'; changed();
  await until(async () => errors, values => values.length === 1);
  assert.equal((await updates()).length, 3, 'Invalid settings never reach an open project');
  await session.close(); runtime.dispose(); assert.equal(listener, undefined);
  await Promise.all(['release', 'configured.json', 'closed'].map(name => rm(path.join(directory, name), { force: true })));
  globalValue = 'auto';
  const nextRuntime = module.exports.createProjectRuntime({ extensionUri: { fsPath: directory }, globalStorageUri: { fsPath: path.join(directory, 'storage') } },
    { getConnection: () => undefined, onDidChange: () => ({ dispose() {} }) });
  t.after(() => nextRuntime.dispose());
  const invalidStartup = nextRuntime.start({ id: 'settings-project', folderPath: directory, uri: '', projectType: 'conversation',entryId:'main',defaultEntry:'main',entries:[{entryId:'main',name:'Main',type:'conversation',root:'.',entry:'index.ts',databases:[]}],databases:[] }, 'editor');
  const rejected = assert.rejects(invalidStartup, /Choose a valid user permission policy/);
  await until(() => readFile(path.join(directory, 'configured.json'), 'utf8').catch(() => undefined), Boolean);
  globalValue = 'invalid'; await writeFile(path.join(directory, 'release'), 'ready');
  await rejected;
  assert.equal(await readFile(path.join(directory, 'closed'), 'utf8'), 'yes', 'Invalid startup updates close the newly spawned CLI');
});
