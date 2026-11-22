import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-runtime-node.ts'],
  bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const first = { serverUrl: 'https://account.invalid', accessToken: 'first-test-token' };
const second = { serverUrl: 'https://other-account.invalid', accessToken: 'second-test-token' };
const entries = ['main', 'chat'].map(entryId => ({ entryId, name: entryId, type: 'bot', root: '.', entry: 'index.ts' }));

async function until(read, accept) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    assert.ok(Date.now() < deadline, 'The current account must reach CLI Web');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(t, { restricted, platform = true, connection = first, restore, hosted = false, trusted = true, embedded = true } = {}) {
  const projectEntries = hosted ? [...entries,
    { entryId: 'app', name: 'Hosted app', type: 'kanban', root: '.', entry: 'index.html', webApp: { service: 'sample.app' } },
  ] : entries;
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-configuration-account-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = path.join(directory, 'node_modules/@steamharness/cli');
  await mkdir(cli, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), '{}');
  await writeFile(path.join(cli, 'package.json'), JSON.stringify({ name: '@steamharness/cli', version: '1.0.0', bin: { steamharness: 'cli.cjs' } }));
  await writeFile(path.join(cli, 'cli.cjs'), `
    const messages=[], args=process.argv.slice(2), input=require('readline').createInterface({input:process.stdin});
    const server=require('http').createServer((request,response)=>{
      response.end(JSON.stringify({pid:process.pid,messages}));
      if(request.url==='/crash')setImmediate(()=>process.exit(23));
    });
    input.on('line',line=>{const message=JSON.parse(line);messages.push(message);
      if(message.type==='close'){server.close();input.close();process.stdin.pause();}
      if(message.type==='configure')server.listen(Number(args[args.indexOf('--port')+1]||0),'127.0.0.1',()=>console.log(JSON.stringify({
        type:'ready',protocolVersion:1,hostProtocolVersion:1,accountProtocolVersion:1,entriesProtocolVersion:1,userSettingsProtocolVersion:1,
        restrictedConfigurationEntries:${JSON.stringify(restricted) ?? 'undefined'},
        url:'http://127.0.0.1:'+server.address().port+'/entries/main/#session='+'a'.repeat(64),
        project:{id:'configuration-project',name:'Configurations',entries:${JSON.stringify(projectEntries)},defaultEntry:'main'}
      })));
    });
  `);
  const listeners = new Set(), errors = [], commands = [];
  let connects = 0;
  const change = (value, status = value ? 'authenticated' : 'signed-out') => {
    connection = value;
    for (const callback of listeners) callback({ status });
  };
  const account = {
    platform, getConnection: () => connection, getAiConnection: () => undefined,
    onDidChange: callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
    connect: async () => { connects++; if (restore) change(await restore()); return connection; },
  };
  const vscode = { env: { language: 'en' }, ColorThemeKind: { Light: 1, HighContrastLight: 4 },
    workspace: { isTrusted: trusted, onDidChangeConfiguration: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: () => '', inspect: () => ({ defaultValue: 'auto' }) }) },
    window: { activeColorTheme: { kind: 1 }, showErrorMessage: async message => { errors.push(message); } },
    commands: { executeCommand: async command => { commands.push(command); } },
  };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports,
    require: name => name === 'vscode' ? vscode : require(name), process, structuredClone, AbortController, AbortSignal, URL, setTimeout, clearTimeout, queueMicrotask });
  const runtime = module.exports.createProjectRuntime({ extensionUri: { fsPath: directory }, globalStorageUri: { fsPath: path.join(directory, 'storage') } }, account);
  t.after(() => runtime.dispose());
  const start = async (embed = embedded) => {
    const session = await runtime.start({ id: 'configuration-project', folderPath: directory, uri: '', projectType: 'bot', entryId: 'main', entries: projectEntries }, 'editor', undefined, embed ? { embedded: true } : undefined);
    t.after(() => session.close());
    const read = () => fetch(session.ready.url).then(response => response.json());
    const auth = () => read().then(value => value.messages.filter(message => message.type === 'auth'));
    return { session, read, auth };
  };
  if (!trusted) {
    await assert.rejects(start(), /Trust the current workspace/);
    return { get connects() { return connects; } };
  }
  return { ...await start(), start, commands, errors, change, get connects() { return connects; } };
}

