import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStudioNode as build } from '../scripts/node-extension-build.mjs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { createProjectRuntime } from './extensions/studio-workstation/src/workflow-runtime-node.ts';
  export { registerWebAppProvider } from './extensions/studio-workstation/src/web-app-providers.ts';
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const projectId = '00000000-0000-4000-8000-000000000001';
const entries = [
  { entryId: 'main', name: 'IM', type: 'kanban', root: '.', entry: 'dist/steamharness/build/main/index.html', webApp: { service: 'sample.app' } },
  { entryId: 'task', name: 'Task', type: 'workflow', root: '.', entry: 'index.ts' },
];
const first = { serverUrl: 'https://account.invalid', accessToken: 'first-host-secret' };
const second = { serverUrl: 'https://account.invalid', accessToken: 'second-host-secret' };
async function until(read, accept = Boolean) {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    assert.ok(Date.now() < deadline, 'The hosted application must receive the account transition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(t, connection = first, beforeOpen = async () => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-web-app-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = path.join(directory, 'node_modules/@steamharness/cli'); await mkdir(cli, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), '{}');
  await writeFile(path.join(cli, 'package.json'), JSON.stringify({ name: '@steamharness/cli', version: '1.0.0', bin: { steamharness: 'cli.cjs' } }));
  await writeFile(path.join(cli, 'cli.cjs'), `
    const messages=[], args=process.argv.slice(2), input=require('readline').createInterface({input:process.stdin});
    const server=require('http').createServer((request,response)=>{
      response.setHeader('Content-Type','application/json');
      response.end(JSON.stringify({pid:process.pid,messages}));
      if(request.url==='/crash')setImmediate(()=>process.exit(23));
    });
    input.on('line',line=>{const message=JSON.parse(line);messages.push(message);
      if(message.type==='close'){server.close();input.close();process.stdin.pause();}
      if(message.type==='configure')server.listen(Number(args[args.indexOf('--port')+1]||0),'127.0.0.1',()=>console.log(JSON.stringify({
        type:'ready',protocolVersion:1,hostProtocolVersion:1,accountProtocolVersion:1,entriesProtocolVersion:1,webAppProtocolVersion:1,webAppLoginProtocolVersion:1,
        url:'http://127.0.0.1:'+server.address().port+'/entries/'+args[args.indexOf('--entry')+1]+'/#session='+'a'.repeat(64),
        project:{id:${JSON.stringify(projectId)},entries:${JSON.stringify(entries)},defaultEntry:'main'}
      })));
    });
  `);
  const listeners = new Set(), errors = [], commands = [], opened = [], disposed = [];
  const account = {
    platform: true,
    getConnection: () => connection,
    getState: () => ({ serverUrl: connection?.serverUrl ?? first.serverUrl }),
    getAiConnection: () => undefined,
    onDidChange: callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
    async connect() {
      for (const callback of listeners) callback({ status: 'checking' });
      await Promise.resolve();
      for (const callback of listeners) callback({ status: connection ? 'authenticated' : 'signed-out' });
      return connection;
    },
  };
  const vscode = { env: { language: 'en' }, ColorThemeKind: { Light: 1, HighContrastLight: 4 },
    workspace: { isTrusted: true, onDidChangeConfiguration: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: () => '', inspect: () => ({ defaultValue: 'auto' }) }) },
    window: { activeColorTheme: { kind: 1 }, showErrorMessage: async message => { errors.push(message); } },
    commands: { executeCommand: async command => { commands.push(command); } },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports,
    require: name => name === 'vscode' ? vscode : require(name), process, structuredClone, AbortController, AbortSignal, URL, setTimeout, clearTimeout, queueMicrotask });
  const registration = module.exports.registerWebAppProvider({ matches: input => input.projectId === projectId,
    open: async input => {
      if (!input.connection || input.interactive === false) return { binding: { service: 'sample.app', apiBaseUrl: 'https://im.invalid/api', bootstrap: null, login: { kind: 'studio', serverUrl: input.serverUrl } }, dispose() {} };
      opened.push(input);
      const scope = `scope-${opened.length}`;
      await beforeOpen(input);
      return { binding: { service: 'sample.app', apiBaseUrl: 'https://im.invalid/api', bootstrap: { token: scope } }, dispose: () => disposed.push(scope) };
    } });
  t.after(() => registration.dispose());
  const runtime = module.exports.createProjectRuntime({ extensionUri: { fsPath: directory }, globalStorageUri: { fsPath: path.join(directory, 'storage') } }, account);
  t.after(() => runtime.dispose());
  const start = async (entryId = 'main') => {
    const session = await runtime.start({ id: projectId, folderPath: directory, uri: '', projectType: entryId === 'main' ? 'kanban' : 'workflow', entryId, entries }, 'editor', undefined, { embedded: true });
    t.after(() => session.close());
    return session;
  };
  return { start, opened, disposed, errors, commands, listeners,
    read: session => fetch(session.ready.url).then(response => response.json()),
    change(value, status = value ? 'authenticated' : 'signed-out') {
      connection = value; for (const callback of listeners) callback({ status });
    },
  };
}
const binding = value => value.messages.filter(message => message.type === 'web-apps').at(-1)?.webApps.main;