test('a restricted sibling entry receives the signed-in project account without interactive login', async t => {
  const f = await fixture(t, { restricted: ['chat'], hosted: true });
  assert.deepEqual((await until(f.auth, items => items.length === 1))[0].connection, first);
  assert.equal(f.connects, 0); assert.deepEqual(f.commands, []);
});

test('an enhanced CLI Web session inherits the verified account without a restricted configuration', async t => {
  const f = await fixture(t);
  const updates = await until(f.auth, items => items.length === 1);
  assert.deepEqual(updates[0].connection, first);
  assert.equal(updates[0].systemAiConnection, undefined);
  assert.equal((await f.read()).messages[0].connection, null, 'The initial process still starts locally');
  assert.equal(f.connects, 0); assert.deepEqual(f.commands, []); assert.deepEqual(f.errors, []);
});

test('CLI Web follows logout and switches Server accounts without restarting', async t => {
  const f = await fixture(t);
  const initial = await until(f.read, value => value.messages.some(message => message.type === 'auth'));
  f.change(undefined, 'checking');
  assert.equal((await f.auth()).length, 1);
  f.change(first);
  assert.equal((await f.auth()).length, 1);
  f.change(undefined);
  await until(f.auth, items => items.at(-1)?.connection === null);
  f.change(second);
  const replacement = await until(f.auth, items => items.at(-1)?.connection?.accessToken === second.accessToken);
  assert.deepEqual(replacement.at(-1).connection, second);
  f.change(first);
  await until(f.auth, items => items.at(-1)?.connection?.accessToken === first.accessToken);
  assert.equal((await f.read()).pid, initial.pid);
  assert.equal(f.connects, 0); assert.deepEqual(f.commands, []);
});

test('a signed-out CLI Web session stays a guest and receives a later verified login', async t => {
  const f = await fixture(t, { connection: null });
  assert.deepEqual(await f.auth(), []);
  assert.equal(f.connects, 1); assert.deepEqual(f.commands, []);
  f.change(first);
  await until(f.auth, items => items.at(-1)?.connection?.accessToken === first.accessToken);
});

test('restoring a saved Studio account does not block opening the CLI Web session', async t => {
  let restored;
  const pending = new Promise(resolve => { restored = resolve; });
  const f = await fixture(t, { connection: null, restore: () => pending });
  assert.deepEqual(await f.auth(), []);
  restored(first);
  assert.deepEqual((await until(f.auth, items => items.length === 1))[0].connection, first);
  assert.equal(f.connects, 1); assert.deepEqual(f.commands, []);
});

for (const options of [{ platform: false }, { hosted: true }, { hosted: true, restricted: ['missing-entry'] }]) {
  test(`offline or hosted-app runtimes do not inherit the Studio account: ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, options);
    f.change(second);
    assert.deepEqual(await f.auth(), []);
    assert.equal(f.connects, 0); assert.deepEqual(f.commands, []);
  });
}

test('an untrusted workspace cannot start a CLI Web session or restore an account', async t => {
  const f = await fixture(t, { trusted: false, connection: null });
  assert.equal(f.connects, 0);
});

test('a headless runtime cannot inherit the account through an embedded lease of the same project', async t => {
  const f = await fixture(t, { embedded: false });
  const embedded = await f.start(true);
  await until(embedded.auth, items => items.length === 1);
  assert.notEqual((await embedded.read()).pid, (await f.read()).pid);
  f.change(second);
  await until(embedded.auth, items => items.at(-1)?.connection?.accessToken === second.accessToken);
  assert.deepEqual(await f.auth(), []);
  assert.equal(f.connects, 0);
});

test('recovering the aggregate uses the current account', async t => {
  const f = await fixture(t);
  const initial = await until(f.read, value => value.messages.some(message => message.type === 'auth'));
  const exited = new Promise(resolve => f.session.onExit(resolve));
  await fetch(new URL('/crash', f.session.ready.url)); await exited;
  f.change(second);
  assert.equal(await f.session.reconnect(), true);
  const restored = await until(f.read, value => value.messages.some(message => message.type === 'auth'));
  assert.notEqual(restored.pid, initial.pid);
  assert.deepEqual(restored.messages.filter(message => message.type === 'auth').at(-1).connection, second);
  assert.equal(f.connects, 0);
});