test('opening a hosted entry prepares a manual account action, while other aggregate entries stay offline', async t => {
  const f = await fixture(t);
  const task = await f.start('task');
  assert.equal(f.opened.length, 0);
  const im = await f.start();
  await until(() => f.read(im), value => binding(value)?.login);
  assert.equal(f.opened.length, 0, 'Opening a tab must not authorize');
  await im.connectPlatform('web-app', 'main');
  const connected = await until(() => f.read(im), value => binding(value)?.bootstrap?.token);
  assert.equal(connected.pid, (await f.read(task)).pid, 'The IM tab can join an already running aggregate host');
  assert.equal(f.opened.length, 1, 'Account verification must not authorize the same entry twice');
  assert.equal(f.opened[0].connection.accessToken, first.accessToken);
  assert.ok(!JSON.stringify(connected.messages).includes('host-secret'));
  f.change(first, 'checking');
  f.change(first);
  assert.equal(f.opened.length, 1, 'Refreshing account details keeps the existing scoped session');
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.errors, []);
});

test('logout revokes the scoped session and signing in again reconnects the open IM tab', async t => {
  const f = await fixture(t), session = await f.start();
  await session.connectPlatform('web-app', 'main');
  await until(() => f.read(session), value => binding(value)?.bootstrap?.token);
  f.change(undefined);
  await until(() => f.read(session), value => binding(value)?.login);
  assert.deepEqual(f.disposed, ['scope-1']);
  f.change(second);
  await session.connectPlatform('web-app', 'main');
  await until(() => f.read(session), value => binding(value)?.bootstrap.token === 'scope-2');
  assert.equal(f.opened[1].connection.accessToken, second.accessToken);
  f.change(first);
  await session.connectPlatform('web-app', 'main');
  await until(() => f.read(session), value => binding(value)?.bootstrap.token === 'scope-3');
  assert.deepEqual(f.disposed, ['scope-1', 'scope-2']);
  await session.close();
  assert.equal(f.listeners.size, 0);
});

test('opening IM before sign-in resumes authorization after login without reopening the tab', async t => {
  const f = await fixture(t, null), session = await f.start();
  await until(() => f.read(session), value => binding(value)?.login?.kind === 'studio');
  assert.deepEqual(f.commands, [], 'Opening a tab must not navigate to sign-in');
  await session.connectPlatform('web-app', 'main');
  assert.deepEqual(f.commands, ['studio.openLogin']);
  assert.equal(f.opened.length, 0);
  f.change(first);
  await session.connectPlatform('web-app', 'main');
  await until(() => f.read(session), value => binding(value)?.bootstrap?.token);
  assert.equal(f.opened.length, 1);
});

test('recovering a crashed host reacquires a fresh IM session for the selected entry', async t => {
  const f = await fixture(t), session = await f.start();
  await session.connectPlatform('web-app', 'main');
  const original = await until(() => f.read(session), value => binding(value)?.bootstrap?.token);
  const exited = new Promise(resolve => session.onExit(resolve));
  await fetch(new URL('/crash', session.ready.url)); await exited;
  assert.equal(await session.reconnect(), true);
  await until(() => f.read(session), value => binding(value)?.login);
  await session.connectPlatform('web-app', 'main');
  const recovered = await until(() => f.read(session), value => binding(value)?.bootstrap?.token);
  assert.notEqual(recovered.pid, original.pid);
  assert.equal(binding(recovered).bootstrap.token, 'scope-2');
  assert.deepEqual(f.disposed, ['scope-1']);
});

test('signing out during authorization discards the late session and resumes with the new account', async t => {
  let release;
  const f = await fixture(t, first, () => release ? Promise.resolve() : new Promise(resolve => { release = resolve; }));
  const session = await f.start();
  const signingIn = session.connectPlatform('web-app', 'main');
  await until(() => f.opened.length);
  f.change(undefined);
  assert.equal(f.opened[0].signal.aborted, true);
  release();
  await signingIn;
  await until(() => f.disposed.length);
  assert.equal(binding(await f.read(session))?.bootstrap ?? null, null);
  f.change(second);
  await session.connectPlatform('web-app', 'main');
  await until(() => f.read(session), value => binding(value)?.bootstrap.token === 'scope-2');
  assert.equal(f.opened[1].connection.accessToken, second.accessToken);
});

test('a failed authorization can be retried with the same Studio account', async t => {
  let attempts = 0;
  const f = await fixture(t, first, async () => { if (++attempts === 1) throw Error('private-provider-detail'); });
  const session = await f.start();
  await session.connectPlatform('web-app', 'main');
  await until(() => f.errors.length);
  assert.equal(binding(await f.read(session))?.bootstrap ?? null, null);
  assert.ok(!f.errors[0].includes('private-provider-detail'));
  await session.connectPlatform('web-app', 'main');
  await until(() => f.read(session), value => binding(value)?.bootstrap.token === 'scope-2');
  assert.equal(attempts, 2);
});
